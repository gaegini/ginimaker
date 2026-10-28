/* Tesana play-time SDK v1.2.0 */
(function (root) {
/**
 * Tesana play-time SDK. Vanilla JS, no npm in games.
 * Host injects window.__TESANA__ or postMessage { type: "tesana-bootstrap", ... }.
 * v1 is player identity, per-game saves, optional open-lobby multiplayer,
 * cloud saves, the in-game coin economy, and gameplay analytics.
 *
 * THIS FILE IS THE ONE COPY. It is the source of truth for `window.Tesana`:
 * the engine injects the built artifact into every game and the CDN serves it
 * at /sdk/<major>/tesana-play.js, so a fix here reaches the fleet. The engine
 * repo carries no implementation — only the skills that tell a generator how
 * to call this. Do not re-implement it there.
 *
 * One service owns identity, saves, rooms, coins, prices and entitlements —
 * the play service — and it is reached over `saveEndpoint` + `saveToken`
 * (Bearer). `shop.*` and `economy.*` therefore read the same DynamoDB table
 * that holds the wallet; nothing here asks the site what a price is.
 *
 * Real money is the deliberate exception: `economy.topUp` hands the checkout
 * to the host page, so the confirmation UI — and the price it shows — belong
 * to the site rather than to a game the player can rewrite.
 */

/**
 * @typedef {object} TesanaConfig
 * @property {string} [endpoint]
 * @property {string} [gameId]
 * @property {string} [publicId]
 * @property {string} [playerToken]
 * @property {string} [rail]
 * @property {string} [deviceId]
 */

// The compatibility major a build pins to (`/sdk/v1/...`) is derived from this
// number, and the engine reads it to stamp each game, so this is the SDK's
// public version — bump the minor for fixes, the major for breaking changes.
//
// 1.0.0 ships six services together: saves, shop, leaderboards, achievements,
// a vanity address (`tesana.vanity`) and in-game ads (`tesana.ads`). These are
// the first release, so there is no earlier number to stay compatible with.
//
// 1.1.0 adds gameplay analytics, `tesana.track` and `tesana.gameplay.*`. The
// engine's analytics skill already taught them, so a game following it threw a
// TypeError on its first death; this is the release that makes those calls real.
//
// 1.2.0 adds three services for the creator's side of a game: `tesana.feedback`
// (player reports, plus crashes filed on their own), `tesana.config` (values the
// creator changes without a rebuild) and `tesana.share` (invite links into a
// room or a level).
const VERSION = "1.2.0";

const LOCAL_CACHE = "tesana.play.v1";

/**
 * Reconnect policy for a dropped multiplayer socket.
 *
 * A scale-in, a deploy or a flaky network can close the socket of a player
 * who did nothing wrong, and without a retry they sat alone in a match that
 * looked fine. Backoff is capped and jittered because those events drop
 * everyone at once: un-jittered retries would arrive as a synchronized spike
 * exactly when the fleet is least able to take one.
 */
const MP_RECONNECT_BASE_MS = 1000;
const MP_RECONNECT_MAX_MS = 30000;
const MP_RECONNECT_MAX_ATTEMPTS = 8;
//: How long to wait for the host to answer a bootstrap request before giving
//: up on that attempt. The answer is a token mint; a host that is slow must not
//: hold a request open indefinitely.
const MP_HOST_ASK_TIMEOUT_MS = 5000;
//: How long `create`/`quickJoin` will wait for a room that is being placed.
//:
//: Room creation on GameLift is asynchronous, so the service answers 202 with
//: no `wsUrl` and a `retryAfterMs` instead of holding the request open. The
//: client polls until the room is ready or this budget runs out. It is longer
//: than the service's own placement poll (90s) only in the sense that it gives
//: up first: a client should decide for itself how long it will wait, and a
//: game can watch `onStatus` rather than being blocked.
const MP_PLACING_TIMEOUT_MS = 45000;
//: Default gap between placement polls, used when the service does not say.
const MP_PLACING_RETRY_MS = 1500;

/**
 * A polite, dns-safe label: lowercase letters, digits and internal hyphens,
 * at least three characters and at most sixty-three. The same rule the server
 * enforces, repeated here so a game can pre-validate and give the player a
 * sentence instead of an error code.
 */
const VANITY_RE = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/;
const VANITY_MIN = 3;
const VANITY_MAX = 63;

/**
 * Labels that can never belong to a game, because they already mean
 * something on our own domains (`api.tesana.ai`, `play.tesana.ai`) or are
 * claimed by mail and operations. The server is the authority; this list
 * exists so the common case is refused before a round-trip.
 */
const VANITY_RESERVED = new Set([
  "www", "api", "app", "play", "admin", "cdn", "mail", "docs", "status",
  "support", "help", "blog", "staging", "static", "assets", "files", "media",
  "sdk", "ws", "auth", "account", "billing", "signup", "login", "dashboard",
  "m", "dev", "test", "prod", "preview", "store", "explore", "studio",
  "wallet", "checkout", "gateway", "edge", "origin", "email", "smtp",
  "postmaster", "abuse", "security", "system", "internal", "metrics", "logs",
]);

/** Fold a display name or typed phrase into a candidate label. */
function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
}

/** Why a label cannot be used, or `""` when it can. */
function vanityProblem(label) {
  if (!label) return "empty";
  if (label.length < VANITY_MIN || label.length > VANITY_MAX) return "invalid";
  if (!VANITY_RE.test(label)) return "invalid";
  if (VANITY_RESERVED.has(label)) return "reserved";
  return "";
}

function readCache() {
  try {
    return JSON.parse(localStorage.getItem(LOCAL_CACHE) || "{}");
  } catch {
    return {};
  }
}

function writeCache(patch) {
  try {
    localStorage.setItem(LOCAL_CACHE, JSON.stringify({ ...readCache(), ...patch }));
  } catch {
    /* ignore */
  }
}

// The host may answer more than once. A bootstrap that says `offline` is
// provisional — it means "nobody has answered yet", and the site posts one the
// moment the frame loads, before it has finished minting the play session.
// Treating the first answer as final locks a signed-in player into a game with
// no wallet, and the real bootstrap a moment later is dropped, so the only
// symptom is a balance frozen at zero. Keep listening and upgrade.
let bootstrap = null;
const bootstrapWaiters = [];
// Clients already built from a provisional answer, so a later real bootstrap
// can re-point them in place. A game holds a reference to its client, so it
// must not be rebuilt — only upgraded.
const upgradeHandlers = [];
// Whether a bootstrap the client asked for is in flight. It is what makes a
// late answer an update rather than an unsolicited message that re-points a
// live session.
let bootstrapRequestPending = false;
// The in-flight ask, so a burst of refused calls mints once rather than once
// per caller. The host does its own rate-limiting; this only removes the
// duplicate round-trips a simultaneous burst would otherwise make.
let bootstrapAskPromise = null;
//: Bumped every time a host answer replaces the live bootstrap. A caller that
//: asked for a fresh token can tell whether it actually arrived by watching
//: this, without having to hold a listener of its own.
let bootstrapGeneration = 0;

/**
 * Diagnostics that should say their piece once per session, not once per call.
 *
 * `_shopRead()` runs every time a game draws its shop, and a console repeating
 * the same line a hundred times is a console nobody reads. Cleared by `init()`,
 * so "once" means once per game session rather than once per page load.
 */
const warnedKeys = new Set();
function warnOnce(key, message) {
  if (warnedKeys.has(key)) return;
  warnedKeys.add(key);
  try {
    console.warn(message);
  } catch {
    /* no console */
  }
}

function isGuestBootstrap(data) {
  return Boolean(data && data.player && data.player.isGuest);
}

/** Fold a host's answer into the live config, upgrading a provisional one. */
function applyBootstrap(data, opts = {}) {
  const next = data && typeof data === "object" ? data : {};
  // Whether the client asked for this answer. A bootstrap it asked for is a
  // refresh — its token aged out and the host minted another — and may update a
  // live session. One it did not ask for may not, or anything able to post into
  // the frame could re-point a running game's credential and identity.
  const asked = opts.force || bootstrapRequestPending;
  bootstrapRequestPending = false;
  if (bootstrap) {
    // A real host has already answered — unless that answer was a guest and
    // this one is the account they just signed in to.
    if (!bootstrap.offline && !(isGuestBootstrap(bootstrap) && !next.offline && !isGuestBootstrap(next))) {
      if (asked) {
        // A forced update may refresh credentials (token, save token, room
        // token) but never the player's identity: the player is who the
        // signing-in page said they are, and a stale or mismatched answer must
        // not silently become them.
        if (bootstrap.player && next.player !== undefined) delete next.player;
      } else {
        return;
      }
    }
    // Still offline, unless it now carries a room token: a signed-out
    // visitor's multiplayer arrives after the site has already said "offline".
    if (next.offline && !(next.roomToken && !bootstrap.roomToken) && !asked) return;
  }
  bootstrap = next;
  bootstrapGeneration += 1;
  window.__TESANA__ = { ...(window.__TESANA__ || {}), ...next };
  const waiting = bootstrapWaiters.splice(0);
  for (const resolve of waiting) resolve(bootstrap);
  for (const upgrade of [...upgradeHandlers]) {
    try {
      upgrade();
    } catch {
      /* an upgrade must never break the boot that is already running */
    }
  }
  // The host's ad policy travels with the bootstrap, and the real answer can
  // arrive after the first message. Re-point the ad capability in place so a
  // game that drew its title screen from a provisional "offline" answer still
  // gets ads once the host has spoken.
  try {
    resyncAds(next);
  } catch {
    /* ads must never break boot */
  }
}

/** Called when a provisional bootstrap is replaced by a real one. */
function onBootstrapUpgrade(fn) {
  upgradeHandlers.push(fn);
}

/**
 * The live ads capability, kept module-scoped so a later bootstrap can
 * re-point it.
 *
 * The client object is held by the game, so an upgrade must not replace it —
 * only reconfigure it. `resyncAds` is what turns a provisional "offline"
 * answer into a real ad policy when the host's second message arrives.
 */
let adClient = null;

/**
 * The live localization capability, kept module-scoped for the same reason as
 * the ad client: the host can change the language at any moment, and the game
 * holds a reference to `tesana.l10n` that must not be replaced underneath it.
 * The listener calls `applyLocale`, which re-points this object in place.
 */
let l10nClient = null;

/**
 * The languages the platform can translate into, in display order.
 *
 * Mirrors the service's own list, which is the authority; this copy exists so a
 * language picker can be drawn before the service has answered — and so a page
 * with no host at all, where nothing will ever answer, still has an honest
 * list rather than an empty one.
 */
const L10N_TARGETS = ["en", "es", "fr", "de", "it", "pt-BR", "ru", "zh", "ja", "ko"];

/**
 * Fold whatever a host calls a language onto one of ours.
 *
 * `navigator.language` reports `en-US` and `pt-PT`; a site may store `pt` or
 * `zh`; a player may be handed `de-AT`. None of those are in the list above and
 * all of them mean a language we do translate into, so the base tag is what
 * gets matched and the region is dropped — a game in `pt-BR` is more useful to
 * a `pt-PT` player than one left in English. An unknown tag stays as it is and
 * simply falls back to the source language at the call site.
 */
function normalizeLocale(tag) {
  const value = String(tag || "").trim().replace(/_/g, "-");
  if (!value) return "";
  const exact = L10N_TARGETS.find((t) => t.toLowerCase() === value.toLowerCase());
  if (exact) return exact;
  const base = value.split("-")[0].toLowerCase();
  return L10N_TARGETS.find((t) => t.split("-")[0].toLowerCase() === base) || value;
}

/** `{name}` in `text`, filled from `values`. The one interpolation rule the SDK and the service share. */
function fillPlaceholders(text, values) {
  const source = String(text == null ? "" : text);
  if (!values || typeof values !== "object") return source;
  return source.replace(/\{(\w+)\}/g, (whole, key) =>
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : whole,
  );
}

/** Fold a locale message from the host into the live client, if it is listening. */
function resyncLocale(data) {
  if (!l10nClient) return;
  const payload = data && typeof data.payload === "object" ? data.payload : data;
  const next = payload && (payload.locale || payload.lang || payload.language);
  if (next) l10nClient.applyLocale(next);
}

/** A policy message from the host, or `null` when none is in force. */
function adPolicyFrom(data) {
  if (!data || typeof data !== "object") return null;
  const payload = data.payload && typeof data.payload === "object" ? data.payload : data;
  const enabled = Boolean(payload.enabled);
  const formats = Array.isArray(payload.formats)
    ? payload.formats.filter((f) => typeof f === "string")
    : [];
  const minIntervalMs = Math.max(
    0,
    Number(payload.minIntervalMs ?? payload.min_interval_ms ?? 180000) || 0,
  );
  return { enabled, formats, minIntervalMs };
}

/**
 * Fold a host answer into the live ad client.
 *
 * Called once at construction (from the client) and again from
 * `applyBootstrap` whenever a newer answer lands, so the game's reference is
 * never rebuilt.
 */
function resyncAds(boot) {
  if (!adClient) return;
  const fromBootstrap =
    boot && typeof boot === "object" && "adsEnabled" in boot
      ? { enabled: Boolean(boot.adsEnabled), formats: boot.adFormats, minIntervalMs: boot.adMinIntervalMs }
      : null;
  // A host that named a policy on the last bootstrap outranks the earlier
  // one; absent means keep whatever we have.
  if (fromBootstrap) adClient.applyPolicy(fromBootstrap);
}

/** Ask the host for ads. `format` is our own vocabulary; the site maps it. */
function requestAdFromHost(requestId, format, context) {
  post({ type: "tesana-ad-request", requestId, format, context: context || null });
}

/**
 * Whether a host is above us that could run a checkout.
 *
 * A published game can be opened straight from the play CDN with no Tesana
 * page over it. There is no one to show a price or take a tap there, so the
 * SDK must not pretend otherwise — it says so instead of waiting out a
 * timeout for an answer that was never coming.
 */
function hasHost() {
  return (
    typeof window !== "undefined" &&
    window.parent &&
    window.parent !== window
  );
}

/**
 * Ask the host to run a purchase the game is not allowed to make itself.
 *
 * A game runs in a sandboxed cross-origin frame: the wrong place for a price
 * confirmation, and one Stripe will not load into. So the game states *what*
 * it wants to buy — never a price, which is the server's to decide — and the
 * host draws the confirmation, runs the purchase and answers.
 *
 * Resolves the same shape the direct call would have returned, so a game
 * cannot tell the difference. Rejects with `cancelled` when the player says
 * no, and `checkout_unavailable` when there is no host to ask.
 *
 * @param {"item" | "topup"} kind
 * @param {{ sku?: string, packId?: string }} what
 */
function requestCheckoutFromHost(kind, what) {
  if (!hasHost()) {
    const err = new Error(
      "This game is running outside a Tesana page, so there is no checkout to open.",
    );
    err.code = "checkout_unavailable";
    return Promise.reject(err);
  }
  const requestId = `co_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  post({
    type: "tesana-checkout-request",
    requestId,
    kind,
    sku: what?.sku || "",
    packId: what?.packId || "",
    gameId: gameConfig?.gameId || bootstrap?.gameId || "",
  });
  return new Promise((resolve, reject) => {
    let expiry = null;
    const finish = (fn, value) => {
      window.removeEventListener("message", onMessage);
      if (expiry) clearTimeout(expiry);
      fn(value);
    };
    function onMessage(event) {
      const msg = event.data;
      if (!msg || typeof msg !== "object") return;
      if (msg.type !== "tesana-checkout-result") return;
      if (msg.requestId !== requestId) return;
      if (msg.ok === true) return finish(resolve, msg.result || { ok: true });
      const err = new Error(msg.message || "The purchase was not completed.");
      err.code = msg.code || "cancelled";
      finish(reject, err);
    }
    window.addEventListener("message", onMessage);
    expiry = setTimeout(() => {
      const err = new Error("The checkout did not answer in time.");
      err.code = "timeout";
      finish(reject, err);
    }, CHECKOUT_TIMEOUT_MS);
  });
}

/** Tell the host how an ad went, so it can meter and report it. */
function reportAdToHost(result) {
  post({ type: "tesana-ad-result", ...result });
}

/**
 * Start this init() with no host answer inherited from a previous one.
 *
 * `bootstrap` and `upgradeHandlers` are module-scoped, and a page can call
 * init() more than once. Without this the second call reads the first one's
 * answer as if the host had already spoken — so a guest inherits a signed-in
 * player's save token, and an "offline" game inherits a wallet. The symptom is
 * the worst kind: the game looks configured, and the player's saves and coins
 * belong to whoever initialized before them.
 *
 * The message listener itself is registered once per page and is left alone.
 */
function resetHostChannel() {
  bootstrap = null;
  bootstrapWaiters.length = 0;
  upgradeHandlers.length = 0;
}

// The window the message listener is attached to. A real page has exactly one,
// so this is "attach once". A test harness swaps `window` between cases, and
// keying on identity is what stops the listener being stranded on a discarded
// page — where posts from the new host would never be seen.
let listeningWindow = null;

/** Ask, once per page, for the bootstrap and the wallet changes that follow it. */
function startListening() {
  if (typeof window === "undefined" || listeningWindow === window) return;
  listeningWindow = window;
  window.addEventListener("message", (event) => {
    const data = event.data;
    if (!data || typeof data !== "object") return;
    // The site posts `{ type, payload }`; a baked or spliced bootstrap is the
    // payload itself. Accept both, so one SDK reads either host.
    if (data.type === "tesana-bootstrap") {
      // `applyBootstrap` decides whether this answer may update a live session:
      // one the client asked for may, one it did not may not.
      applyBootstrap(data.payload && typeof data.payload === "object" ? data.payload : data);
      return;
    }
    if (data.type === "tesana-wallet-changed" && bootstrap) {
      // The player topped up in the parent window. Nothing to do but let the
      // next balance read be the truth.
      bootstrap.balance = typeof data.balance === "number" ? data.balance : bootstrap.balance;
      return;
    }
    // Ads. The host owns the policy and the actual ad; we only ask and report.
    if (data.type === "tesana-ad-policy") {
      try {
        adClient?.applyPolicy(adPolicyFrom(data));
      } catch {
        /* a bad policy must never break the listener */
      }
      return;
    }
    // The player changed the site's language. The host is the authority — it
    // resolved which language the player wants, and it owns the setting — so
    // this only carries it down. The game's own text re-renders when it draws
    // again, which is why the skill tells games to redraw from `t()` rather
    // than cache translated strings at startup.
    if (data.type === "tesana-locale") {
      try {
        resyncLocale(data);
      } catch {
        /* a bad locale must never break the listener */
      }
      return;
    }
    if (data.type === "tesana-ad-show") {
      try {
        const requestId = data.requestId || data.request_id;
        adClient?.settle(requestId, data);
      } catch {
        /* ignore */
      }
    }
  });
}

function waitBootstrap(timeoutMs = 1500) {
  if (typeof window === "undefined") return Promise.resolve({});
  const baked = window.__TESANA__;
  const named = Boolean(baked && (baked.gameId || baked.publicId));
  // A published game ships a baked bootstrap that names the game but carries
  // no token: the host posts the token, and the rooms grant along with it,
  // once the frame loads. Resolving on the baked copy alone dropped that
  // message, so the game minted its own guest identity and never saw the
  // grant. Wait for the host unless the page already holds a token, or there
  // is no host above us to post one.
  const hosted = typeof window.parent === "object" && window.parent !== null && window.parent !== window;
  if (baked && (baked.playerToken || (named && !hosted))) {
    // Record it as the live bootstrap, not just the return value: a game may
    // call init() a second time, and `mergedConfig()` reads this.
    if (!bootstrap || bootstrap.offline) bootstrap = baked;
    return Promise.resolve(baked);
  }
  if (bootstrap) return Promise.resolve(bootstrap);

  startListening();
  return new Promise((resolve) => {
    // The waiter is registered before the ask goes out. A host that answers
    // from the same tick — a test double, or a same-document frame — would
    // otherwise be answered into an empty list and the game would fall to
    // "offline" a second and a half later for no reason.
    bootstrapWaiters.push(resolve);
    setTimeout(() => applyBootstrap({ offline: true }), timeoutMs);
    // Ask, rather than wait to be told. The frame can finish loading before the
    // site has minted the session, and a request is what makes the site post the
    // second time — without it a signed-in player's real bootstrap never arrives.
    askHostForBootstrap();
  });
}

/** Ask the host to post a bootstrap. Shared by boot and refresh, so the flag
 * that makes an answer an update is set in exactly one place. The message name
 * is what tells the host whether to re-mint or merely re-post. */
function askHostForBootstrap(type = "tesana-bootstrap-request") {
  bootstrapRequestPending = true;
  post({ type });
}

/**
 * Ask the host for a fresh bootstrap after a credential was refused.
 *
 * This is the SDK half of token expiry. A player token lives two hours and
 * used to be re-minted only on a page load, so after two hours a blip was
 * permanent until the player reloaded. Asking the host re-mints through it, and
 * the answer flows back through the same upgrade path identity and ads already
 * use, so a live game is re-pointed in place.
 *
 * Resolves with the new bootstrap, or `null` when there is no host or the host
 * did not answer in time. Concurrent callers share one ask: a game that has
 * been open for hours hits a burst of refusals at once, and one mint is what
 * all of them needed. The host rate-limits the mints themselves.
 *
 * @returns {Promise<object|null>}
 */
function requestHostBootstrap() {
  if (typeof window === "undefined") return Promise.resolve(null);
  if (bootstrapAskPromise) return bootstrapAskPromise;
  startListening();
  const askedAt = bootstrapGeneration;
  // A refresh, named as one. The host re-mints on this and merely re-posts on a
  // boot request, so the two are never confused.
  askHostForBootstrap("tesana-bootstrap-refresh");
  bootstrapAskPromise = new Promise((resolve) => {
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearInterval(poll);
      clearTimeout(expiry);
      bootstrapAskPromise = null;
      resolve(value);
    };
    // The bootstrap is delivered by the module-level listener, so watch the
    // generation rather than registering a second listener — the token the host
    // mints is scoped to this frame and is not ours to consume only here.
    const poll = setInterval(() => {
      if (bootstrapGeneration !== askedAt) finish(bootstrap);
    }, 25);
    const expiry = setTimeout(() => finish(null), MP_HOST_ASK_TIMEOUT_MS);
  });
  return bootstrapAskPromise;
}

function deviceId() {
  const cache = readCache();
  if (cache.deviceId) return cache.deviceId;
  const id = `dev_${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`;
  writeCache({ deviceId: id });
  return id;
}

/**
 * The store-native purchase surface a desktop prelude publishes, or null.
 *
 * A desktop, Steam or App Store build has no page above it and no Stripe — the
 * store's own purchase must run instead, and only the native side can open it.
 * `tesana-desktop.js` publishes `TesanaDesktop.storePurchase` on exactly those
 * builds and nothing else, so its presence is the whole signal. Reaching for it
 * on a plain web page finds `undefined` and changes nothing.
 */
function storeBilling() {
  const desktop = typeof window !== "undefined" ? window.TesanaDesktop : null;
  if (!desktop || typeof desktop.storePurchase !== "function") return null;
  return desktop;
}

/** How long the host has to answer a sign-in before we give up. */
const SIGN_IN_TIMEOUT_MS = 120000;

/**
 * How long a game waits for the host to run a checkout before giving up.
 *
 * Deliberately long: the player is reading a price and tapping a button, and
 * a purchase that times out mid-decision is worse than one that waits. The
 * game is told plainly when it does expire, so its shop never spins forever.
 */
const CHECKOUT_TIMEOUT_MS = 120000;

/** Ask the host above us for something only it can do. */
function post(message) {
  try {
    (window.parent || window).postMessage(message, "*");
  } catch {
    /* not serialisable */
  }
}

// ---------------------------------------------------------------------------
// Gameplay analytics: `tesana.track` and `tesana.gameplay`
// ---------------------------------------------------------------------------
//
// A game reports what happened in it (a level started, the player died, a run
// ended with a score) so its creator can see where players get stuck and where
// they quit. The pipe already exists end to end: the runtime shell injected
// into every web build exposes `window.__TESANA_EVENT__`, the Tesana page above
// the game buffers `tesana-gameplay-event` messages and files them against the
// play session with a token only it holds, and the ingest endpoint stores them.
// These functions are the game's end of that pipe.
//
// Three rules shape everything below:
//
//   - **Never throw.** The engine tells the AI to call these inline, at the
//     moment a player dies, with no guard. A TypeError here would turn a death
//     into a crash, so every entry point is wrapped and answers `false` when it
//     drops something.
//   - **Match the ingest endpoint's caps.** The server keeps at most 20 payload
//     keys, 40-character keys, 64-character strings and 2,000 characters in all,
//     and throws away the whole payload when it is over. Trimming here means a
//     slightly-too-big event loses a key rather than all of its context.
//   - **Discrete moments, not frames.** A game that reports on every frame
//     would fill the table and answer nothing, so events are rate limited per
//     second and capped per page load.
//
// They are synchronous and need no `init()`: they never touch the play service,
// only the page, so a game can report a level start on its first frame.

//: The message the host's play tracking listens for. Mirrored by the web host
//: (`PLAY_MESSAGES.gameplayEvent`) and the runtime shell.
const GAMEPLAY_MESSAGE = "tesana-gameplay-event";

//: The event types the ingest endpoint understands, minus the two the shell
//: owns (`session_end`, `error`). `track()` with one of these names files the
//: event under that type; any other name is a `custom` event.
const GAMEPLAY_EVENT_TYPES = new Set(["level_start", "level_complete", "death", "checkpoint", "score"]);
const GAMEPLAY_TYPE_ALIASES = { levelStart: "level_start", levelComplete: "level_complete" };

//: The ingest endpoint's own limits (`games/api/play_events.py`).
const GAMEPLAY_NAME_MAX = 64;
const GAMEPLAY_STRING_MAX = 64;
const GAMEPLAY_KEY_MAX = 40;
const GAMEPLAY_PROPS_MAX_KEYS = 20;
const GAMEPLAY_PROPS_MAX_CHARS = 2000;

//: At most this many events in any one second. Ten a second is exactly what
//: one host flush can carry (100 events every 10 seconds), and far above what a
//: game reporting real moments ever needs.
const GAMEPLAY_RATE_PER_SECOND = 10;
//: At most this many events per page load. An honest session sends tens; a
//: game stuck reporting at the rate limit for an hour would send 36,000.
const GAMEPLAY_SESSION_MAX = 1000;

//: Props promoted to the event's own columns rather than kept as context.
const GAMEPLAY_LEVEL_ID_KEYS = ["levelId", "level_id", "level"];
const GAMEPLAY_LEVEL_INDEX_KEYS = ["levelIndex", "level_index"];
const GAMEPLAY_NUMBER_KEYS = ["x", "y", "z", "value"];
const GAMEPLAY_PROMOTED = new Set([
  ...GAMEPLAY_LEVEL_ID_KEYS,
  ...GAMEPLAY_LEVEL_INDEX_KEYS,
  ...GAMEPLAY_NUMBER_KEYS,
  "name",
]);

let gameplaySecond = -1;
let gameplayInSecond = 0;
let gameplaySent = 0;

/** A finite number, or `undefined`. Numeric strings count; NaN never does. */
function gameplayNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/** A trimmed, capped string id from a string or a number, or `undefined`. */
function gameplayId(value, limit) {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return undefined;
    return String(value).slice(0, limit);
  }
  if (typeof value !== "string") return undefined;
  const text = value.trim().slice(0, limit);
  return text || undefined;
}

/** The first of `keys` that `props` holds a value for. */
function gameplayFirst(props, keys) {
  for (const key of keys) {
    if (props[key] !== undefined && props[key] !== null) return props[key];
  }
  return undefined;
}

/**
 * Roughly how long the server's `repr()` of this payload will be.
 *
 * The endpoint measures Python's `repr`, not JSON: it writes `1.0` for `1` and
 * puts a space after each colon and comma. Four characters per key is a safe
 * margin over both differences, so a payload that passes here passes there.
 */
function gameplayPayloadSize(payload, keys) {
  return JSON.stringify(payload).length + 4 * keys;
}

/**
 * Keep the scalar context a game passed, within the endpoint's caps.
 *
 * @param {object} props
 * @param {boolean} keepName keep a `name` prop as context (a custom event, whose
 *   own name is the event's name) rather than treating it as the name column
 */
function gameplayPayload(props, keepName) {
  const payload = {};
  let kept = 0;
  for (const rawKey of Object.keys(props)) {
    if (kept >= GAMEPLAY_PROPS_MAX_KEYS) break;
    if (GAMEPLAY_PROMOTED.has(rawKey) && !(keepName && rawKey === "name")) continue;
    const key = String(rawKey).trim().slice(0, GAMEPLAY_KEY_MAX);
    if (!key || Object.prototype.hasOwnProperty.call(payload, key)) continue;
    let value;
    try {
      value = props[rawKey];
    } catch {
      continue;
    }
    if (typeof value === "string") {
      value = value.slice(0, GAMEPLAY_STRING_MAX);
    } else if (typeof value === "number") {
      if (!Number.isFinite(value)) continue;
    } else if (typeof value !== "boolean" && value !== null) {
      // Objects, arrays, functions, undefined, symbols and bigints are not
      // stored: the analytics layer queries flat keys, and a nested shape it
      // did not expect is a foot-gun rather than a feature.
      continue;
    }
    payload[key] = value;
    if (gameplayPayloadSize(payload, kept + 1) > GAMEPLAY_PROPS_MAX_CHARS) {
      delete payload[key];
      continue;
    }
    kept += 1;
  }
  return kept ? payload : null;
}

/**
 * Build the event the host files, in the shape `POST /play/events` accepts.
 *
 * @param {string} type one of the ingest endpoint's event types
 * @param {string|undefined} name the event's own name (a custom event, a death's cause)
 * @param {object} props what the game passed
 */
function gameplayEvent(type, name, props) {
  const event = { type };
  const named = name !== undefined ? name : gameplayId(props.name, GAMEPLAY_NAME_MAX);
  if (named) event.name = named;
  const levelId = gameplayId(gameplayFirst(props, GAMEPLAY_LEVEL_ID_KEYS), GAMEPLAY_STRING_MAX);
  if (levelId) event.level_id = levelId;
  const levelIndex = gameplayNumber(gameplayFirst(props, GAMEPLAY_LEVEL_INDEX_KEYS));
  if (levelIndex !== undefined) event.level_index = Math.max(0, Math.floor(levelIndex));
  for (const key of GAMEPLAY_NUMBER_KEYS) {
    const number = gameplayNumber(props[key]);
    if (number !== undefined) event[key] = number;
  }
  // A custom event's own name is already its name, so a `name` prop is kept as
  // context like any other key instead of overwriting it.
  const payload = gameplayPayload(props, type === "custom");
  if (payload) event.payload = payload;
  event.ts = Date.now();
  return event;
}

/** Whether one more event fits this second and this page load. */
function gameplayAllowed() {
  if (gameplaySent >= GAMEPLAY_SESSION_MAX) {
    warnOnce(
      "gameplay-session-max",
      `tesana.track: ${GAMEPLAY_SESSION_MAX} events this session; further events are dropped. Report discrete moments (a level, a death, a run's end), never every frame.`,
    );
    return false;
  }
  const second = Math.floor(Date.now() / 1000);
  if (second !== gameplaySecond) {
    gameplaySecond = second;
    gameplayInSecond = 0;
  }
  if (gameplayInSecond >= GAMEPLAY_RATE_PER_SECOND) {
    warnOnce(
      "gameplay-rate",
      `tesana.track: more than ${GAMEPLAY_RATE_PER_SECOND} events in one second; the extra ones are dropped. Report discrete moments, never every frame.`,
    );
    return false;
  }
  gameplayInSecond += 1;
  gameplaySent += 1;
  return true;
}

/**
 * Hand an event to whoever files it. `true` when it was handed on.
 *
 * The shell's `__TESANA_EVENT__` comes first: it posts the same message, and
 * going through it lets the shell name the last level in its `session_end`.
 * Without the shell, the message goes straight to the Tesana page above. With
 * neither there is nobody to tell, and the event is dropped.
 */
function gameplayDeliver(event) {
  // Kept for a bug report before it is handed on, so the trail is there even
  // on a page with nobody above it to receive the event itself.
  rememberEvent(event);
  if (typeof window === "undefined") return false;
  const bridge = window.__TESANA_EVENT__;
  if (typeof bridge === "function") {
    bridge(event);
    return true;
  }
  if (!hasHost()) return false;
  post({ type: GAMEPLAY_MESSAGE, event });
  return true;
}

/** The game's props as a plain object, whatever it actually passed. */
function gameplayProps(props) {
  return props && typeof props === "object" && !Array.isArray(props) ? props : {};
}

/**
 * Report something that happened in the game.
 *
 * `name` is the game's own name for it (`"powerup_picked"`). A name that is one
 * of the platform's types (`"death"`, `"level_start"`, `"level_complete"`,
 * `"checkpoint"`, `"score"`) is filed as that type. `props` is a small object of
 * scalars; `levelId`, `levelIndex`, `x`, `y`, `z` and `value` become columns and
 * anything else rides along as context.
 *
 * Synchronous, never throws, and never returns a promise: `true` when the event
 * was handed on, `false` when it was dropped (a bad name, too many events, or
 * nothing above the game to hand it to).
 *
 * @param {string} name
 * @param {Record<string, string|number|boolean|null>} [props]
 * @returns {boolean}
 */
function track(name, props) {
  try {
    const label = gameplayId(name, GAMEPLAY_NAME_MAX);
    if (!label) {
      warnOnce("gameplay-name", "tesana.track: the first argument must be a non-empty event name.");
      return false;
    }
    if (!gameplayAllowed()) return false;
    const builtIn = GAMEPLAY_TYPE_ALIASES[label] || label;
    const event = GAMEPLAY_EVENT_TYPES.has(builtIn)
      ? gameplayEvent(builtIn, undefined, gameplayProps(props))
      : gameplayEvent("custom", label, gameplayProps(props));
    return gameplayDeliver(event);
  } catch {
    return false;
  }
}

/**
 * One gameplay helper. `props` may also be a bare level id (`levelStart(3)`), or
 * for `score` a bare value (`score(1200)`).
 *
 * @param {string} type
 * @param {"levelId"|"value"} shorthand
 */
function gameplayHelper(type, shorthand) {
  return function report(props) {
    try {
      if (!gameplayAllowed()) return false;
      const given = typeof props === "string" || typeof props === "number"
        ? { [shorthand]: props }
        : gameplayProps(props);
      return gameplayDeliver(gameplayEvent(type, undefined, given));
    } catch {
      return false;
    }
  };
}

/**
 * The progression events every game with levels, waves, runs or deaths should
 * send. `levelId` is the join key: give it the same stable value in each call
 * for one level, so a funnel can line them up.
 */
const gameplay = Object.freeze({
  /** A level, stage, wave or area begins: `{ levelId, levelIndex? }`. */
  levelStart: gameplayHelper("level_start", "levelId"),
  /** A level is cleared: `{ levelId }`. */
  levelComplete: gameplayHelper("level_complete", "levelId"),
  /** The player died: `{ levelId, x?, y?, z?, name? }` (`name` is the cause). */
  death: gameplayHelper("death", "levelId"),
  /** A checkpoint is reached: `{ levelId, name? }`. */
  checkpoint: gameplayHelper("checkpoint", "levelId"),
  /** A run ended: `{ value, levelId? }`. */
  score: gameplayHelper("score", "value"),
});

// ---------------------------------------------------------------------------
// Feedback and crash capture: `tesana.feedback`
// ---------------------------------------------------------------------------
//
// A report is only as useful as the context it carries, and the context lives
// here, in the frame: the last things the player did, the errors the page
// threw, and what the canvas looked like. So the SDK keeps a short trail of
// each from the moment it loads, and attaches it to whatever is reported —
// a bug a player typed into the host's form, or a crash the SDK noticed on
// its own.
//
// Capture follows the gameplay rules: it never throws, it never blocks, and
// it is bounded. A game that throws every frame sends a handful of crash
// reports per page load, not a flood.

//: What a report carries, newest kept. The service caps the same numbers.
const FEEDBACK_TRAIL_MAX = 50;
const FEEDBACK_ERRORS_MAX = 20;
const FEEDBACK_ERROR_MESSAGE_MAX = 500;
const FEEDBACK_STACK_MAX = 4000;
//: A downscaled JPEG fits easily; past this the screenshot is left off.
const FEEDBACK_SCREENSHOT_MAX = 200000;
const FEEDBACK_SCREENSHOT_WIDTHS = [640, 400];
//: Crash reports per page load, and the least time between two of them.
const CRASH_SESSION_MAX = 5;
const CRASH_MIN_GAP_MS = 5000;
//: How long the host's report form may stay open.
const FEEDBACK_FORM_TIMEOUT_MS = 600000;

const feedbackTrail = [];
const feedbackErrors = [];
const crashSeen = new Set();
let crashSent = 0;
let crashLastAt = 0;
//: The client crash reports are filed through. Set by `init()`; a crash before
//: then is still kept in the error trail and rides along on the next report.
let feedbackClient = null;
let crashWindow = null;

function rememberEvent(event) {
  feedbackTrail.push(event);
  if (feedbackTrail.length > FEEDBACK_TRAIL_MAX) feedbackTrail.splice(0, feedbackTrail.length - FEEDBACK_TRAIL_MAX);
}

function clipText(value, max) {
  return value == null ? "" : String(value).slice(0, max);
}

function rememberError(entry) {
  feedbackErrors.push(entry);
  if (feedbackErrors.length > FEEDBACK_ERRORS_MAX) feedbackErrors.splice(0, feedbackErrors.length - FEEDBACK_ERRORS_MAX);
}

/** An error-ish value as `{ message, stack }`, whatever was actually thrown. */
function describeError(value) {
  if (value && typeof value === "object") {
    return {
      message: clipText(value.message || value.name || String(value), FEEDBACK_ERROR_MESSAGE_MAX),
      stack: clipText(value.stack, FEEDBACK_STACK_MAX),
    };
  }
  return { message: clipText(String(value), FEEDBACK_ERROR_MESSAGE_MAX), stack: "" };
}

/** Same fault, same key — numbers blanked, top of the stack only. Mirrors the service. */
function crashKey(error) {
  const top = String(error.stack || "")
    .split("\n")
    .slice(1, 4)
    .map((line) => line.replace(/:\d+(?::\d+)?/g, ""))
    .join("|");
  const text = `${String(error.message || "").replace(/\d+/g, "N")}|${top}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

/**
 * Whether an uncaught failure is a crash worth telling the creator about.
 *
 * "Script error." with no stack is a cross-origin script the browser will not
 * describe — there is nothing in it a creator could act on. An SDK error that
 * carries a `code` (`login_required`, `insufficient_coins`, ...) is an outcome
 * the game forgot to catch, not a crash, and a network failure is the
 * player's connection. All three are kept in the error trail; none is filed.
 */
function isReportableCrash(error, reason) {
  if (!error.message && !error.stack) return false;
  if (/^Script error\.?$/i.test(error.message) && !error.stack) return false;
  if (reason && typeof reason === "object" && typeof reason.code === "string") return false;
  if (/Failed to fetch|NetworkError|Load failed/i.test(error.message)) return false;
  return true;
}

function reportCrash(error) {
  try {
    const key = crashKey(error);
    if (crashSeen.has(key)) return;
    const now = Date.now();
    if (crashSent >= CRASH_SESSION_MAX || now - crashLastAt < CRASH_MIN_GAP_MS) return;
    const client = feedbackClient;
    if (!client || !client._feedbackReachable()) return;
    crashSeen.add(key);
    crashSent += 1;
    crashLastAt = now;
    client._feedbackSubmit({ kind: "crash", error }, { screenshot: true }).catch(() => {});
  } catch {
    /* reporting a crash must never be the next crash */
  }
}

/**
 * Listen for what the page throws. Once per window, and only by listening:
 * `window.onerror` belongs to the game, and replacing it would break a game
 * that set its own. `console.error` is wrapped to keep a copy, then passed on.
 */
function installCrashCapture() {
  if (typeof window === "undefined" || crashWindow === window) return;
  crashWindow = window;
  try {
    window.addEventListener("error", (event) => {
      try {
        const error = event && event.error ? describeError(event.error) : describeError(event && event.message);
        rememberError({
          ...error,
          source: clipText(event && event.filename, 300),
          line: event && event.lineno,
          col: event && event.colno,
          at: Date.now(),
        });
        if (isReportableCrash(error, event && event.error)) reportCrash(error);
      } catch {
        /* ignore */
      }
    });
    window.addEventListener("unhandledrejection", (event) => {
      try {
        const reason = event && event.reason;
        const error = describeError(reason);
        rememberError({ ...error, source: "unhandledrejection", at: Date.now() });
        if (isReportableCrash(error, reason)) reportCrash(error);
      } catch {
        /* ignore */
      }
    });
  } catch {
    /* a page with no event target still plays */
  }
  try {
    const target = typeof console !== "undefined" ? console : null;
    if (target && typeof target.error === "function" && !target.error.__tesanaWrapped) {
      const original = target.error;
      const wrapped = function (...args) {
        try {
          const first = args.find((arg) => arg instanceof Error);
          const text = args
            .map((arg) => (arg instanceof Error ? arg.message : typeof arg === "string" ? arg : safeJson(arg)))
            .join(" ");
          rememberError({
            message: clipText(text, FEEDBACK_ERROR_MESSAGE_MAX),
            stack: first ? clipText(first.stack, FEEDBACK_STACK_MAX) : "",
            source: "console",
            at: Date.now(),
          });
        } catch {
          /* ignore */
        }
        return original.apply(this, args);
      };
      wrapped.__tesanaWrapped = true;
      target.error = wrapped;
    }
  } catch {
    /* ignore */
  }
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** The device, as far as a report needs it. */
function feedbackDevice() {
  const out = {};
  try {
    if (typeof navigator !== "undefined") {
      if (navigator.userAgent) out.userAgent = clipText(navigator.userAgent, 300);
      if (navigator.platform) out.platform = clipText(navigator.platform, 64);
      if (navigator.language) out.language = clipText(navigator.language, 64);
      if (typeof navigator.maxTouchPoints === "number") out.touch = navigator.maxTouchPoints > 0;
    }
    if (typeof window !== "undefined") {
      if (window.screen) {
        out.screenW = window.screen.width;
        out.screenH = window.screen.height;
      }
      if (typeof window.innerWidth === "number") {
        out.viewportW = window.innerWidth;
        out.viewportH = window.innerHeight;
      }
      if (typeof window.devicePixelRatio === "number") out.dpr = window.devicePixelRatio;
    }
  } catch {
    /* ignore */
  }
  return out;
}

/**
 * The game's biggest canvas as a small JPEG, or null.
 *
 * Best effort and expected to fail sometimes: a WebGL canvas made without
 * `preserveDrawingBuffer` reads back blank between frames, and a canvas that
 * drew a cross-origin image refuses to be read at all. Neither is worth more
 * than leaving the screenshot off.
 */
function captureScreenshot() {
  try {
    if (typeof document === "undefined" || typeof document.querySelectorAll !== "function") return null;
    let best = null;
    for (const canvas of Array.from(document.querySelectorAll("canvas"))) {
      const area = (canvas.width || 0) * (canvas.height || 0);
      if (area > 0 && (!best || area > best.width * best.height)) best = canvas;
    }
    if (!best) return null;
    for (const width of FEEDBACK_SCREENSHOT_WIDTHS) {
      const scale = Math.min(1, width / best.width);
      const copy = document.createElement("canvas");
      copy.width = Math.max(1, Math.round(best.width * scale));
      copy.height = Math.max(1, Math.round(best.height * scale));
      const ctx = copy.getContext("2d");
      if (!ctx) return null;
      ctx.drawImage(best, 0, 0, copy.width, copy.height);
      const url = copy.toDataURL("image/jpeg", 0.6);
      if (typeof url === "string" && url.startsWith("data:image/") && url.length <= FEEDBACK_SCREENSHOT_MAX) return url;
    }
  } catch {
    /* tainted, blank or missing: no screenshot */
  }
  return null;
}

// ---------------------------------------------------------------------------
// Invite links: `tesana.share`
// ---------------------------------------------------------------------------
//
// A link that opens the game where the sharer is — their private room, the
// level they just beat. The host builds the link (it knows the game's public
// address and how the site previews it) and hands what it carries back to the
// game when someone opens it, either in the bootstrap's `launch` or as query
// parameters on the frame.

const SHARE_ROOM_PARAM = "tesana_room";
const SHARE_LEVEL_PARAM = "tesana_level";
const SHARE_TEXT_MAX = 280;
const SHARE_TIMEOUT_MS = 60000;

/** Room codes as the service writes them: uppercase letters and digits, eight at most. */
function shareRoomCode(value) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const code = String(value).toUpperCase().replace(/[^0-9A-Z]/g, "").slice(0, 8);
  return code || null;
}

function shareLevelId(value) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const id = String(value).trim().slice(0, 64);
  return /^[A-Za-z0-9 ._:-]+$/.test(id) ? id : null;
}

function shareQuery() {
  try {
    const search = typeof window !== "undefined" && window.location ? window.location.search : "";
    if (!search || typeof URLSearchParams === "undefined") return {};
    const params = new URLSearchParams(search);
    return { roomCode: params.get(SHARE_ROOM_PARAM), levelId: params.get(SHARE_LEVEL_PARAM) };
  } catch {
    return {};
  }
}

/** A link to this page that carries the invite, for a game with no host above it. */
function shareFallbackUrl(roomCode, levelId) {
  try {
    const loc = window.location;
    const base = `${loc.origin || ""}${loc.pathname || "/"}`;
    const params = new URLSearchParams();
    if (roomCode) params.set(SHARE_ROOM_PARAM, roomCode);
    if (levelId) params.set(SHARE_LEVEL_PARAM, levelId);
    const query = params.toString();
    return query ? `${base}?${query}` : base;
  } catch {
    return "";
  }
}

/** Wait for one answer from the host, by request id. Resolves `null` on timeout. */
function awaitHostAnswer(type, requestId, timeoutMs) {
  return new Promise((resolve) => {
    let expiry = null;
    function onMessage(event) {
      const msg = event && event.data;
      if (!msg || typeof msg !== "object" || msg.type !== type || msg.requestId !== requestId) return;
      window.removeEventListener("message", onMessage);
      clearTimeout(expiry);
      resolve(msg);
    }
    window.addEventListener("message", onMessage);
    expiry = setTimeout(() => {
      window.removeEventListener("message", onMessage);
      resolve(null);
    }, timeoutMs);
  });
}

// ---------------------------------------------------------------------------
// Saves: the per-game local cache behind `tesana.db`
// ---------------------------------------------------------------------------
//
// Every Tesana game runs on one origin (play.tesana.ai), so one localStorage
// for all of them. The cache used to be a single `db` map inside
// LOCAL_CACHE keyed only by key name: two games that both saved "save" read
// each other's value, and a guest's first cloud session could upload another
// game's save into this one. Each game now has its own storage key, and the
// old shared map is never read or uploaded (nor deleted: it is somebody's
// data, and nothing here can prove whose).
//
// One entry per key: `{ v, ver, dirty, cond, seq }`. `v` is the value; `ver`
// the cloud version it is at (or, while `dirty`, the version the local edit
// was based on; null when unknown). `dirty` means written here but not yet
// confirmed by the cloud — a read never replaces a dirty value with the
// cloud's, it retries the upload instead. `cond` marks a dirty write the game
// made with `ifVersion`. `seq` tells an upload's answer apart from a newer
// local write that landed while it was in flight.

//: The largest value the play service stores for one key (JSON bytes).
//: Mirrors MAX_DB_VALUE_BYTES in the adapters.
const DB_MAX_BYTES = 256 * 1024;

function dbCacheKey(gameId) {
  const id = gameId == null ? "" : String(gameId);
  return `${LOCAL_CACHE}.db.${id || "_"}`;
}

function readDbCache(gameId) {
  try {
    const raw = JSON.parse(localStorage.getItem(dbCacheKey(gameId)) || "{}");
    return raw && typeof raw === "object" && raw.keys && typeof raw.keys === "object" ? raw : { keys: {} };
  } catch {
    return { keys: {} };
  }
}

function writeDbEntry(gameId, key, entry) {
  try {
    const cache = readDbCache(gameId);
    if (entry) cache.keys[key] = entry;
    else delete cache.keys[key];
    localStorage.setItem(dbCacheKey(gameId), JSON.stringify(cache));
  } catch {
    /* ignore: a full or blocked storage still leaves the cloud write */
  }
}

function dbError(code, message, extra) {
  const err = new Error(message);
  err.code = code;
  if (extra) Object.assign(err, extra);
  return err;
}

/**
 * Whether a failed save request means "not synced, try later" rather than
 * "refused". Unreachable, 5xx, 401/403/408/429 — and any 409 except
 * `version_conflict`: a `conflict` ("Save is busy", the service's own write
 * retries ran out) or a DynamoDB `tx_conflict` is two writes racing on the
 * row, not a verdict on this value, so the same write can land on a retry.
 * Only `version_conflict` (the stored version moved) and the validation
 * refusals (413 too large, 400 bad value) are answers a retry cannot change.
 */
function saveRetryable(err) {
  const status = Number(err && err.status);
  if (!status) return true;
  if (status === 409) return err.code !== "version_conflict";
  return status >= 500 || status === 401 || status === 403 || status === 408 || status === 429;
}

function hostRequestId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

// ---------------------------------------------------------------------------
// Remote config: `tesana.config`
// ---------------------------------------------------------------------------

//: How long `config.ready()` waits for the service before settling for the cache.
const CONFIG_READY_TIMEOUT_MS = 3000;

function cachedConfig(gameId) {
  const all = readCache().config;
  const row = all && typeof all === "object" ? all[String(gameId)] : null;
  return row && typeof row === "object" && row.values && typeof row.values === "object"
    ? { values: row.values, version: Number(row.version) || 0 }
    : { values: {}, version: 0 };
}

function cacheConfig(gameId, row) {
  const all = readCache().config;
  const next = all && typeof all === "object" ? { ...all } : {};
  next[String(gameId)] = { values: row.values, version: row.version };
  writeCache({ config: next });
}

/**
 * @param {TesanaConfig} [config]
 */
async function init(config = {}) {
  gameConfig = config || {};
  resetHostChannel();
  // "Once per session" starts here. Diagnostics dedupe on a module-level set,
  // which would otherwise be per-page-load — long after a game has re-inited.
  warnedKeys.clear();
  // Attach the host channel unconditionally. It used to be attached only when
  // the game was *waiting* for a bootstrap, which meant a page that shipped a
  // token never listened — so a wallet change, an ad policy, or an ad result
  // posted later was dropped on the floor. Those all arrive after boot.
  startListening();
  // Before anything that can fail, so a crash during boot is in the trail.
  installCrashCapture();
  const boot = await waitBootstrap();
  const client = new TesanaClient(buildConfig(mergedConfig()));
  feedbackClient = client;
  // Remote config needs no session, so it starts now and never holds up boot:
  // until it lands, `config.get` answers from the last session's copy.
  client.config.reload().catch(() => {});
  // An unreachable play service must cost a *feature*, never the game.
  //
  // This is the client half of a contract the server already keeps: Django's
  // mint returns None rather than failing a request, precisely so that "the
  // play service being slow, down, or unconfigured means the SDK keeps saves in
  // the browser — worse, but the game still runs". Without this catch the
  // client contradicted that. `ensureSession()` mints an identity over HTTP, so
  // a failure here rejected `__TESANA_READY__`, and a game doing the documented
  // `await window.__TESANA_READY__` threw on its first line — turning a service
  // outage into a broken game for everyone using it.
  //
  // Falling back to offline is the correct degradation, not a swallow: every
  // read already has a local or empty answer (`balance()` reports zero,
  // `shop.read()` reports a shut shutter, saves read as missing), and a later
  // bootstrap upgrade still re-runs the identity step through
  // `onBootstrapUpgrade` below. The player loses cloud features for that
  // session and keeps their game.
  try {
    await client.ensureSession();
  } catch (err) {
    client.goOffline(err);
  }
  // Localization comes after identity, not before: the bundle is fetched with
  // the player's token, so a game that just minted one would otherwise load it
  // unauthenticated and stay in its source language all session. Awaited here
  // so `await __TESANA_READY__` is genuinely enough — the first frame a game
  // draws can already be translated.
  try {
    await client.l10n.reload();
  } catch {
    /* localization must never block the game's start */
  }
  window.__TESANA_PLAYER__ = client.player.me();
  // A provisional "offline" answer can upgrade later. Re-point this client in
  // place — the game holds a reference to it — and re-run the identity step,
  // or the player's real token arrives and is ignored, leaving a signed-in
  // player with a balance frozen at zero.
  const finishUpgrade = () => {
    const before = client.gameId;
    client.configure(buildConfig(mergedConfig()));
    client.ensureSession().then(() => client.l10n.reload());
    // A provisional answer may not have named the game, so its config was
    // never asked for. Only then: a token refresh is an upgrade too, and one
    // fetch per refresh would be a fetch per two hours of play for nothing.
    if (client.gameId !== before || !client._config.attempted) client.config.reload().catch(() => {});
    window.__TESANA_PLAYER__ = client.player.me();
  };
  onBootstrapUpgrade(finishUpgrade);
  return client;
}

/** Everything the game passed to init(), kept so an upgrade can reuse it. */
let gameConfig = null;

/** Fold the latest host answer and the game's own `init(config)` into one. */
function mergedConfig() {
  return { ...(bootstrap || {}), ...(gameConfig || {}) };
}

/** Turn a raw bootstrap + game config into the client's constructor options. */
function buildConfig(merged) {
  const endpoint = String(merged.endpoint || merged.apiBase || defaultEndpoint()).replace(/\/$/, "");
  // Keep the type the host sent: a Tesana page posts a number, a room build
  // bakes a string, and `tesana.gameId` is public surface a game may compare
  // against. Only trim, never coerce.
  const rawGameId = merged.gameId ?? merged.publicId ?? "";
  const gameId = typeof rawGameId === "string" ? rawGameId.trim() : rawGameId;
  return {
    endpoint,
    gameId,
    // The site hands this as `token`; the room build/server splice it as
    // `playerToken`. Either way it is the play service's player token, and it
    // authorises saves and the economy alike.
    token: merged.token || merged.playToken || merged.playerToken || "",
    // The host named a save service (even if it could not mint a token for
    // this player). That is a different thing from a room build, which bakes
    // one `endpoint` that *is* the save service — see `saveServiceNamed`.
    saveEndpoint: merged.saveEndpoint || merged.save_endpoint || "",
    saveToken: merged.saveToken || merged.save_token || "",
    saveServiceNamed: "saveEndpoint" in merged || "save_endpoint" in merged,
    rail: merged.rail || "tesana",
    deviceId: merged.deviceId || deviceId(),
    // The host decides whether this game may place rooms. Absent means an
    // older host that predates the capability, so keep multiplayer working.
    multiplayer: merged.multiplayer !== false,
    // Not fatal. A page opened outside Tesana has no host and no game id, and
    // it still has to play — the shop stays dark and saves stay local, which
    // is the same shape as `offline`, only without a host to have said so.
    offline: Boolean(merged.offline) || !endpoint || !gameId,
    // A signed-out visitor stays offline for saves and the shop, but the host
    // may still hand them a token that only opens rooms, so they can play
    // together on the game's own address. Used by `multiplayer.*` alone.
    roomEndpoint: merged.roomEndpoint || "",
    roomToken: merged.roomToken || "",
    player: merged.player || null,
    // The host tells the frame which public address this game answers on, so
    // a game can show and copy its own link without asking the player to
    // remember it. Absent means no vanity address is configured (or an older
    // host that predates the capability) — `vanity.public()` then reports
    // null and the game simply does not offer one.
    vanityAddress: merged.vanityAddress || merged.vanity || "",
    // Whether the host is willing to place ads in this game. Absent means an
    // older host that predates the capability; treated as "get permission
    // from the host before showing anything" rather than as a blanket yes.
    adsEnabled: merged.adsEnabled,
    adFormats: merged.adFormats || merged.ad_formats || [],
    adMinIntervalMs: merged.adMinIntervalMs ?? merged.ad_min_interval_ms,
    // The player's language, as the host resolved it. The host owns the
    // setting (the site has a language picker and the game does not), so this
    // is read from the bootstrap rather than sniffed here — a game that
    // guessed from `navigator.language` would disagree with the site the
    // player is reading. Absent means an older host: localization then falls
    // back to the source language and the game renders exactly as it did.
    locale: normalizeLocale(
      merged.locale || merged.language || merged.lang || (typeof navigator !== "undefined" && navigator.language) || "",
    ),
    // How a dropped room socket is retried. A game can shrink the waits (a
    // test, or a game with unusual tolerance); the defaults are the fleet's.
    multiplayerReconnect: merged.multiplayerReconnect || undefined,
    // Which build of the game this is, for a bug report. The host stamps it;
    // absent means an older host and reports simply say nothing.
    build: String(merged.build || merged.buildId || merged.buildVersion || "").slice(0, 64),
    // What an invite link carried, when the host opened the game from one.
    launch: merged.launch && typeof merged.launch === "object" ? merged.launch : null,
  };
}

function defaultEndpoint() {
  if (typeof window === "undefined") return "http://localhost:8788";
  if (window.__TESANA__?.endpoint) return window.__TESANA__.endpoint;
  return window.location.origin;
}

class TesanaClient {
  /**
   * @param {{ endpoint: string, gameId: string, token: string, rail: string, deviceId: string, multiplayer?: boolean, saveEndpoint?: string, saveToken?: string, offline?: boolean, roomEndpoint?: string, roomToken?: string, player?: object|null, vanityAddress?: string, adsEnabled?: boolean, locale?: string }} opts
   */
  constructor(opts) {
    this.endpoint = opts.endpoint;
    this.gameId = opts.gameId;
    this.token = opts.token;
    this.rail = opts.rail;
    this.deviceId = opts.deviceId;
    // Saves and the shop fail independently: a game can have a wallet and no
    // cloud save, or a save and no shop. Neither failing stops the game.
    //
    // Two host shapes reach here. A Tesana page hands the save service its own
    // `saveEndpoint`/`saveToken`; a room build bakes one `endpoint` that *is*
    // the save service and a single token. The second shape keeps working by
    // falling back to `endpoint` when no separate save service was named — see
    // `_saveBase`/`_saveToken`.
    this.saveEndpoint = String(opts.saveEndpoint || "").replace(/\/$/, "");
    this.saveToken = opts.saveToken || "";
    // Whether the host told us it has a save service, separately from whether
    // it could mint a token for this player. A page that sends an empty
    // `saveEndpoint` is saying "no cloud saves for you" — not "your endpoint is
    // me" — and the difference decides whether saves go quiet or 401 forever.
    //
    // Two host shapes reach here. A Tesana page names its save service; a room
    // build bakes one `endpoint` that *is* the save service and a single token,
    // and names nothing, so the endpoint stands in for it.
    this.saveServiceNamed = Boolean(opts.saveServiceNamed);
    if (!this.saveServiceNamed && this.endpoint && !this.saveEndpoint) {
      this.saveEndpoint = this.endpoint;
      this.saveToken = this.token;
    }
    // Cloud saves need an address and a credential. A guest has neither, and a
    // doomed request on every save is noise, not a save.
    this.canSaveToCloud = Boolean(this.saveEndpoint && this.saveToken);
    this.offline = Boolean(opts.offline);
    this.roomEndpoint = String(opts.roomEndpoint || "").replace(/\/$/, "");
    this.roomToken = opts.roomToken || "";
    this._player = opts.player || null;
    const reconnect = opts.multiplayerReconnect || {};
    this._mp = {
      ws: null,
      handlers: [],
      roomId: null,
      // The current room's share code, or null for a public room.
      code: null,
      // Reconnect state. `wsUrl` is kept so a dropped socket can re-enter the
      // same room; `leaving` stops a deliberate leave from being retried.
      wsUrl: null,
      leaving: false,
      reconnectTimer: null,
      reconnectAttempts: 0,
      // The code of the last close we saw. 4401 means the grant was refused —
      // expired, most likely — and a fresh one has to be minted before the next
      // reconnect can succeed. Cleared once a reconnect has used it.
      lastCloseCode: null,
      reconnectExhausted: false,
      statusHandlers: [],
      // Overridable so a test (or a game with unusual tolerance) can shorten
      // the wait without patching the global timers.
      reconnectBaseMs: Number(reconnect.baseMs) || MP_RECONNECT_BASE_MS,
      reconnectMaxMs: Number(reconnect.maxMs) || MP_RECONNECT_MAX_MS,
      reconnectMaxAttempts: Number(reconnect.maxAttempts) || MP_RECONNECT_MAX_ATTEMPTS,
    };
    this._mpEnabled = opts.multiplayer !== false;
    // The address the host said this game answers on. Kept on the instance so
    // `vanity.public()` is synchronous; `null` rather than `""` because "no
    // address configured" and "an empty address" should not both read as a
    // usable link.
    this._vanityAddress = opts.vanityAddress ? String(opts.vanityAddress) : null;

    this.player = {
      // No player yet means a guest, not a crash: a page with no host, and a
      // game reading `player.me()` before its first save load, both land here.
      me: () => this._player || { isGuest: true, displayName: "Player" },
      isGuest: () => !this._player || Boolean(this._player.isGuest),
      login: (identity) => this.login(identity),
      update: (patch) => this.request("PATCH", "/v1/player/me", patch),
    };
    this.db = {
      get: (key, opts) => this._dbGet(key, opts),
      set: (key, value, opts) => this._dbSet(key, value, opts),
      delete: (key) => this._dbDelete(key),
      // Feature detection for games: an SDK without this has none of
      // withVersion / ifVersion / delete.
      capabilities: Object.freeze({ versions: true, history: true, maxBytes: DB_MAX_BYTES }),
      list: () => this.request("GET", "/v1/db").then((r) => r.items),
      collection: (name) => ({
        get: (id) => this.request("GET", `/v1/collections/${enc(name)}/${enc(id)}`),
        put: (id, data, scope) =>
          this.request("PUT", `/v1/collections/${enc(name)}/${enc(id)}`, { data, scope }),
        list: () => this.request("GET", `/v1/collections/${enc(name)}`).then((r) => r.items),
        delete: (id) => this.request("DELETE", `/v1/collections/${enc(name)}/${enc(id)}`),
      }),
    };

    // The economy belongs to the play service, not the site: coins, prices and
    // entitlements are its table's, and every call below rides the save
    // transport (`this.request`), which it authenticates with the player token.
    //
    // Reads degrade rather than throw. A game draws its shop on the first
    // frame, and a hostless page — or a service that is briefly down — has to
    // render an empty shelf instead of throwing in the middle of a menu. Writes
    // (`buy`, `topUp`) deliberately still surface their errors: a swallowed
    // failure there is a purchase that silently did nothing.
    const read = (path, fallback) =>
      this._canReach() ? this.request("GET", path).catch(() => fallback) : Promise.resolve(fallback);

    this.economy = {
      balance: () => read("/v1/economy/balance", { coins: 0, soft: 0, canSpend: false }),
      packs: () => read("/v1/economy/packs", { packs: [] }).then((r) => r.packs || []),
      topUp: (packId, opts) => this._topUp(packId, opts),
      // Signing in is the host's job — a game cannot show a password field.
      signIn: () => this._signIn(),
    };
    this.shop = {
      catalog: () => this._shopRead().then((result) => result.items),
      // `items()` cannot say *why* a shelf is bare, and the difference decides
      // what the player should see: "nothing is for sale" is an empty rack,
      // "we could not ask" is a shut shutter and a retry. `read()` is that.
      read: () => this._shopRead(),
      buy: (sku, opts) => {
        // When a Tesana page is above us, it runs the purchase: a price
        // confirmation belongs in a window we control, and a sandboxed
        // cross-origin frame is the wrong place for one. The host asks the
        // server, so the game still never states a price.
        //
        // With no host — a game opened straight from the play CDN — there is
        // nobody to draw a confirmation and no page to open checkout on, so
        // the game falls back to the direct call it has always made. That path
        // carries its own token and is exactly as safe as it was.
        if (!hasHost()) {
          return this.request("POST", "/v1/shop/buy", {
            sku,
            clientRequestId: opts?.clientRequestId,
          });
        }
        return requestCheckoutFromHost("item", { sku: sku }).then((result) => {
          if (result && result.ok === true) return result;
          // A host that answered without a grant is a refusal, not a success.
          const err = new Error("The purchase was not completed.");
          err.code = "cancelled";
          throw err;
        });
      },
      entitlements: () => read("/v1/shop/entitlements", { items: [] }).then((r) => r.items || []),
      // Kept so games written against the shop's earlier shape still run, with
      // the shape they expect: `items()` was an array, `inventory()` a sku →
      // count map, and `balance()` a bare number. The service models an
      // entitlement as owned-or-not, so every owned sku maps to one.
      items: () => this.shop.catalog(),
      inventory: () =>
        this.shop.entitlements().then((list) => Object.fromEntries(list.map((e) => [e.sku, 1]))),
      balance: () => this.economy.balance().then((r) => r.coins || 0),
      signIn: () => this._signIn(),
    };

    // Leaderboards and achievements. Both are declared by the build (the same
    // way a shop catalogue is) and both are client-reported, so neither is
    // authoritative — a leaderboard is a ranking to show off, not a prize
    // table. Reads degrade like the shop's, because a scoreboard is drawn on a
    // game-over screen and must never take that screen down with it.
    //
    // Writes surface their errors, like `buy` does: an unknown board id is a
    // build mistake the developer needs to see, not a silent nothing. Gameplay
    // calls should still catch — a score that fails to send is not a reason to
    // break the game — but the failure is visible rather than swallowed here.
    this.scores = {
      // Report a result. Only kept if it beats this player's own best, so
      // calling it on every run is cheap and idempotent. Resolves
      // `{ board, score, best, improved }` — `improved` is the only thing a
      // "new high score!" banner needs.
      submit: (board, score) =>
        this.request("POST", "/v1/scores", { board: String(board || ""), score: Number(score) }),
      // One board's standings, best first. `{ board, order, entries }`, where
      // an entry is `{ rank, score, displayName, isGuest, you? }`. A guest the
      // site vouches for is listed under its placeholder name; one the game
      // minted for itself is not.
      top: (board, opts) =>
        read(
          `/v1/scores/${enc(board)}?gameId=${enc(this.gameId)}${
            opts && opts.limit ? `&limit=${Number(opts.limit)}` : ""
          }`,
          { board: String(board || ""), entries: [] },
        ),
      // This player's own bests across every board they have set.
      me: () => read("/v1/scores", { scores: [] }).then((r) => r.scores || []),
      // Convenience: this player's best on one board, or `null`, for a HUD.
      best: (board) =>
        this.scores.me().then((rows) => rows.find((row) => row.board === board) || null),
    };

    this.achievements = {
      // Every declared achievement, with this player's progress and unlocks
      // folded in — one call is enough to draw the whole screen.
      list: () => read("/v1/achievements", { items: [] }).then((r) => r.items || []),
      // What the player has actually earned, for a badge row or a count.
      unlocked: () => this.achievements.list().then((items) => items.filter((a) => a.unlocked)),
      // Unlock outright. Idempotent: a second call reports `alreadyUnlocked`
      // and keeps the original timestamp rather than rewriting it, so a game
      // that fires this on every frame cannot corrupt the player's history.
      unlock: (id) => this.request("POST", "/v1/achievements/unlock", { id: String(id || "") }),
      // Add to a named counter and unlock whatever the new total crosses.
      // Monotonic — progress only ever goes up — so a replayed report can
      // unlock something sooner but can never walk a target backwards.
      //
      // Call this at a checkpoint or at the end of a run, not per event: each
      // call is a round trip, and reporting "kills" once per kill would spend
      // the whole rate limit on one fight.
      progress: (stat, delta) =>
        this.request("POST", "/v1/achievements/progress", {
          stat: String(stat || ""),
          delta: delta == null ? 1 : Number(delta),
        }),
    };

    // A vanity address is the game's own name on tesana.ai — the thing a
    // creator puts on a poster. It is claimed and released by the site, and
    // the play service is where a label's owner is decided, so the mutating
    // calls are authenticated; the lookup is public because a game may want
    // to show its own link before anyone signs in.
    this.vanity = {
      // The host's answer, or `null` on a page with no host. Synchronous so a
      // title screen can print its own address without awaiting anything.
      public: () => this._vanityAddress || null,
      // What this game currently answers on, resolved server-side (which is
      // the only place that knows whether a label has moved on).
      //
      // `gameId` is required by the route and was missing here, so every call
      // was a 400 that `read` swallowed into the host's own answer — the
      // server was never actually asked. Sending it is what makes this a real
      // lookup rather than an echo of the bootstrap.
      current: () =>
        read(
          `/v1/vanity/current?gameId=${enc(this.gameId)}`,
          { address: this._vanityAddress || null },
        ).then((r) => r.address || this._vanityAddress || null),
      // Is this label free? Never throws; an unreachable service reports
      // `status: "unreachable"` so the UI can offer a retry rather than
      // claiming a name is taken.
      check: (label) => this._vanityCheck(label),
      // Claim it. Rejects with `code` on anything the player can fix:
      // `taken`, `reserved`, `invalid`, `login_required`.
      claim: (label) => this.request("POST", "/v1/vanity/claim", { label: String(label || "") }),
      // Point the game at a label it already owns, or at another label of
      // the player's. The server decides what is allowed.
      set: (label) => this.request("POST", "/v1/vanity/set", { label: String(label || "") }),
      release: () => this.request("POST", "/v1/vanity/release", {}),
      // Convenience for a "share your game" button: a candidate label the
      // player can edit, and the check that says whether it is free.
      suggest: (source) => {
        const label = slugify(source || "");
        const problem = vanityProblem(label);
        return { label, problem, valid: !problem };
      },
    };

    // Ads are the host's business, not ours: the network, the SDK key and
    // the consent screen all live in a window we do not control. A game asks
    // through this object and the host decides whether, when and what to
    // show. Nothing here ever draws an ad itself.
    this.ads = this._makeAds(opts);
    // Kept module-scoped so a bootstrap that lands later can re-point this
    // same object in place, rather than the game holding a stale policy.
    adClient = this.ads;

    // Localization. A generated game draws its text onto a canvas, so the
    // platform cannot translate the running game the way it translates the
    // site's own pages — the game has to ask, and this is the surface it asks
    // through. The same one rule as the shop: an unreachable service costs a
    // translation and never the game. Every method here has a source-language
    // answer, and `t()` is synchronous, so a menu never waits on a network to
    // draw itself in the player's language.
    this.l10n = this._makeL10n(opts);
    l10nClient = this.l10n;

    // Gameplay analytics. The same functions as `Tesana.track` and
    // `Tesana.gameplay` on the global, so a game can call them before its
    // `await __TESANA_READY__` resolves; none of them depends on this client.
    this.track = track;
    this.gameplay = gameplay;

    this.build = opts.build || "";
    this._launch = opts.launch || null;

    // Bug reports and crashes, to the creator. The host draws the form — like
    // a checkout, it is UI the game should not have to build — and the SDK
    // attaches the context: the last events, recent errors, the device, and
    // best effort a screenshot. Crashes are filed on their own; see
    // `installCrashCapture`.
    this.feedback = {
      // Ask the host to show its report form. Never rejects: resolves
      // `{ ok: true, reportId }` when a report was filed, or `{ ok: false,
      // reason }` — `no_host` (draw your own form and call submit), or
      // `cancelled`/`timeout`.
      open: (opts) => this._feedbackOpen(opts),
      // File a report from the game's own form: `{ kind, message, save? }`,
      // where kind is "bug", "idea" or "stuck". Rejects on failure, like other
      // writes, so the form can say it did not send.
      submit: (report) => this._feedbackSubmit(report, { screenshot: report?.screenshot !== false }),
    };

    // Remote config: values the creator changes without a rebuild. Fetched
    // once at boot and kept in localStorage, so `get` is synchronous and an
    // offline session reads what the last one saw.
    this._config = { ...cachedConfig(this.gameId), gameId: this.gameId, loaded: false, pending: null };
    this.config = {
      // The value, or `fallback` when it is unset — or when it is not the
      // same type as `fallback`, so a "3" typed where a number belongs cannot
      // turn a speed into a string.
      get: (key, fallback) => this._configGet(key, fallback),
      getAll: () => cloneJson(this._config.values),
      // Resolves once this session's values are in (or after a short wait,
      // with the cached ones). Optional: `get` works before it.
      ready: () => this._configReady(),
      reload: () => this._configLoad(),
    };

    // Invite links. `share()` asks the host to share a link that opens this
    // game where the player is; `share.params()` reads what an opened link
    // carried, so the game can join the room or jump to the level on boot.
    const share = (opts) => this._share(opts);
    share.params = () => this._shareParams();
    this.share = share;

    this.multiplayer = {
      // Read this before drawing a lobby: when it is false the game is not
      // allowed rooms yet and the calls below refuse.
      enabled: this._mpEnabled,
      // `_mpEnabled` alone is not enough. A game with no host has multiplayer
      // "allowed" and no service to ask, so `list()` used to reject with a
      // transport error — and a game that draws a lobby on load (which the
      // skill tells games to do) got an unhandled rejection on its title
      // screen. An empty lobby is the honest answer for a game that cannot
      // reach the room service, and it is what the game can render.
      list: () =>
        this._mpEnabled && (!this.offline || this._roomsOnly())
          ? this._mpRequest("GET", "/v1/mp/rooms")
              .then((r) => r.rooms)
              .catch(() => [])
          : Promise.resolve([]),
      // Open a room. It is public and always joinable unless you pass a `code`,
      // which is the only way entry is restricted: the room is then unlisted and
      // only someone with the code can reach it. The resolved code is on
      // `room.code` in the result (the service generates one if you pass
      // `code: true`), so show it to the room.
      create: (opts) =>
        this._mpEnabled
          ? this._mpEnter(this._mpRequest("POST", "/v1/mp/rooms", opts || {}))
          : this._mpRefuse(),
      // Accept the room a game got from list() as well as from a session. Both
      // read as "the room to join": `list()` rows are keyed `id`, a
      // create/quickJoin/join result carries `roomId`. Taking an object here is
      // what stops a lobby that calls `join(room)` from having to know which.
      join: (room) => {
        if (!this._mpEnabled) return this._mpRefuse();
        const roomId =
          room && typeof room === "object" ? room.id || room.roomId : room;
        // The bug this guards: a game read `room.roomId` off a list() row,
        // where it is undefined, and we asked the service for the room named
        // "undefined" — a 404 indistinguishable from a deleted room. Fail
        // here, by name, so the mistake is legible.
        if (roomId == null || roomId === "") {
          const err = new Error(
            "join() needs a room id — pass a room from list() (its `id`) or a create/join result",
          );
          err.code = "mp_room_id_required";
          return Promise.reject(err);
        }
        return this._mpEnter(
          this._mpRequest("POST", `/v1/mp/rooms/${enc(roomId)}/join`),
        );
      },
      // Join the fullest public room with a free seat, creating one if there is
      // none. Pass `code` to enter a private room instead: the first player to
      // use a code opens that room and the rest join it, and a full one refuses
      // rather than opening a second room under the same code.
      quickJoin: (opts) =>
        this._mpEnabled
          ? this._mpEnter(this._mpRequest("POST", "/v1/mp/quick-join", opts || {}))
          : this._mpRefuse(),
      send: (data) => this._mpSend(data),
      on: (fn) => this._mpOn(fn),
      // Connection status, separate from room messages: a game can show
      // "reconnecting" without mistaking it for something a player did.
      onStatus: (fn) => this._mpOnStatus(fn),
      leave: () => this._mpLeave(),
    };
  }

  async ensureSession() {
    // The site posted us a player and a token: that identity is authoritative
    // and there is nothing to mint. Minting here would be the guest-identity
    // bug again — the host's token is dropped and the grant goes unread.
    if (this._player && this.token) return this._player;
    if (this.offline) return this._player;
    if (this.token) {
      try {
        const me = await this.request("GET", "/v1/player/me");
        this._player = me.player;
        return this._player;
      } catch {
        this.token = "";
      }
    }
    const guest = await this.request("POST", "/v1/auth/guest", {
      gameId: this.gameId,
      deviceId: this.deviceId,
      rail: this.rail,
    });
    this.token = guest.token;
    this._player = guest.player;
    writeCache({ token: this.token, gameId: this.gameId });
    return this._player;
  }

  /**
   * Sign this device in to a Tesana account. Saves follow the account after this.
   *
   * The host does the signing in, exactly as `economy.signIn()` does. A game
   * cannot name the account: it runs in a page anyone can edit, so an id it
   * passed would let a player type a stranger's and take their wallet, and
   * the play service now refuses to link on a page's word. `identity` is still
   * accepted so older games keep working, and is ignored.
   * @param {{ tesanaUserId?: string, email?: string }} [_identity]
   */
  async login(_identity) {
    await this._signIn();
    return this._player;
  }

  /**
   * Buy a coin pack.
   *
   * When a Tesana page is above us it runs the whole thing — it opens
   * checkout in a window of its own, which is where a payment form belongs.
   * The game only asks. With no host (a game opened straight from the play
   * CDN) there is no page to open checkout on, so the standalone result is
   * returned as-is for the page to follow itself.
   * @param {string} packId
   * @param {{ clientRequestId?: string }} [opts]
   */
  async _topUp(packId, opts = {}) {
    // A desktop/Steam build buys through its store, not through a Tesana page.
    // `hasHost()` is false there (no parent frame) and Stripe is the wrong rail,
    // so store billing is checked first — its presence is what distinguishes a
    // storefront build from a page opened straight from the play CDN.
    const desktop = storeBilling();
    if (desktop) return this._topUpViaStore(desktop, packId);
    if (hasHost()) {
      // The host owns checkout: it opens Stripe in a window of its own and
      // tells us how it went. We only ask. The message names are the host's,
      // because the host is the side that already had a top-up flow — this SDK
      // used to post a name nobody listened for, which is why asking to buy
      // coins inside a game did nothing at all.
      post({ type: "tesana-topup-request", packId });
      return new Promise((resolve) => {
        let expiry = null;
        const finish = (result) => {
          window.removeEventListener("message", onMessage);
          if (expiry) clearTimeout(expiry);
          resolve(result);
        };
        function onMessage(event) {
          const msg = event.data;
          if (!msg || msg.type !== "tesana-topup-result") return;
          finish({ ok: true, purchased: msg.purchased === true, balance: msg.balance });
        }
        window.addEventListener("message", onMessage);
        // Declining is an answer too. A player who closed checkout should get
        // their shop back, not watch it wait out a timeout.
        expiry = setTimeout(() => finish({ ok: false, purchased: false, code: "timeout" }), CHECKOUT_TIMEOUT_MS);
      });
    }
    const result = await this.request("POST", "/v1/economy/top-up", {
      packId,
      clientRequestId: opts.clientRequestId,
    });
    return result;
  }

  /**
   * Buy a coin pack through the store this build ships on.
   *
   * Two halves, in this order for a reason: the store takes the money, and only
   * then does the play service turn the store's own transaction id into coins.
   * The id is the store's, not ours — it is the one thing a client cannot
   * invent twice, so it is what makes the credit idempotent when the purchase
   * is replayed after a crash. Reporting before a successful purchase would
   * credit coins for a purchase that never happened.
   *
   * The result is shaped like the web top-up: a purchase returns the new
   * balance, and a decline is `{ ok: false, code: "cancelled" }` rather than an
   * exception, because a player closing the store sheet is a normal answer.
   *
   * @param {any} desktop  `window.TesanaDesktop` with `storePurchase`
   * @param {string} packId
   */
  async _topUpViaStore(desktop, packId) {
    // Sign in *before* the store sheet, never after.
    //
    // Coins are account-scoped, so a player with no account has nothing to hold
    // them: `redeem` refuses an unlinked player, and a guest is exactly that.
    // On the web rail the refusal arrives harmlessly first, because the host
    // runs checkout server-side and no money has moved yet. Here the store
    // charges on this side of the wire, so a refusal discovered at redemption
    // is a player who was billed and got nothing — the one outcome worth
    // blocking a sale over. A launcher that cannot sign anyone in therefore
    // refuses the sale rather than taking payment it cannot honour.
    const canBuy = () => !this.offline && !this._isGuestSession();
    if (!canBuy()) {
      if (typeof desktop.signIn !== "function") {
        return { ok: false, purchased: false, code: "login_required" };
      }
      const answer = await this._signInViaNative(canBuy);
      if (!answer || answer.signedIn !== true) {
        return { ok: false, purchased: false, code: "login_required" };
      }
    }
    const purchase = await desktop.storePurchase({ packId });
    if (!purchase || purchase.ok !== true) {
      return {
        ok: false,
        purchased: false,
        code: (purchase && purchase.code) || "cancelled",
      };
    }
    // A store that charged but reported no id cannot be credited — there would
    // be no way to tell a replay from a new purchase. Surface it as a failure
    // rather than granting an untraceable lot.
    if (!purchase.transactionId) {
      const err = new Error("The store did not return a transaction id.");
      err.code = "no_transaction_id";
      throw err;
    }
    return this.request("POST", "/v1/economy/redeem", {
      rail: this.rail,
      packId,
      transactionId: purchase.transactionId,
    });
  }

  _mpRefuse() {
    const err = new Error("Multiplayer is not available for this game yet");
    err.code = "multiplayer_disabled";
    return Promise.reject(err);
  }

  /**
   * @param {Promise<{ wsUrl: string, roomId?: string, room?: object, playerId?: string }>} session
   */
  async _mpEnter(session) {
    const joined = await this._mpAwaitPlacement(await session);
    // A room that was opened and then could not be entered is reported as what
    // it is: the room exists. The SDK cannot seat the player — that is the
    // host's job — but it can name the room so a game retries `join(roomId)`
    // instead of opening a second one and stranding the first.
    try {
      await this._mpOpen(joined.wsUrl);
    } catch (err) {
      const roomId = joined.roomId || joined.room?.id || null;
      const wrapped = new Error(
        roomId ? `${err?.message || "multiplayer unavailable"} (room ${roomId})` : err?.message || "multiplayer unavailable",
      );
      wrapped.code = err?.code || "mp_enter_failed";
      wrapped.roomId = roomId;
      throw wrapped;
    }
    this._mp.roomId = joined.roomId || joined.room?.id || null;
    this._mp.code = joined.room?.code || null;
    return {
      wsUrl: joined.wsUrl,
      roomId: this._mp.roomId,
      code: this._mp.code,
      playerId: joined.playerId || this._player?.id,
      room: joined.room,
    };
  }

  /**
   * Wait out a room that is still being placed, then hand back its session.
   *
   * Room creation on GameLift outlives a single HTTP request — a cold fleet can
   * take minutes — so the service answers 202 with the room's identity, the
   * caller's seat, and `retryAfterMs`, and no `wsUrl`. Treating that as a failed
   * create is what used to leave a ghost: the room existed, its creator was
   * seated, and the client believed nothing had happened. So the client polls
   * the same room it was handed (`join` re-issues the seat, it does not take a
   * second) until the address exists or the wait budget runs out.
   *
   * The budget is the client's own. A game that would rather show a spinner and
   * decide for itself calls `join(roomId)` after `create` rejects with
   * `mp_room_placing`, and this consumes the same code path.
   *
   * @param {{ wsUrl?: string, roomId?: string, state?: string, retryAfterMs?: number, room?: object }} session
   */
  async _mpAwaitPlacement(session) {
    if (!session || session.wsUrl || session.state !== "placing") return session;
    const roomId = session.roomId || session.room?.id;
    if (!roomId) return session;
    this._mpEmitStatus({ status: "placing", roomId });
    // Instance-overridable so a game (or a test) can decide how long it will
    // wait for placement without reaching into module scope.
    const budget = Number(this._mpPlacingTimeoutMs) || MP_PLACING_TIMEOUT_MS;
    const deadline = Date.now() + budget;
    let current = session;
    while (!current?.wsUrl && Date.now() < deadline) {
      const gap = Math.max(250, Number(current.retryAfterMs) || MP_PLACING_RETRY_MS);
      await new Promise((resolve) => setTimeout(resolve, Math.min(gap, Math.max(0, deadline - Date.now()))));
      if (Date.now() >= deadline) break;
      try {
        current = await this._mpRequest("POST", `/v1/mp/rooms/${enc(roomId)}/join`, {});
      } catch (err) {
        // A 404 here is a room that ended between polls, which is a real
        // failure; anything else is worth another try until the budget is gone.
        if (err?.status === 404) throw err;
      }
    }
    if (!current?.wsUrl) {
      // The room is still real, so the code names it and says so — a game can
      // choose to keep waiting with `join(roomId)` rather than start over.
      const err = new Error("Room is still starting");
      err.code = "mp_room_placing";
      err.roomId = roomId;
      throw err;
    }
    return current;
  }

  /**
   * @param {string} wsUrl
   */
  _mpOpen(wsUrl) {
    if (typeof WebSocket === "undefined") {
      throw new Error("Tesana.multiplayer requires WebSocket");
    }
    this._mpClose();
    // Reconnecting is re-entering the same room, so the URL is kept. The
    // grant inside it is checked by the room host, which is what lets a
    // client recover from a scale-in without going back through the lobby.
    this._mp.wsUrl = wsUrl;
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      this._mp.ws = ws;
      let opened = false;
      const timer = setTimeout(() => {
        if (!opened) {
          this._mpClose();
          reject(new Error("multiplayer connect timeout"));
        }
      }, 8000);
      ws.onmessage = (event) => {
        let msg;
        try {
          msg = JSON.parse(String(event.data));
        } catch {
          return;
        }
        if (msg?.t === "hello" && !opened) {
          opened = true;
          clearTimeout(timer);
          // A reconnect that got its hello is a recovered session: clear the
          // attempt counter so a later blip starts from a short delay again,
          // and tell the game it is back.
          if (this._mp.reconnectAttempts > 0) {
            this._mpEmitStatus({ status: "reconnected" });
          }
          this._mp.reconnectAttempts = 0;
          resolve(msg);
        }
        for (const fn of this._mp.handlers) {
          try {
            fn(msg);
          } catch {
            /* game handler */
          }
        }
      };
      ws.onerror = () => {
        if (!opened) {
          /* onclose rejects */
        }
      };
      ws.onclose = (event) => {
        if (this._mp.ws === ws) this._mp.ws = null;
        if (!opened) {
          clearTimeout(timer);
          const err = new Error(event.reason || "multiplayer closed");
          // The code is carried, not just the reason: 4401 is an expired or
          // rejected grant, which a re-mint can fix, while 4403 is the game
          // being denied rooms, which it cannot. Recovery keys off this.
          err.code = event.code || 1006;
          // Recorded for the same reason: a reconnect whose fresh grant is
          // *also* refused must mint again rather than retry a dead URL.
          if (this._mp.wsUrl) this._mp.lastCloseCode = event.code || null;
          reject(err);
          return;
        }
        // The socket dropped after we were in the room. That is a scale-in,
        // a deploy, or a network blip — none of which the player caused, and
        // all of which used to leave them silently alone in a match. Retry
        // unless they actually meant to leave.
        this._mp.lastCloseCode = event.code || null;
        this._mpScheduleReconnect();
      };
    });
  }

  /**
   * Try to get back into a room we were dropped out of.
   *
   * Jittered exponential backoff, capped, and bounded in attempts: jitter
   * because a scale-in drops every player at the same instant and un-jittered
   * retries would arrive as one synchronized spike at the very moment the
   * fleet is least able to take it. Bounded because a room that really is
   * gone should stop being retried and say so.
   */
  _mpScheduleReconnect() {
    const mp = this._mp;
    if (!mp.wsUrl || mp.leaving) return;
    if (mp.reconnectTimer) return;
    const attempts = (mp.reconnectAttempts || 0) + 1;
    mp.reconnectAttempts = attempts;
    if (attempts > mp.reconnectMaxAttempts) {
      mp.reconnectExhausted = true;
      this._mpEmitStatus({ status: "disconnected", reason: "reconnect_exhausted" });
      return;
    }
    this._mpEmitStatus({ status: "reconnecting", attempt: attempts });
    const base = Math.min(mp.reconnectMaxMs, mp.reconnectBaseMs * 2 ** (attempts - 1));
    const delay = base * (0.5 + Math.random() * 0.5);
    mp.reconnectTimer = setTimeout(() => {
      mp.reconnectTimer = null;
      if (mp.leaving) return;
      this._mpReconnectAttempt().catch(() => {
        // Still not up — schedule the next attempt, which is where the
        // attempt count grows and the backoff widens.
        this._mpScheduleReconnect();
      });
    }, delay);
  }

  /**
   * One reconnect: get a current grant if the last one was refused, then try the
   * room again.
   *
   * The grant the client holds is embedded in `wsUrl` and was minted when it
   * first joined. A game open longer than the token's life therefore cannot
   * re-enter on a reconnect, and the backoff above only retries the same dead
   * URL — the player sits in "reconnecting" until they reload. Re-requesting the
   * room session mints a fresh URL, and `mpJoin` is idempotent, so asking as an
   * already-seated player re-issues the same seat rather than a second one.
   *
   * The fresh grant itself comes from the ordinary 401 path in `_send`: the join
   * goes out with the token the client already has, comes back refused, and is
   * retried once with one minted token. That is deliberate — it keeps the mint in
   * the one place that knows how to do it, so a stale socket and a stale HTTP
   * call recover identically and only ever ask the host once between them.
   */
  async _mpReconnectAttempt() {
    const mp = this._mp;
    let wsUrl = mp.wsUrl;
    // 4401 — the grant was refused, so the URL itself is dead and a fresh one is
    // required. 4409 — the room is being re-placed and has no address yet, so
    // the URL the client holds is not usable either. Both are fixed by asking
    // for the room again; 4403 (the game is denied rooms) and 4404 (the room is
    // gone) are not, and fall through to the URL we have so the attempt is still
    // counted and the backoff still applies.
    if ((mp.lastCloseCode === 4401 || mp.lastCloseCode === 4409) && mp.roomId) {
      try {
        // `_mpAwaitPlacement` is harmless when the room is already up (it
        // returns the session untouched) and necessary when a reconnect lands
        // during a re-placement — a 4409 close, or a room swept and reopened,
        // answers with no `wsUrl`, and retrying the old URL would never work.
        const session = await this._mpAwaitPlacement(
          await this._mpRequest("POST", `/v1/mp/rooms/${enc(mp.roomId)}/join`),
        );
        if (session && session.wsUrl) {
          wsUrl = session.wsUrl;
          mp.wsUrl = wsUrl;
          mp.code = session.room?.code ?? mp.code;
        }
      } catch {
        // The room is gone, or the fresh grant was refused too. Fall through to
        // the URL we have: the room may have been replaced under the same id,
        // and if it has not, the next attempt retries this same path.
      }
    }
    mp.lastCloseCode = null;
    return this._mpOpen(wsUrl);
  }

  _mpEmitStatus(status) {
    for (const fn of this._mp.statusHandlers) {
      try {
        fn(status);
      } catch {
        /* game handler */
      }
    }
  }

  _mpClose() {
    const ws = this._mp.ws;
    this._mp.ws = null;
    if (this._mp.reconnectTimer) {
      clearTimeout(this._mp.reconnectTimer);
      this._mp.reconnectTimer = null;
    }
    if (!ws) return;
    ws.onmessage = null;
    ws.onerror = null;
    ws.onclose = null;
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  }

  /**
   * @param {object} data
   */
  _mpSend(data) {
    const ws = this._mp.ws;
    if (!ws || ws.readyState !== 1) {
      // Not a room failure — a socket that is between attempts. Tagged so a
      // game can tell it from a real refusal, and so a caller that has an
      // outbox can wait for the reconnect rather than drop the message.
      const err = new Error("Not in a room");
      err.code = "mp_not_connected";
      throw err;
    }
    ws.send(JSON.stringify(data && typeof data === "object" ? data : { value: data }));
  }

  /**
   * @param {(msg: object) => void} fn
   */
  _mpOn(fn) {
    if (typeof fn !== "function") throw new Error("tesana.multiplayer.on requires a function");
    this._mp.handlers.push(fn);
    return () => {
      this._mp.handlers = this._mp.handlers.filter((handler) => handler !== fn);
    };
  }

  /**
   * @param {(status: { status: string, reason?: string }) => void} fn
   */
  _mpOnStatus(fn) {
    if (typeof fn !== "function") throw new Error("tesana.multiplayer.onStatus requires a function");
    this._mp.statusHandlers.push(fn);
    return () => {
      this._mp.statusHandlers = this._mp.statusHandlers.filter((handler) => handler !== fn);
    };
  }

  async _mpLeave() {
    const roomId = this._mp.roomId;
    // Set before closing: `onclose` fires synchronously on `close()`, and
    // without this flag a deliberate leave would look like a dropped socket
    // and schedule a reconnect into the room the player just left.
    this._mp.leaving = true;
    this._mpClose();
    this._mp.roomId = null;
    this._mp.code = null;
    this._mp.wsUrl = null;
    this._mp.reconnectAttempts = 0;
    this._mp.reconnectExhausted = false;
    this._mp.lastCloseCode = null;
    try {
      if (!roomId) return { ok: true, room: null };
      try {
        return await this._mpRequest("POST", `/v1/mp/rooms/${enc(roomId)}/leave`);
      } catch {
        return { ok: true, room: null };
      }
    } finally {
      this._mp.leaving = false;
    }
  }

  /**
   * @param {string} method
   * @param {string} path
   * @param {object} [body]
   */
  request(method, path, body) {
    return this._send(this._baseFor(), this._authFor(), method, path, body);
  }

  /** One transport attempt, with no retry and no body parsing. */
  async _fetchSend(base, authToken, method, path, body) {
    const headers = { "content-type": "application/json" };
    if (authToken) headers.authorization = `Bearer ${authToken}`;
    if (this.deviceId) headers["x-tesana-device"] = this.deviceId;
    try {
      return await fetch(`${base}${path}`, {
        method,
        headers,
        body: body == null || method === "GET" ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      // No cache fallback here. `_dbGet` owns the local-cache behaviour for
      // saves, keyed by the bare key; this generic transport path would have
      // to re-derive that key from the URL, and getting it wrong returns a
      // confident `null` that pre-empts the real fallback — a save the player
      // still has, reported as missing.
      throw err;
    }
  }

  /** Whether multiplayer rides a rooms-only token while everything else is offline. */
  _roomsOnly() {
    return Boolean(this.offline && this.roomEndpoint && this.roomToken);
  }

  _mpRequest(method, path, body) {
    return this._roomsOnly()
      ? this._send(this.roomEndpoint, this.roomToken, method, path, body)
      : this.request(method, path, body);
  }

  async _send(base, authToken, method, path, body) {
    let res = await this._fetchSend(base, authToken, method, path, body);
    // A refused credential is usually age, not refusal: the player token lives
    // two hours. Ask the host to re-mint and retry once with the new one. The
    // retry is guarded on the token actually changing, so a genuinely
    // unauthorized player fails exactly as they did before rather than looping.
    if (res.status === 401) {
      // The ask may land on a host we cannot reach, so `asked` is null and the
      // retry is skipped — the 401 below is thrown exactly as it always was.
      const asked = await requestHostBootstrap();
      const next = base === this.roomEndpoint ? this.roomToken : this._authFor();
      if (asked && next && next !== authToken) {
        res = await this._fetchSend(base, next, method, path, body);
      }
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const error = new Error(data.message || res.statusText);
      error.code = data.error;
      error.status = res.status;
      // The finer cause, when the service gives one: `room_limit` or
      // `seat_limit` on a refused `multiplayer.create`, so a game can say
      // "room limit reached" instead of parsing the message.
      if (data.reason) error.reason = data.reason;
      // A conditional save that lost carries what is stored now.
      if (data.current && typeof data.current === "object") error.current = data.current;
      throw error;
    }
    return data;
  }

  /**
   * Re-point this client at a newer host answer, in place.
   *
   * The game holds a reference to this object, so an upgrade must never
   * replace it. This is what turns a provisional "offline" bootstrap into a
   * real one: without it a signed-in player's token arrives and is dropped,
   * and the only symptom is a wallet that never leaves zero.
   */
  configure(config) {
    this.endpoint = String(config.endpoint || "").replace(/\/$/, "");
    this.gameId = config.gameId ?? "";
    this.token = config.token || "";
    this.saveEndpoint = String(config.saveEndpoint || "").replace(/\/$/, "");
    this.saveToken = config.saveToken || "";
    this.saveServiceNamed = Boolean(config.saveServiceNamed);
    if (!this.saveServiceNamed && this.endpoint && !this.saveEndpoint) {
      this.saveEndpoint = this.endpoint;
      this.saveToken = this.token;
    }
    this.canSaveToCloud = Boolean(this.saveEndpoint && this.saveToken);
    this.offline = Boolean(config.offline) || !this.endpoint || !this.gameId;
    this.roomEndpoint = String(config.roomEndpoint || "").replace(/\/$/, "");
    this.roomToken = config.roomToken || "";
    if (config.player) this._player = config.player;
    if (config.vanityAddress !== undefined) {
      this._vanityAddress = config.vanityAddress ? String(config.vanityAddress) : null;
    }
    if (this.ads && ("adsEnabled" in config || "adFormats" in config)) {
      this.ads.applyPolicy({
        enabled: Boolean(config.adsEnabled),
        formats: config.adFormats,
        minIntervalMs: config.adMinIntervalMs,
      });
    }
    // A later bootstrap may carry the player's language — a provisionally
    // "offline" answer has none, and the real one arrives a moment later. The
    // capability is re-pointed in place, exactly as the ad policy is.
    if (config.locale && this.l10n) {
      const next = normalizeLocale(config.locale);
      if (next && next !== this.l10n.locale()) this.l10n.applyLocale(next);
    }
    this._mpEnabled = config.multiplayer !== false;
    this.multiplayer.enabled = this._mpEnabled;
    if (config.build) this.build = config.build;
    if (config.launch) this._launch = config.launch;
    return this;
  }

  /**
   * Carry on without the play service.
   *
   * The boot path calls this when the identity step fails — an unreachable
   * endpoint, a 500, a bad secret, a cert the browser will not accept. A game
   * must not die of it: the server side of this contract already returns no
   * token and lets the game run, so the client falls back to exactly the state
   * a game with no endpoint is in.
   *
   * Marking the client offline is the honest outcome rather than a silent
   * swallow. Every read already has an offline answer — `balance()` reports
   * zero coins and `canSpend: false`, the shop reports a shut shutter, saves
   * read as absent and write to the local cache — so the game draws its
   * title screen instead of throwing. A later bootstrap upgrade re-runs the
   * identity step and flips this back off.
   *
   * The token is cleared rather than kept: it is the thing that failed to
   * authenticate, and half an identity is worse than none — every call would
   * retry a credential the service just refused.
   *
   * @param {unknown} [reason] the failure, kept for diagnostics
   */
  goOffline(reason) {
    this.offline = true;
    this.token = "";
    this.saveToken = "";
    this.canSaveToCloud = false;
    this._mpEnabled = false;
    this.multiplayer.enabled = false;
    // One deduped line rather than a wall: a page whose endpoint is
    // misconfigured would otherwise log this on every call.
    warnOnce(
      "play-session",
      `[tesana] play service unavailable; running without cloud saves or the shop${
        reason ? ` (${(reason && reason.message) || reason})` : ""
      }`,
    );
    return this;
  }

  /**
   * Which origin and which credential a path uses.
   *
   * A Tesana page gives the save service its own address and token; a room
   * build bakes one `endpoint` that is the save service and one token. Both
   * collapse to `_baseFor` / `_authFor` here so no call site has to know which
   * shape it is running in.
   */
  _baseFor() {
    return this.saveEndpoint || this.endpoint;
  }

  _authFor() {
    return this.saveEndpoint ? this.saveToken : this.token;
  }

  /**
   * Whether a call has somewhere to go at all.
   *
   * A game opened outside a Tesana page — or a build nothing ever answered —
   * has no address, and `fetch` on a relative URL throws. Reads check this and
   * answer empty; that is what keeps a shop drawing on a hostless page instead
   * of taking the menu down with it.
   */
  _canReach() {
    return Boolean(this._baseFor() && this.gameId);
  }

  /**
   * This game's shelf, and whether we actually reached it.
   *
   * `status` is `ok`, `empty` (the server genuinely sells nothing here — do
   * not retry), `no_host` (nothing was ever handed to this page), or
   * `unreachable` (show a retry). Reads never reject; a shop that cannot be
   * priced must not take the menu down with it.
   */
  async _shopRead() {
    if (!this._canReach()) {
      warnOnce(
        "shop-no-host",
        "Tesana shop: nothing to ask — this game was not handed an API address."
          + " Running outside a Tesana page does that; so does a page that never"
          + " answered the bootstrap request.",
      );
      return { status: "no_host", items: [] };
    }
    try {
      const data = await this.request("GET", "/v1/shop/catalog");
      const items = Array.isArray(data?.items) ? data.items : [];
      if (!items.length) {
        // The one that earns its keep: an empty shelf and a catalogue nobody
        // declared look identical from inside a game, and this names the file
        // to fix. It is the runtime half of the build's empty-trader gate.
        warnOnce(
          "shop-empty",
          "Tesana shop: the server sells nothing for this game. If it is meant"
            + " to, the build has to declare its items in assets/ui/shop.json —"
            + " the server only sells what it was told about.",
        );
        return { status: "empty", items: [] };
      }
      return { status: "ok", items };
    } catch (err) {
      warnOnce(
        "shop-unreachable",
        `Tesana shop: could not reach the shop (${(err && err.message) || "request failed"}).`
          + " The game keeps playing; nothing is purchasable until it answers.",
      );
      return { status: "unreachable", items: [] };
    }
  }

  // ------------------------------------------------------------------ vanity
  //
  // A game's own address. The claim and the lookup both belong to the site
  // and the play service; this is only the game's side of it. Checks never
  // throw, because a name field that reports "taken" when the network is
  // down is worse than one that says "try again".
  //
  // The check is strict about the label itself — it does not rewrite what the
  // player typed. Turning a phrase into a candidate is `suggest()`'s job, and
  // the two are deliberately separate: silently hyphenating what someone
  // asked for is how a player ends up owning a name they did not choose.
  async _vanityCheck(label) {
    const candidate = String(label || "").trim().toLowerCase();
    const problem = vanityProblem(candidate);
    if (problem) return { label: candidate, status: problem, available: false };
    if (!this._canReach()) return { label: candidate, status: "no_host", available: false };
    try {
      const data = await this.request("GET", `/v1/vanity/available/${enc(candidate)}`);
      return {
        label: candidate,
        status: "ok",
        available: Boolean(data?.available),
      };
    } catch {
      return { label: candidate, status: "unreachable", available: false };
    }
  }

  // --------------------------------------------------------------------- ads
  //
  // A thin, honest wrapper around the host. The policy (whether ads run, how
  // often, which formats) is the host's and arrives in the bootstrap; the
  // network key and the consent screen never cross into the frame. A game can
  // therefore rely on one rule: if `ads.enabled()` is false, nothing will ever
  // be shown, and it should not pretend otherwise.
  _makeAds(opts) {
    const state = {
      enabled: Boolean(opts.adsEnabled),
      formats: Array.isArray(opts.adFormats) ? opts.adFormats.slice() : [],
      minIntervalMs:
        opts.adMinIntervalMs == null ? 180000 : Math.max(0, Number(opts.adMinIntervalMs) || 0),
      lastShownAt: 0,
      pending: new Map(),
      seq: 0,
    };
    const self = this;

    function applyPolicy(policy) {
      if (!policy || typeof policy !== "object") return state;
      if ("enabled" in policy) state.enabled = Boolean(policy.enabled);
      if (Array.isArray(policy.formats)) state.formats = policy.formats.slice();
      if (policy.minIntervalMs != null) {
        state.minIntervalMs = Math.max(0, Number(policy.minIntervalMs) || 0);
      }
      return state;
    }

    return {
      // Live state, for a menu that wants to show "no ads on this account".
      get enabled() {
        return state.enabled;
      },
      formats: () => state.formats.slice(),
      /** May the host show something of this format right now? */
      ready: (format) => {
        if (!state.enabled) return false;
        if (Date.now() - state.lastShownAt < state.minIntervalMs) return false;
        return !format || state.formats.length === 0 || state.formats.includes(format);
      },
      /**
       * Ask the host to show an ad. Resolves `{ shown, format, reason }` and
       * never rejects: an ad that did not run is a normal answer, not an
       * error the player must see. `reason` is one of `disabled`,
       * `too_soon`, `unsupported`, `declined`, `no_host`, `error`.
       */
      show: (format, context) => {
        const wanted = format || "interstitial";
        if (!state.enabled) return Promise.resolve({ shown: false, format: wanted, reason: "disabled" });
        if (Date.now() - state.lastShownAt < state.minIntervalMs) {
          return Promise.resolve({ shown: false, format: wanted, reason: "too_soon" });
        }
        if (state.formats.length && !state.formats.includes(wanted)) {
          return Promise.resolve({ shown: false, format: wanted, reason: "unsupported" });
        }
        const requestId = `ad_${Date.now().toString(36)}_${(state.seq += 1)}`;
        return new Promise((resolve) => {
          const finish = (result) => {
            state.pending.delete(requestId);
            // Record the attempt either way: a host that declined should not
            // be asked again on the very next frame.
            state.lastShownAt = Date.now();
            reportAdToHost({ requestId, format: wanted, ...result });
            resolve({ format: wanted, ...result });
          };
          state.pending.set(requestId, finish);
          requestAdFromHost(requestId, wanted, context);
          // No host above us, or one that never answers. Ten seconds is long
          // enough for a real network fill and short enough not to stall a
          // game waiting at a level boundary.
          setTimeout(
            () => state.pending.has(requestId) && finish({ shown: false, reason: "no_host" }),
            10000,
          );
        });
      },
      // ---- internal wiring (used by the bootstrap listener) ----
      applyPolicy,
      settle(requestId, message) {
        const finish = state.pending.get(requestId);
        if (!finish) return;
        const shown = Boolean(message.shown);
        finish({ shown, reason: message.reason || (shown ? "ok" : "declined") });
      },
    };
  }

  // -------------------------------------------------------------------- l10n
  //
  // Localization, from the game's side. The service owns the dictionary and the
  // translation; this owns one promise: a game that asks for its text in the
  // player's language gets something renderable, always.
  //
  // Deliberately synchronous where the game needs it to be. `t()` reads a map
  // that was filled before the first frame, so drawing a localized menu costs no
  // await and no round trip; only text the game discovers at runtime — a
  // procedurally generated item name, something the player typed — goes through
  // the async path. A game that never awaits anything still localizes.
  _makeL10n(opts) {
    const state = {
      locale: normalizeLocale(opts.locale || ""),
      // The language the game's own strings are written in. Declared by the
      // build; the service is told the same value, so the two agree rather
      // than one guessing what the other meant.
      source: "en",
      // The platform's list, refined by the service's answer when it arrives.
      languages: L10N_TARGETS.slice(),
      // Source text -> translated text, filled before `ready` resolves.
      bundle: {},
      // The game's own key -> source text, for `t("ui.play")`.
      index: {},
      handlers: [],
      // `requested`: what the game's source language resolved to (en, de, …)
      // vs `target`: what is actually being served — the difference is a
      // language the game did not declare, where the source is the answer.
      target: "",
      loaded: false,
      // The bundle is asked for from three places on a normal boot — `ready`,
      // `init`'s await, and the post-session reload — and all three want the
      // same one. `inflight` is the shared request; `loadedFor` is the target
      // that has already been answered, so a repeat is a no-op rather than a
      // second round trip for an object we already hold.
      inflight: null,
      inflightTarget: "",
      loadedFor: null,
    };

    const self = this;

    /** Emit a locale change to every listener, without letting one break the rest. */
    function emit() {
      const event = { locale: state.locale, target: state.target, languages: state.languages.slice() };
      for (const fn of [...state.handlers]) {
        try {
          fn(event);
        } catch {
          /* a game handler */
        }
      }
    }

    /**
     * Resolve `key` against the bundle.
     *
     * Three shapes, because a game reaches for all three: a key it declared
     * (`"ui.play"`), the source sentence itself (`"Play"`), and a key with a
     * fallback for the source text that was never declared. Whatever is not
     * found comes back as the fallback or the key, which is what makes an
     * unreachable service a non-event.
     */
    function lookup(key, fallback) {
      const name = String(key == null ? "" : key);
      const source = state.index[name] || name;
      const hit = state.bundle[source];
      if (typeof hit === "string" && hit) return hit;
      if (typeof fallback === "string" && fallback) return fallback;
      return source;
    }

    /**
     * Load the bundle, at most once per (language, reachability) combination.
     *
     * A boot calls this from several independent places — the `ready` promise,
     * `init`'s await, and the post-session `reload` — and they all want the
     * same bundle. Coalescing them is not an optimization for its own sake:
     * every extra request is the player's bundle fetched twice, and a game
     * that redraws on `onChange` should not be able to multiply it.
     */
    function load() {
      const target = self._canReach() && state.locale && state.locale !== state.source ? state.locale : "";
      if (state.inflight && state.inflightTarget === target) return state.inflight;
      if (state.loadedFor === target && state.loaded) return Promise.resolve(state);
      state.inflightTarget = target;
      state.inflight = fetchBundle(target).finally(() => {
        state.inflight = null;
      });
      return state.inflight;
    }

    async function fetchBundle(target) {
      if (!self._canReach()) {
        // No address, or no game id: nothing will ever answer, and asking
        // anyway would throw a relative-URL fetch. The source language is the
        // honest answer and the game renders exactly as it always did.
        state.loaded = true;
        state.loadedFor = target;
        return state;
      }
      try {
        if (!target) {
          // Nothing to fetch — and no request at all, either. A source-language
          // boot needs no bundle (nothing is translated) and no language list
          // (the platform's known set is already in memory), so a game with no
          // localization in force makes zero localization requests. That
          // matters beyond tidiness: it is the same rule as the rest of the
          // SDK, that a capability nobody asked for must not put bytes on the
          // wire, and it is what a game running entirely offline relies on.
          state.target = "";
          state.loaded = true;
          state.loadedFor = target;
          return state;
        }
        const data = await self.request(
          "GET",
          `/v1/l10n/bundle?target=${enc(target)}`,
        );
        if (data && typeof data.translations === "object" && data.translations) {
          state.bundle = data.translations;
        }
        if (data && typeof data.index === "object" && data.index) {
          state.index = data.index;
        }
        if (typeof data?.source === "string" && data.source) state.source = data.source;
        // `target` is the service's answer about what it actually served.
        // It is `""` for a language this game has not declared, which is the
        // signal that the source text IS the answer.
        state.target = typeof data?.target === "string" && data.target ? data.target : "";
        // The declared language set arrives with the bundle's own response
        // rather than a second route. It is one fact about one game, and two
        // requests to learn it is one more chance for a boot to be slower than
        // the first frame.
        if (Array.isArray(data?.languages) && data.languages.length) {
          // The game's own declared set, in the order it chose — which is how
          // a game that lists French first gets French first in its picker.
          state.languages = data.languages.slice();
        }
      } catch (err) {
        // An outage costs the translation, not the game. One deduped line is
        // enough to make it findable without spamming the console on retry.
        warnOnce(
          "l10n-unreachable",
          `Tesana localization: could not reach the translation service (${(err && err.message) || "request failed"}).`
            + " The game keeps playing in its source language.",
        );
      }
      state.loaded = true;
      state.loadedFor = target;
      return state;
    }

    return {
      /**
       * The player's language, synchronously, as the host resolved it.
       *
       * Follows the same tag vocabulary the site uses (`pt-BR`, `zh`), not
       * AWS's, so a game can pass it straight to `Intl`/`toLocaleString`.
       */
      locale: () => state.locale,
      /** The languages this game offers, the host's order preserved. */
      languages: () => state.languages.slice(),
      /** The language text is actually being served in, or `""` when it is the source. */
      target: () => state.target,
      /** The language the game's own strings are written in. */
      source: () => state.source,
      /** Whether the initial bundle has landed. `t()` works before it does. */
      get loaded() {
        return state.loaded;
      },

      /**
       * The translated text for `key`, synchronously.
       *
       * Prefer this. It is filled before the first frame, so a game never has
       * to await anything to draw a localized menu — and when the bundle is
       * empty (a service outage, a language the game never declared) it returns
       * the source text, which is a rendered game rather than a blank one.
       *
       * @param {string} key  a declared key, or the source sentence itself
       * @param {object|string} [vars]  `{name}` values, or a fallback string
       */
      t: (key, vars) => {
        // The second argument is both of the things a caller wants to pass:
        // placeholder values, and a fallback for an undeclared key. A string is
        // unambiguously a fallback; an object is unambiguously values.
        const values = vars && typeof vars === "object" ? vars : null;
        const fallback = typeof vars === "string" ? vars : "";
        return fillPlaceholders(lookup(key, fallback), values);
      },

      /**
       * Translate text the game discovered while running.
       *
       * The one path that costs a round trip, so it is the one to keep off the
       * hot path: ask once, at the moment the text is created (a generated
       * name, a line of dialogue just chosen), never per frame. Resolves the
       * source text on any failure, so a `.then` never sees a rejection.
       *
       * @param {string} text
       * @param {{ id?: string, values?: Record<string, unknown>, target?: string }} [opts]
       */
      translate: async (text, opts = {}) => {
        const values = opts.values && typeof opts.values === "object" ? opts.values : null;
        const target = opts.target || state.target || (state.locale !== state.source ? state.locale : "");
        // A named string is routed through the id-keyed path, which is what
        // lets the service remember it under the game's own name and serve it
        // from cache next time without even a hash lookup.
        if (opts.id && self._canReach() && target) {
          try {
            const data = await self.request("POST", "/v1/l10n/string", {
              id: String(opts.id),
              text: String(text == null ? "" : text),
              values: values || undefined,
              target,
              source: state.source,
            });
            if (data && typeof data.value === "string" && data.value) return data.value;
          } catch {
            /* falls through to the source text below */
          }
        }
        // The anonymous path requires a target to be worth a call. With no
        // target this *is* the source language, and asking the server to hand
        // back what it was given is the most expensive no-op available.
        if (self._canReach() && target) {
          try {
            const data = await self.request("POST", "/v1/l10n/translate", {
              strings: [String(text == null ? "" : text)],
              target,
              source: state.source,
            });
            const hit = data?.translations?.[String(text)];
            if (typeof hit === "string" && hit) return fillPlaceholders(hit, values);
          } catch {
            /* ditto */
          }
        }
        return fillPlaceholders(String(text == null ? "" : text), values);
      },

      /**
       * Subscribe to a language change. Returns an unsubscribe function.
       *
       * A game should redraw its text (or call `t()` again) on this rather than
       * caching translated strings at startup, because the player can change
       * the site's language without reloading the frame.
       *
       * @param {(event: { locale: string, target: string, languages: string[] }) => void} fn
       */
      onChange: (fn) => {
        if (typeof fn !== "function") return () => {};
        state.handlers.push(fn);
        return () => {
          state.handlers = state.handlers.filter((handler) => handler !== fn);
        };
      },

      /** Resolves after the initial bundle. A game may await it with `__TESANA_READY__`. */
      ready: load(),

      /**
       * Reload the bundle, after an identity or language change.
       *
       * The constructor loads immediately from whatever the page already
       * carries. A game that minted its own token — or a host whose real
       * bootstrap replaced a provisional "offline" one — has no credential that
       * first time, so the bundle would be empty and the game would stay in its
       * source language for the whole session. `init` awaits this after the
       * identity step, which is what makes the documented
       * `await window.__TESANA_READY__` sufficient for a localized first frame.
       */
      reload: () => load(),

      // ---- internal wiring (used by the bootstrap listener) ----
      /** A new language from the host. Resolves the same promise the game already holds. */
      applyLocale(next) {
        const locale = normalizeLocale(next);
        if (!locale || locale === state.locale) return state;
        state.locale = locale;
        // The old bundle is the *previous* language's, so it is cleared rather
        // than left to serve: showing a menu in a language the player just
        // switched away from is worse than showing the source text for the
        // moment the refill takes. `t()` falls back to source in between.
        state.bundle = {};
        state.target = "";
        emit();
        load().catch(() => {});
        return state;
      },
    };
  }

  // ------------------------------------------------------------------ saves
  //
  // Writes go to this game's local cache first, always, so a failed upload is
  // a save that has not synced yet rather than a save the player has lost.
  // Reads fall back to the local copy when the service is unreachable, and
  // never replace a local value the cloud has not confirmed (see the cache
  // notes at `dbCacheKey`).
  //
  //   get(key)                       → value (null when missing)
  //   get(key, { withVersion: true }) → { value, version }
  //   set(key, value)                → value; never rejects (syncs later)
  //   set(key, value, { ifVersion }) → { version }; rejects `version_conflict`
  //                                    (err.current) or `offline`
  //   delete(key)                    → { deleted: true } (soft delete)
  _dbLocal(key) {
    const entry = readDbCache(this.gameId).keys[key];
    return entry && typeof entry === "object" ? entry : null;
  }

  _dbView(entry, withVersion) {
    const value = entry && entry.v !== undefined ? entry.v : null;
    if (!withVersion) return value;
    const out = { value, version: entry && Number.isInteger(entry.ver) ? entry.ver : 0 };
    if (entry && entry.dirty) out.dirty = true;
    return out;
  }

  async _dbGet(key, opts) {
    const withVersion = Boolean(opts && opts.withVersion);
    const gameId = this.gameId;
    if (!this.canSaveToCloud) return this._dbView(this._dbLocal(key), withVersion);
    let data;
    try {
      data = await this.request("GET", `/v1/db/${enc(key)}`);
    } catch {
      return this._dbView(this._dbLocal(key), withVersion);
    }
    // Read again: a set() may have landed while the request was out.
    const local = this._dbLocal(key);
    const version = Number.isInteger(data && data.version) ? data.version : null;
    const value = data && data.value !== undefined ? data.value : null;
    if (local && local.dirty) {
      // Progress this browser has not managed to upload. The cloud's answer
      // must not replace it — that is the save a player loses — so try the
      // upload again and keep showing the local value while the service
      // cannot be reached.
      try {
        await this._dbFlush(key, local);
      } catch (err) {
        // The service answered and refused it for good: settle on the cloud's
        // value so the next read and the next `ifVersion` start from what is
        // stored, instead of re-sending the same refused write on every read.
        if (this._dbRefusedForGood(err, local)) {
          this._dbSettle(key, local.seq, err.current || { value, version });
        }
      }
      return this._dbView(this._dbLocal(key) || local, withVersion);
    }
    if (gameId === this.gameId) {
      writeDbEntry(gameId, key, { v: value, ver: version, dirty: false, seq: (local && local.seq) || 0 });
    }
    return withVersion ? { value, version: version || 0 } : value;
  }

  /**
   * Upload a dirty entry. Conditional when its base version is known, so a
   * retry never silently overwrites a save another device made since. A
   * conflict on a plain `set` leaves it dirty for the game's next plain write
   * to settle; anything `_dbRefusedForGood` names is settled by the caller.
   */
  async _dbFlush(key, entry) {
    const body = { value: entry.v === undefined ? null : entry.v };
    if (Number.isInteger(entry.ver)) body.ifVersion = entry.ver;
    const data = await this.request("PUT", `/v1/db/${enc(key)}`, body);
    this._dbConfirm(key, entry.seq, data);
    return data;
  }

  /** Mark a write synced, unless a newer local write has replaced it meanwhile. */
  _dbConfirm(key, seq, data) {
    const now = this._dbLocal(key);
    if (!now || now.seq !== seq) return;
    const version = Number.isInteger(data && data.version) ? data.version : null;
    writeDbEntry(this.gameId, key, { v: now.v, ver: version, dirty: false, seq });
  }

  /**
   * Whether a failed upload of `entry` was refused for good, so keeping it
   * dirty would only re-send the same refused write on every read. Never true
   * for a network failure, offline, a 5xx/401/403/408/429, or a busy 409
   * (`conflict`, `tx_conflict`, any code but `version_conflict`) — those stay
   * dirty and retry (see `saveRetryable`). A `version_conflict` counts for a
   * write the game made with `ifVersion` (the game was told, or is told on
   * its next `withVersion` read); a plain `set` that conflicts on retry stays
   * dirty, because its
   * game was promised the write and its next plain `set` lands without a
   * version check. Any other 4xx (413 too large, 400 bad value) can never be
   * accepted, so it counts for every write.
   */
  _dbRefusedForGood(err, entry) {
    if (!err || saveRetryable(err)) return false;
    if (err.code === "version_conflict") return Boolean(entry && entry.cond);
    return true;
  }

  /**
   * Replace a refused local write with what the cloud holds, unless a newer
   * local write has replaced it meanwhile. `current` is the conflict's
   * `{ value, version }`; `null` restores `fallback` (what this key held
   * before the refused write), or drops the key from the cache.
   */
  _dbSettle(key, seq, current, fallback) {
    const now = this._dbLocal(key);
    if (now && now.seq !== seq) return;
    if (current && typeof current === "object") {
      writeDbEntry(this.gameId, key, {
        v: current.value === undefined ? null : current.value,
        ver: Number.isInteger(current.version) ? current.version : 0,
        dirty: false,
        seq,
      });
    } else if (fallback) {
      // Its own seq: an upload of it still in flight may confirm it.
      writeDbEntry(this.gameId, key, fallback);
    } else {
      writeDbEntry(this.gameId, key, null);
    }
  }

  async _dbSet(key, value, opts) {
    const conditional = Boolean(opts) && opts.ifVersion !== undefined && opts.ifVersion !== null;
    if (conditional && (!Number.isInteger(opts.ifVersion) || opts.ifVersion < 0)) {
      throw dbError("bad_request", "ifVersion must be a whole number >= 0");
    }
    const prev = this._dbLocal(key);
    const seq = ((prev && prev.seq) || 0) + 1;
    const base = conditional ? opts.ifVersion : prev && Number.isInteger(prev.ver) ? prev.ver : null;
    writeDbEntry(this.gameId, key, { v: value, ver: base, dirty: true, cond: conditional, seq });
    if (!this.canSaveToCloud) {
      if (conditional) throw dbError("offline", "Saved on this device only; the cloud save is not reachable");
      return value;
    }
    try {
      const body = conditional ? { value, ifVersion: opts.ifVersion } : { value };
      const data = await this.request("PUT", `/v1/db/${enc(key)}`, body);
      this._dbConfirm(key, seq, data);
      if (!conditional) return value;
      return { version: Number.isInteger(data && data.version) ? data.version : null };
    } catch (err) {
      // Refused for good (a lost `ifVersion`, a value too large): the write
      // is not kept dirty, or every later read would re-send it and show it
      // instead of the cloud's. The cache goes back to the cloud's value when
      // the refusal says what that is, else to what it held before.
      if (this._dbRefusedForGood(err, { cond: conditional })) {
        this._dbSettle(key, seq, err.current || null, prev);
      }
      // A plain set never rejects: it is written locally and syncs later.
      if (!conditional) return value;
      if (err && err.code === "version_conflict") {
        const current = err.current && typeof err.current === "object" ? err.current : {};
        throw dbError("version_conflict", err.message || "Save changed since that version", {
          status: 409,
          current: {
            value: current.value === undefined ? null : current.value,
            version: Number.isInteger(current.version) ? current.version : 0,
          },
        });
      }
      if (saveRetryable(err)) {
        throw dbError("offline", "Saved on this device only; the cloud save did not confirm", {
          status: err && err.status,
          cause: err,
        });
      }
      throw err;
    }
  }

  /** Soft delete. The service keeps the value (and its history) for 30 days. */
  async _dbDelete(key) {
    const prev = this._dbLocal(key);
    const seq = ((prev && prev.seq) || 0) + 1;
    if (!this.canSaveToCloud) {
      writeDbEntry(this.gameId, key, null);
      return { deleted: true };
    }
    let data;
    try {
      data = await this.request("DELETE", `/v1/db/${enc(key)}`);
    } catch (err) {
      if (saveRetryable(err)) {
        throw dbError("offline", "The cloud save did not confirm the delete; try again", {
          status: err && err.status,
          cause: err,
        });
      }
      throw err;
    }
    const version = Number.isInteger(data && data.version) ? data.version : null;
    writeDbEntry(this.gameId, key, { v: null, ver: version, dirty: false, seq });
    return { deleted: true, ...(version != null ? { version } : {}) };
  }

  /**
   * Ask the host to open its sign-in UI, then wait to be told it is done.
   *
   * The account UI belongs to the host: a game cannot show a password field in
   * an iframe the site does not control, and should not be trusted with one.
   * Resolves when the host says the player is signed in. The bootstrap that
   * follows carries a token, which flips `offline` off, so balance(),
   * inventory() and buy() start working without the game reloading.
   */
  _signIn() {
    const signedIn = () => !this.offline && !this._isGuestSession();
    if (signedIn()) return Promise.resolve({ signedIn: true });
    // A desktop/Steam build has no host to draw an account UI. Its launcher is
    // the sign-in surface, and only it can vouch for the player to the host
    // with the internal secret that account linking requires — so this asks the
    // native side to run sign-in and then waits for the bootstrap that carries
    // the linked token, exactly as the web path waits for the host's answer.
    const desktop = storeBilling();
    if (desktop && typeof desktop.signIn === "function") return this._signInViaNative(signedIn);
    post({ type: "tesana-sign-in-request", gameId: this.gameId });
    return new Promise((resolve) => {
      let expiry = null;
      const finish = (result) => {
        if (expiry) clearTimeout(expiry);
        window.removeEventListener("message", onMessage);
        resolve(result);
      };
      // The player is signed in, but the token travels in a separate bootstrap
      // and may still be in flight. Resolving the moment we hear "yes" would
      // let a game that awaits signIn() and then immediately buys be refused a
      // second time for still being offline — the exact dead end this whole
      // exchange exists to remove.
      const waitForToken = (attempt) => {
        if (signedIn()) return finish({ signedIn: true });
        if ((attempt || 0) >= 60) return finish({ signedIn: true });
        setTimeout(() => waitForToken((attempt || 0) + 1), 50);
      };
      function onMessage(event) {
        const msg = event.data;
        if (!msg || msg.type !== "tesana-signed-in") return;
        if (!msg.signedIn) return finish({ signedIn: false });
        waitForToken(0);
      }
      window.addEventListener("message", onMessage);
      // Declining is an answer too. Report what is actually true rather than
      // leaving the game's promise pending forever.
      expiry = setTimeout(() => finish({ signedIn: signedIn() }), SIGN_IN_TIMEOUT_MS);
    });
  }

  /** A guest the site vouches for: saves in the cloud, but has no account to spend from. */
  _isGuestSession() {
    if (!this._player) return false;
    // Two signals, because the answer arrives from two places. A host posts
    // `isGuest: true` in its bootstrap — the web's word for it — while an
    // identity this client resolves itself (`/v1/player/me`) reports `isLinked`
    // and no `isGuest` at all. Reading only the first would let a native
    // session, whose whole point is an account-free identity, pass as a
    // signed-in player; the store path gates a sale on exactly this, so that
    // mistake is a card charged for coins we then refuse to grant.
    return this._player.isGuest === true || this._player.isLinked === false;
  }

  /**
   * Ask the native launcher to sign the player in, then wait for the token.
   *
   * The launcher is the only party that can reach the host route with the
   * internal secret that account linking needs, so this hands it the request
   * and then watches `signedIn()` — which flips the moment the linked bootstrap
   * replaces the guest one. Polling rather than listening is deliberate: the
   * bootstrap arrives through the SDK's own upgrade path (`onBootstrapUpgrade`
   * re-points the client and re-runs identity), and there is no second channel
   * to subscribe to here.
   */
  _signInViaNative(signedIn) {
    return window.TesanaDesktop.signIn({ gameId: this.gameId }).then((answer) => {
      if (!answer || answer.ok !== true || answer.signedIn !== true) return { signedIn: false };
      return new Promise((resolve) => {
        const waitForToken = (attempt) => {
          if (signedIn()) return resolve({ signedIn: true });
          // Report what is actually true when the wait runs out. The web path
          // predates this and answers optimistically; its launcher-started
          // sign-in gets a fresh page instead, so it never observes the lie.
          // Here the caller is a store purchase deciding whether money may
          // move, and "probably signed in" is not a state a charge may proceed
          // on — a token that never arrived means no account to hold the coins.
          if ((attempt || 0) >= 60) return resolve({ signedIn: signedIn() });
          setTimeout(() => waitForToken((attempt || 0) + 1), 50);
        };
        waitForToken(0);
      });
    });
  }

  /** Whether a report has somewhere to go. A token is not needed; a game is. */
  _feedbackReachable() {
    return Boolean(this._baseFor() && this.gameId);
  }

  /**
   * Build a report from what the game said plus what the SDK saw, and file it.
   *
   * @param {{ kind?: string, message?: string, levelId?: string, save?: unknown, error?: object }} input
   * @param {{ screenshot?: boolean|string|null }} [opts] `true` captures now; a string is one taken earlier
   */
  async _feedbackSubmit(input, opts = {}) {
    if (!this._feedbackReachable()) {
      const err = new Error("This game is not connected to Tesana, so there is nowhere to send a report.");
      err.code = "feedback_unavailable";
      throw err;
    }
    const given = input && typeof input === "object" ? input : {};
    const report = {
      gameId: this.gameId,
      kind: String(given.kind || "bug"),
      message: clipText(given.message, 2000),
      build: this.build,
      sdkVersion: VERSION,
      device: feedbackDevice(),
      events: feedbackTrail.slice(),
      errors: feedbackErrors.slice(),
    };
    if (given.levelId != null) report.levelId = clipText(given.levelId, 64);
    if (given.error) report.error = describeError(given.error);
    const shot = typeof opts.screenshot === "string" ? opts.screenshot : opts.screenshot ? captureScreenshot() : null;
    if (shot) report.screenshot = shot;
    // A save is opt-in: it is the player's own data, and most reports are
    // about what happened on screen, not in the save file.
    if (given.save === true) {
      try {
        report.save = await Promise.race([
          this.db.get("save"),
          new Promise((resolve) => setTimeout(() => resolve(undefined), 1500)),
        ]);
      } catch {
        /* no save is still a report */
      }
      if (report.save === undefined || report.save === null) delete report.save;
    } else if (given.save !== undefined && given.save !== false) {
      report.save = given.save;
    }
    return this._send(this._baseFor(), this._authFor(), "POST", "/v1/feedback", report);
  }

  async _feedbackOpen(opts) {
    const options = opts && typeof opts === "object" ? opts : {};
    if (typeof window === "undefined" || !hasHost()) return { ok: false, reason: "no_host" };
    if (!this._feedbackReachable()) return { ok: false, reason: "unavailable" };
    // Taken now, while the game still shows what the player wants to report.
    const screenshot = captureScreenshot();
    const requestId = hostRequestId("fb");
    const answer = awaitHostAnswer("tesana-feedback-result", requestId, FEEDBACK_FORM_TIMEOUT_MS);
    post({
      type: "tesana-feedback-request",
      requestId,
      gameId: this.gameId,
      kind: options.kind ? String(options.kind) : "",
    });
    const msg = await answer;
    if (!msg) return { ok: false, reason: "timeout" };
    if (msg.ok !== true || !msg.message) return { ok: false, reason: msg.reason || "cancelled" };
    try {
      const filed = await this._feedbackSubmit(
        { kind: msg.kind || options.kind || "bug", message: msg.message, levelId: options.levelId, save: options.save },
        { screenshot },
      );
      return { ok: true, reportId: filed.reportId };
    } catch (err) {
      return { ok: false, reason: (err && err.code) || "unreachable" };
    }
  }

  _configGet(key, fallback) {
    const values = this._config.values;
    const name = String(key);
    if (!values || !Object.prototype.hasOwnProperty.call(values, name)) return fallback;
    const value = values[name];
    if (fallback !== undefined && fallback !== null && value !== null && typeof value !== typeof fallback) {
      warnOnce(
        `config-type-${name}`,
        `tesana.config: "${name}" is a ${typeof value} but the game expects a ${typeof fallback}; using the default.`,
      );
      return fallback;
    }
    return cloneJson(value);
  }

  /** Fetch this game's values. Never rejects; the cached copy stands on any failure. */
  _configLoad() {
    if (this._config.gameId !== this.gameId) {
      this._config = { ...cachedConfig(this.gameId), gameId: this.gameId, loaded: false, pending: null };
    }
    if (this._config.pending) return this._config.pending;
    if (!this._canReach()) return Promise.resolve(this.config.getAll());
    const gameId = this.gameId;
    this._config.attempted = true;
    // No credential: the values are public, and a token that has aged out must
    // not turn a read every player needs into a refresh round-trip.
    const pending = this._fetchSend(this._baseFor(), "", "GET", `/v1/config?gameId=${enc(gameId)}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!data || typeof data.values !== "object" || data.values === null || this.gameId !== gameId) return;
        this._config.values = data.values;
        this._config.version = Number(data.version) || 0;
        this._config.loaded = true;
        cacheConfig(gameId, this._config);
      })
      .catch(() => {})
      .then(() => {
        if (this._config.pending === pending) this._config.pending = null;
        return this.config.getAll();
      });
    this._config.pending = pending;
    return pending;
  }

  _configReady() {
    if (this._config.loaded) return Promise.resolve(this.config.getAll());
    const load = this._config.pending || this._configLoad();
    return Promise.race([
      load,
      new Promise((resolve) => setTimeout(() => resolve(this.config.getAll()), CONFIG_READY_TIMEOUT_MS)),
    ]);
  }

  /** What an invite link carried: the bootstrap's `launch` first, then the frame's query. */
  _shareParams() {
    const launch = this._launch || {};
    const query = shareQuery();
    return {
      roomCode: shareRoomCode(launch.roomCode ?? launch.room) || shareRoomCode(query.roomCode),
      levelId: shareLevelId(launch.levelId ?? launch.level) || shareLevelId(query.levelId),
    };
  }

  /**
   * Share an invite. Never rejects: resolves `{ ok, url?, method?, reason? }`.
   *
   * @param {{ text?: string, roomCode?: string, levelId?: string }} [opts]
   */
  async _share(opts) {
    try {
      const options = opts && typeof opts === "object" ? opts : {};
      const text = clipText(options.text, SHARE_TEXT_MAX);
      const roomCode = shareRoomCode(options.roomCode);
      const levelId = shareLevelId(options.levelId);
      if (typeof window === "undefined") return { ok: false, reason: "no_host" };
      if (hasHost()) {
        const requestId = hostRequestId("sh");
        const answer = awaitHostAnswer("tesana-share-result", requestId, SHARE_TIMEOUT_MS);
        post({ type: "tesana-share-request", requestId, gameId: this.gameId, text, roomCode, levelId });
        const msg = await answer;
        if (!msg) return { ok: false, reason: "timeout" };
        return {
          ok: msg.ok === true,
          ...(msg.url ? { url: String(msg.url) } : {}),
          ...(msg.method ? { method: String(msg.method) } : {}),
          ...(msg.ok === true ? {} : { reason: msg.reason || "cancelled" }),
        };
      }
      // No Tesana page above: share this page's own address, with the invite on it.
      const url = shareFallbackUrl(roomCode, levelId);
      const nav = typeof navigator !== "undefined" ? navigator : null;
      if (nav && typeof nav.share === "function") {
        try {
          await nav.share({ text: text || undefined, url });
          return { ok: true, url, method: "native" };
        } catch (err) {
          if (err && err.name === "AbortError") return { ok: false, url, reason: "cancelled" };
        }
      }
      if (nav && nav.clipboard && typeof nav.clipboard.writeText === "function") {
        try {
          await nav.clipboard.writeText(text ? `${text} ${url}` : url);
          return { ok: true, url, method: "clipboard" };
        } catch {
          /* fall through */
        }
      }
      return { ok: false, url, reason: "unsupported" };
    } catch {
      return { ok: false, reason: "error" };
    }
  }
}

function enc(value) {
  return encodeURIComponent(String(value));
}

/** A JSON value's own copy, so a game editing what it read cannot edit the cache. */
function cloneJson(value) {
  if (value === null || typeof value !== "object") return value;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
}


  var api = { init: init, TesanaClient: TesanaClient, version: VERSION, track: track, gameplay: gameplay };
  root.Tesana = api;
  // A game's first line may be `await window.__TESANA_READY__`, the promise
  // form the engine's skills teach, so start booting the moment this loads.
  // Resolving it here — rather than waiting for the game to call init() — is
  // what lets a game read its save before the first draw instead of painting a
  // default state and snapping.
  root.__TESANA_READY__ = init();
})(typeof window !== "undefined" ? window : globalThis);
