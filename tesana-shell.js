/*
 * tesana-shell.js — injected by build/build-game.mjs as the FIRST <script> of
 * web-export/index.html. Plain ES2020, no build step, nothing importable: games
 * never reference Tesana code. Provides the Studio bridge, console ring, mute /
 * volume, mobile hygiene (isMobile), screenshots, loading overlay, watermark and
 * the QA hooks. Reads
 * {title, isMobile, orientation, disableWatermark, watermarkUrl, logoUrl, posterUrl, gameType}
 * from <script type="application/json" id="tesana-meta">.
 *
 * Watermark: the Tesana badge PNG (`watermarkUrl`, inlined by the build) in a
 * #tesana-watermark overlay with the same geometry as Godot's presets/_shared.py
 * — a 16:9 box fitted and centred in the viewport, badge 11.5% of the box width
 * at its bottom-right (margins 2.25% right / 1.5% bottom), pointer-events:none,
 * revealed once the game is ready; narrower than 16:9 the box hugs the bottom
 * edge and the badge is at least 96px wide. `disableWatermark` (paid opt-out) renders
 * nothing; a missing PNG falls back to the text "Made on Tesana". QA rigs
 * (sdk qa_rig.py / qa_mcp.py, incl. the poster capture) set
 * `window.__TESANA_QA_RIG__ = true` from an init script and get no badge at all,
 * matching Godot whose engine-native captures never include it.
 */
(function () {
  "use strict";
  var VERSION = "2.0.0";
  var RING_CAPACITY = 200, READY_TIMEOUT_MS = 12000, ACTIVITY_WINDOW_MS = 30000;
  var meta = {};
  try { meta = JSON.parse(document.getElementById("tesana-meta").textContent) || {}; } catch (e) { /* defaults */ }
  var title = meta.title || document.title || "Untitled Game";
  // Read once, here: the shell is the first script in <head>, so only a Playwright
  // init script (the QA rig) can have set this — never the game's own code.
  var qaRig = window["__TESANA_QA_RIG__"] === true;

  // ---------------------------------------------------------------- console ring
  var ring = [];
  function push(level, message) {
    ring.push({ level: level, message: message, timestamp: Date.now() });
    while (ring.length > RING_CAPACITY) ring.shift();
  }
  function fmt(arg) {
    if (arg instanceof Error) return arg.stack || arg.name + ": " + arg.message;
    if (typeof arg !== "object" || arg === null) return String(arg);
    try { return JSON.stringify(arg); } catch (e) { return String(arg); }
  }
  ["log", "info", "warn", "error", "debug"].forEach(function (level) {
    var original = console[level];
    console[level] = function () {
      var args = Array.prototype.slice.call(arguments);
      push(level, args.map(fmt).join(" "));
      if (typeof original === "function") original.apply(console, args);
    };
  });

  // ---------------------------------------------------------------- bridge out
  function post(message) {
    try { (window.parent || window).postMessage(message, "*"); } catch (e) { /* unserialisable payload */ }
  }

  // ---------------------------------------------------------------- gameplay events
  // The platform's own record of what happened in a game, separate from the
  // play counter (which only knows a session happened and how long it lasted).
  //
  // The shell can see the two things the game itself never reports and the
  // platform most wants: how the frame rate actually held up, and how many
  // errors were thrown. It cannot see game semantics — a death, a level
  // ending — so those arrive through `window.__TESANA_EVENT__`, which the play
  // SDK's `tesana.track` calls. One path for both: everything is posted to the
  // host, which owns the play token and does the writing. The frame is never
  // given a credential for it.
  //
  // Events are posted as they happen rather than batched: they are low
  // frequency (a death, a level transition), and an unload is exactly when a
  // batch would be lost. `session_end` is therefore sent on the first
  // backgrounding, not only on pagehide.
  var gameplayErrors = 0, lastLevelId = "", sessionEndSent = false;
  var sessionStartedAt = Date.now();
  var gameplayOn = meta.disableGameplayEvents !== true;

  function bridgeGameplay(event) {
    if (!gameplayOn || !event || typeof event !== "object") return;
    if (event.level_id) lastLevelId = String(event.level_id);
    post({ type: "tesana-gameplay-event", event: event });
  }
  // The game-facing entry point. The SDK prefers this over posting directly,
  // so the shell sees every event and `session_end` can name the last level.
  window["__TESANA_EVENT__"] = bridgeGameplay;

  function endSession() {
    if (!gameplayOn || sessionEndSent || !ready) return;
    sessionEndSent = true;
    bridgeGameplay({
      type: "session_end",
      level_id: lastLevelId,
      payload: {
        seconds: Math.round((Date.now() - sessionStartedAt) / 1000),
        fps: Math.round(fps),
        frames: frameCount,
        errors: gameplayErrors,
      },
    });
  }

  function reportError(error, fallback) {
    var err = error instanceof Error ? error : new Error(String(error == null ? fallback : error));
    gameplayErrors++;
    post({ type: "game-error", message: err.message, stack: err.stack || null });
  }
  window.addEventListener("error", function (event) {
    push("error", "Uncaught: " + (event.message || fmt(event.error)) + (event.filename ? " at " + event.filename + ":" + event.lineno : ""));
    reportError(event.error, event.message || "Unknown error");
  });
  window.addEventListener("unhandledrejection", function (event) {
    push("error", "Unhandled Promise: " + fmt(event.reason));
    reportError(event.reason, "Unhandled rejection");
  });
  window["__TESANA_BRIDGE__"] = { installed: true, version: VERSION };

  // ---------------------------------------------------------------- input tracking
  var lastInputAt = null, inputPosted = false;
  function noteInput() {
    lastInputAt = Date.now();
    if (!inputPosted) { inputPosted = true; post({ type: "game-input" }); }
  }
  ["pointerdown", "keydown", "touchstart"].forEach(function (ev) { window.addEventListener(ev, noteInput, { capture: true, passive: true }); });

  // ---------------------------------------------------------------- session end
  // The quit point is the most-asked question about a game ("where do players
  // stop?") and the one signal no game reports about itself. The shell can see
  // it directly: a backgrounded tab, a closed tab, a navigation away. Sent on
  // the first of those so it is not lost to an unload that never fires.
  document.addEventListener("visibilitychange", function () { if (document.hidden) endSession(); });
  window.addEventListener("pagehide", endSession);

  // ---------------------------------------------------------------- mute / volume
  // Every AudioContext created after this point routes through a master GainNode:
  // `ctx.destination` returns the gain and the gain feeds the real destination.
  var masters = [], muted = false, volume = 1;
  function applyAudio() {
    masters.forEach(function (gain) { gain.gain.value = muted ? 0 : volume; });
    var media = document.querySelectorAll("audio, video");
    for (var i = 0; i < media.length; i++) media[i].muted = muted;
  }
  function patchAudioContext(name) {
    var Native = window[name];
    if (typeof Native !== "function") return;
    var Patched = function TesanaAudioContext(options) {
      var ctx = options === undefined ? new Native() : new Native(options);
      var gain = ctx.createGain();
      gain.connect(ctx.destination);
      gain.gain.value = muted ? 0 : volume;
      Object.defineProperty(ctx, "destination", { get: function () { return gain; }, configurable: true });
      Object.defineProperty(ctx, "__tesanaMaster", { value: gain });
      masters.push(gain);
      return ctx;
    };
    Patched.prototype = Native.prototype;
    window[name] = Patched;
  }
  patchAudioContext("AudioContext");
  patchAudioContext("webkitAudioContext");

  // ---------------------------------------------------------------- mobile hygiene
  // Touch hygiene (no pinch/double-tap zoom, no rubber-band scroll from a touch
  // on the canvas, no long-press callout / context menu / text selection over the
  // game, no tap highlight) is needed whenever the game is being PLAYED on a touch
  // device — which is a runtime fact, not the creation-time `is_mobile` authoring
  // flag. `meta.isMobile` marks a game whose model was asked to write touch
  // controls; a desktop-authored game is still opened on a phone via a shared link
  // or a home-screen bookmark, and without this it stays pinch-zoomable and
  // unframeable. So mount when the game is authored mobile OR the environment is
  // coarse-pointer. The environment probe is deliberately `matchMedia`-only: on a
  // desktop (including a touchscreen laptop with a mouse) the primary pointer is
  // fine, so right-click, text selection and the game's DOM menus are untouched —
  // which is what keeps this from regressing desktop play. The shell mounts NO
  // controls and exposes NO input API — the game writes its controls
  // (preambles.MOBILE_BLOCK describes exactly this; keep the two in agreement). The
  // style goes at the TOP of <head> so the game's own CSS wins any tie;
  // build-game.mjs writes the matching viewport meta at build time for every game.
  var MOBILE_CSS =
    "html,body{touch-action:manipulation;overscroll-behavior:none;-webkit-text-size-adjust:100%;-webkit-tap-highlight-color:transparent;-webkit-touch-callout:none;-webkit-user-select:none;user-select:none}" +
    "canvas{touch-action:none;-webkit-touch-callout:none;-webkit-user-select:none;user-select:none}";
  function isCanvas(node) { return !!node && String(node.tagName || "").toUpperCase() === "CANVAS"; }
  function blockEvent(event) { if (event.cancelable !== false) event.preventDefault(); }
  // Coarse primary pointer / no-hover: the runtime signature of a phone or tablet.
  // `matchMedia` absent (old embed, some test environments) reads as not-touch, so
  // a desktop load is never given touch behaviour by accident.
  function isTouchEnvironment() {
    try {
      if (!window.matchMedia) return false;
      return window.matchMedia("(pointer: coarse)").matches || window.matchMedia("(hover: none)").matches;
    } catch (e) { return false; }
  }
  function mountMobileHygiene() {
    var style = document.createElement("style");
    style.setAttribute("data-tesana", "mobile");
    style.textContent = MOBILE_CSS;
    document.head.insertBefore(style, document.head.firstChild);
    // Pinch zoom on iOS Safari / WKWebView (non-standard gesture events; the viewport meta covers Chromium).
    ["gesturestart", "gesturechange", "gestureend"].forEach(function (ev) { document.addEventListener(ev, blockEvent, { passive: false }); });
    // Long-press over the game surface; the game's DOM UI keeps its own menus.
    document.addEventListener("contextmenu", function (event) { if (isCanvas(event.target)) blockEvent(event); });
    // Scroll / rubber-band from a touch that starts on the canvas, for engines that ignore
    // touch-action (older WebKit). The canvas is the game, never a scroller.
    document.addEventListener("touchmove", function (event) { if (isCanvas(event.target)) blockEvent(event); }, { passive: false });
  }
  if (meta.isMobile || isTouchEnvironment()) mountMobileHygiene();

  // ---------------------------------------------------------------- frames & screenshots
  var frameCount = 0, fps = 0, lastFrameAt = 0;
  var afterFrame = []; // run right after the game's rAF callback, in the same frame (drawing buffer still valid)
  function largestCanvas() {
    var best = null, area = 0, list = document.getElementsByTagName("canvas");
    for (var i = 0; i < list.length; i++) {
      // Never film our own mirror: it is the same picture one frame stale,
      // and once it is the largest canvas the take is a feedback loop.
      if (list[i].hasAttribute("data-tesana-record")) continue;
      if (list[i].hasAttribute("data-tesana-film")) continue;
      var rect = list[i].getBoundingClientRect(), a = rect.width * rect.height;
      if (a > area && list[i].width > 0 && list[i].height > 0) { area = a; best = list[i]; }
    }
    return best;
  }
  function cssColorOpaque(value) {
    return value && value !== "transparent" && value !== "rgba(0, 0, 0, 0)";
  }
  // CSS 0deg = up, clockwise. Canvas y grows down.
  function linearGradientFromCss(ctx, css, w, h) {
    var match = /linear-gradient\((.+)\)\s*$/i.exec(String(css || "").replace(/\s+/g, " ").trim());
    if (!match) return null;
    var inner = match[1], angle = 180, rest = inner;
    var lead = /^\s*(to\s+(?:top|bottom|left|right)(?:\s+(?:left|right))?|[-+]?\d*\.?\d+deg)\s*,\s*/i.exec(inner);
    if (lead) {
      rest = inner.slice(lead[0].length);
      var token = lead[1].toLowerCase();
      if (token.indexOf("deg") !== -1) angle = parseFloat(token);
      else if (token === "to top") angle = 0;
      else if (token === "to right") angle = 90;
      else if (token === "to left") angle = 270;
      else if (token === "to top right") angle = 45;
      else if (token === "to top left") angle = 315;
      else if (token === "to bottom right") angle = 135;
      else if (token === "to bottom left") angle = 225;
      else angle = 180;
    }
    var rad = (angle * Math.PI) / 180, dx = Math.sin(rad), dy = -Math.cos(rad);
    var half = Math.abs(w * dx) + Math.abs(h * dy);
    var grad = ctx.createLinearGradient((w - dx * half) / 2, (h - dy * half) / 2, (w + dx * half) / 2, (h + dy * half) / 2);
    var stops = rest.split(/,(?![^(]*\))/);
    var added = 0;
    for (var i = 0; i < stops.length; i++) {
      var piece = stops[i].trim();
      if (!piece) continue;
      var t = added / Math.max(1, stops.length - 1), color = piece;
      var pct = piece.match(/\)\s+(-?[\d.]+%)\s*$/) || piece.match(/^(#[0-9a-fA-F]{3,8}|[a-z]+)\s+(-?[\d.]+%)\s*$/i);
      if (pct) {
        var pos = pct[pct.length - 1];
        t = parseFloat(pos) / 100;
        color = piece.slice(0, piece.length - pos.length).trim();
      }
      if (!isFinite(t)) continue;
      try { grad.addColorStop(Math.min(1, Math.max(0, t)), color); added++; } catch (e) { /* skip unparsable stop */ }
    }
    return added ? grad : null;
  }
  function paintPageBackdrop(ctx, w, h) {
    var color = "#000000", gradientCss = "";
    [document.documentElement, document.body].forEach(function (node) {
      if (!node) return;
      var style = getComputedStyle(node);
      if (cssColorOpaque(style.backgroundColor)) color = style.backgroundColor;
      if (style.backgroundImage && style.backgroundImage.indexOf("linear-gradient") !== -1) gradientCss = style.backgroundImage;
    });
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, w, h);
    var grad = linearGradientFromCss(ctx, gradientCss, w, h);
    if (grad) { ctx.fillStyle = grad; ctx.fillRect(0, 0, w, h); }
  }
  function onFrame(now) {
    frameCount++;
    if (lastFrameAt) { var inst = 1000 / Math.max(1, now - lastFrameAt); fps = fps ? fps * 0.9 + inst * 0.1 : inst; }
    lastFrameAt = now;
    afterFrame.splice(0).forEach(function (cb) { try { cb(); } catch (e) { /* never break the game loop */ } });
  }
  // ---------------------------------------------------------------- capture clock
  // A heavy game on a software-GL worker may only paint a few frames a second.
  // Every engine derives dt from the wall clock, so a 15-second take becomes
  // minutes of game time: the run plays itself out, the player dies, and the
  // few frames that did land are too far apart to interpolate between.
  //
  // While capturing — and only while capturing — the game is handed a clock
  // that advances one fixed step per painted frame instead of tracking real
  // time. Rendering still takes as long as it takes, but the game believes it
  // is running at a steady rate, so the sequence recorded is smooth and
  // correctly paced no matter how slow the box is. Offline renderers have
  // always worked this way.
  //
  // Known limits, all of which degrade to "as before" rather than worse:
  // logic driven by setInterval or the audio clock does not follow this, and
  // CSS/Web Animations keep running on the compositor's real clock.
  var clockStepMs = 0;                 // 0 = virtual clock disengaged
  var virtualNow = 0, clockFrames = 0, clockStartedAt = 0;
  // Frames the recorder has agreed it can still capture, and the number of
  // rAF turns spent waiting for that budget to grow. Infinity means nobody is
  // pacing us, which is the behaviour before any of this existed.
  var clockCredit = Infinity, clockStalls = 0;
  var nativePerfNow = performance.now.bind(performance);
  var nativeDateNow = Date.now.bind(Date);

  function engageCaptureClock(fps, credit) {
    if (clockStepMs) return clockStatus();
    var rate = Math.min(240, Math.max(1, Number(fps) || 60));
    clockStepMs = 1000 / rate;
    virtualNow = nativePerfNow();
    clockStartedAt = virtualNow;
    clockFrames = 0;
    clockStalls = 0;
    grantCaptureCredit(credit);
    // Keep the two clocks telling the same story: a game that mixes
    // performance.now() and Date.now() must not see them disagree.
    var epoch = nativeDateNow() - virtualNow;
    performance.now = function () { return virtualNow; };
    Date.now = function () { return epoch + virtualNow; };
    return clockStatus();
  }

  // Retune the step mid-take without disturbing the time already elapsed. The
  // recorder only learns how fast it can write frames once it is writing them.
  function setCaptureClockRate(fps) {
    if (!clockStepMs) return clockStatus();
    clockStepMs = 1000 / Math.min(240, Math.max(1, Number(fps) || 60));
    return clockStatus();
  }

  // Raising the budget lets the game draw further; ``undefined`` or a negative
  // number hands the clock back to the game entirely.
  function grantCaptureCredit(frames) {
    var n = Number(frames);
    clockCredit = (isFinite(n) && n >= 0) ? n : Infinity;
    return clockStatus();
  }

  function releaseCaptureClock() {
    var status = clockStatus();
    if (clockStepMs) {
      performance.now = nativePerfNow;
      Date.now = nativeDateNow;
      clockStepMs = 0;
    }
    clockCredit = Infinity;
    return status;
  }

  function clockStatus() {
    return {
      engaged: clockStepMs > 0,
      fps: clockStepMs ? Math.round(1000 / clockStepMs) : 0,
      frames: clockFrames,
      credit: isFinite(clockCredit) ? clockCredit : null,
      stalls: clockStalls,
      virtualMs: clockStepMs ? virtualNow - clockStartedAt : 0,
      realMs: clockStartedAt ? nativePerfNow() - clockStartedAt : 0
    };
  }

  var nativeRAF = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = function (callback) {
    function turn(now) {
      // Drawing further than the recorder can capture is what turns a 15s
      // take into a handful of real frames stretched over 900: uncapped rAF
      // runs game time far ahead while the screencast is still on frame ten.
      // Wait instead, so every frame the game draws is a frame we keep.
      if (clockStepMs && clockFrames >= clockCredit) {
        clockStalls++;
        return nativeRAF(turn);
      }
      var stamp = now;
      if (clockStepMs) { virtualNow += clockStepMs; clockFrames++; stamp = virtualNow; }
      // The game gets the virtual stamp; onFrame keeps the real one so the
      // reported fps stays an honest measure of how fast the box actually is.
      try { callback(stamp); } finally { onFrame(now); }
    }
    return nativeRAF(turn);
  };
  // ---------------------------------------------------------------- WebGL screenshots
  // A WebGL canvas made without preserveDrawingBuffer can only be read in the
  // same task that drew it: once the browser composites, the buffer is cleared
  // and toDataURL hands back solid black. "Right after the game's rAF callback"
  // is not enough on its own. The callback may not draw at all (an fps cap
  // skips every other frame on a 120 Hz screen), the game may run a second rAF
  // loop that does not draw, or it may draw from a timer (TES-79).
  //
  // So for a WebGL canvas the screenshot waits for an actual draw on it, then
  // reads in a microtask: after the code that drew has returned, before the
  // browser can composite. The draw calls are watched only while a screenshot
  // is pending, so a game pays nothing the rest of the time.
  var webglCanvases = typeof WeakSet === "function" ? new WeakSet() : null;
  var nativeGetContext = window.HTMLCanvasElement && HTMLCanvasElement.prototype.getContext;
  if (nativeGetContext && webglCanvases) {
    HTMLCanvasElement.prototype.getContext = function (type) {
      var ctx = nativeGetContext.apply(this, arguments);
      if (ctx && /^(webgl2?|experimental-webgl2?)$/.test(String(type))) webglCanvases.add(this);
      return ctx;
    };
  }
  function isWebGLCanvas(canvas) { return !!(webglCanvases && webglCanvases.has(canvas)); }
  var GL_DRAWS = ["clear", "drawArrays", "drawElements", "drawArraysInstanced", "drawElementsInstanced",
    "drawRangeElements", "blitFramebuffer", "clearBufferfv", "clearBufferiv", "clearBufferuiv", "clearBufferfi"];
  var glWaiters = [], glPatched = [], glDrawn = [], glFlushQueued = false;
  function flushGLDraws() {
    glFlushQueued = false;
    var drawn = glDrawn.splice(0), target = largestCanvas();
    if (target && drawn.indexOf(target) !== -1) glWaiters.slice().forEach(function (cb) { cb(); });
  }
  function noteGLDraw(canvas) {
    if (glDrawn.indexOf(canvas) === -1) glDrawn.push(canvas);
    if (glFlushQueued) return;
    glFlushQueued = true;
    Promise.resolve().then(flushGLDraws);
  }
  function watchGLDraws(on) {
    if (!on) {
      glPatched.splice(0).forEach(function (p) { if (p.proto[p.name] === p.wrapper) p.proto[p.name] = p.native; });
      return;
    }
    if (glPatched.length) return;
    [window.WebGLRenderingContext, window.WebGL2RenderingContext].forEach(function (Ctor) {
      if (!Ctor) return;
      GL_DRAWS.forEach(function (name) {
        var proto = Ctor.prototype, native = proto[name];
        if (typeof native !== "function") return;
        var wrapper = function () {
          var result = native.apply(this, arguments);
          try { noteGLDraw(this.canvas); } catch (e) { /* never break the game's draw */ }
          return result;
        };
        proto[name] = wrapper;
        glPatched.push({ proto: proto, name: name, native: native, wrapper: wrapper });
      });
    });
  }
  function captureDataUrl() {
    return new Promise(function (resolve, reject) {
      var done = false;
      var finish = function () {
        if (done) return;
        done = true;
        var waiting = glWaiters.indexOf(finish);
        if (waiting !== -1) glWaiters.splice(waiting, 1);
        if (!glWaiters.length) watchGLDraws(false);
        var canvas = largestCanvas();
        if (!canvas) return reject(new Error("No canvas to capture"));
        try { resolve(canvas.toDataURL("image/png")); } catch (e) { reject(e); }
      };
      if (isWebGLCanvas(largestCanvas())) {
        glWaiters.push(finish);
        watchGLDraws(true);
      } else {
        afterFrame.push(finish); // 2D canvases keep their pixels between frames
      }
      setTimeout(finish, 500); // game not animating → read the canvas directly
    });
  }

  // ---------------------------------------------------------------- bridge in
  var recording = false;
  function record(durationMs) {
    return new Promise(function (resolve, reject) {
      var src = largestCanvas();
      if (recording) return reject(new Error("Recording already in progress"));
      if (!src) return reject(new Error("No canvas to record"));
      if (typeof MediaRecorder === "undefined") return reject(new Error("MediaRecorder is not supported"));
      var dest = document.createElement("canvas");
      dest.setAttribute("data-tesana-record", "1");
      dest.width = src.width || 1280;
      dest.height = src.height || 720;
      var ctx = dest.getContext("2d", { alpha: false, desynchronized: true });
      var target = ctx && typeof dest.captureStream === "function" ? dest : src;
      if (typeof target.captureStream !== "function") return reject(new Error("MediaRecorder is not supported"));
      var duration = Math.min(30000, Math.max(250, Number(durationMs) || 5000));
      // Studio iframe path only. QA `--probe record` uses Playwright's
      // compositor (canvas.captureStream + VP9 drops to a handful of unique
      // frames and ffmpeg then duplicates them — motion looks like slow-mo).
      // captureStream(0) + requestFrame + VP8 is the least-lossy in-page option.
      var stream = target.captureStream(60);
      var track = stream.getVideoTracks()[0];
      var mimeType = ["video/webm;codecs=vp8", "video/webm;codecs=vp9", "video/webm"].filter(function (t) { return MediaRecorder.isTypeSupported(t); })[0];
      var recorder = new MediaRecorder(stream, mimeType ? { mimeType: mimeType, videoBitsPerSecond: 6e6 } : { videoBitsPerSecond: 6e6 });
      var chunks = [];
      var running = true;
      recording = true;
      if (qa) qa.recording = true;
      function paint() {
        if (!running) return;
        var live = largestCanvas();
        if (ctx && live) {
          if (dest.width !== live.width || dest.height !== live.height) {
            dest.width = live.width;
            dest.height = live.height;
          }
          paintPageBackdrop(ctx, dest.width, dest.height);
          try { ctx.drawImage(live, 0, 0, dest.width, dest.height); } catch (e) { /* tainted / lost context */ }
        }
        if (track && typeof track.requestFrame === "function") track.requestFrame();
        afterFrame.push(paint);
      }
      function stop() {
        if (!running) return;
        running = false;
        recording = false;
        if (qa) qa.recording = false;
        stream.getTracks().forEach(function (t) { t.stop(); });
      }
      recorder.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
      recorder.onerror = function () { stop(); reject(new Error("MediaRecorder error")); };
      recorder.onstop = function () {
        stop();
        var reader = new FileReader();
        reader.onload = function () { resolve({ dataUrl: String(reader.result), mimeType: recorder.mimeType, durationMs: duration }); };
        reader.onerror = function () { reject(new Error("FileReader failed")); };
        reader.readAsDataURL(new Blob(chunks, { type: recorder.mimeType || "video/webm" }));
      };
      afterFrame.push(paint);
      recorder.start(100);
      setTimeout(function () { recorder.stop(); }, duration);
    });
  }
  // ------------------------------------------------------------ lockstep film
  // Filming in the page rather than over CDP. The devtools screencast hands
  // over about eight frames a second no matter what resolution or quality it
  // is asked for, which forces the capture clock to stretch a 30s take across
  // two minutes of wall clock and still leaves the footage too sparse to use
  // without a motion-interpolation pass that costs as long again. Here the
  // recorder sits next to the game: one captured frame for every frame the
  // game draws, at whatever rate the box can render, so the take costs about
  // what it costs to play it.
  //
  // The trade is that this records the canvas, not the document, so a game
  // whose HUD lives in DOM must still be filmed over CDP.
  var film = null;

  function startFilm(opts) {
    if (film) return filmStatus();
    if (typeof MediaRecorder === "undefined") throw new Error("MediaRecorder is not supported");
    var src = largestCanvas();
    if (!src) throw new Error("No canvas to film");
    var o = opts || {};
    // Film a copy, not the game's own canvas. Streaming the game canvas
    // directly looks cheaper — no readback — but measured worse (623 frames
    // landed of 903 handed, against 678 through the copy): capturing a WebGL
    // drawing buffer has to catch it before the next draw, and misses more
    // often than the copy costs. The copy also fixes the output size and
    // paints the page's own backdrop behind a canvas that doesn't fill it.
    var dest = document.createElement("canvas");
    dest.setAttribute("data-tesana-film", "1");
    dest.width = Math.max(2, Number(o.width) || src.width || 1920);
    dest.height = Math.max(2, Number(o.height) || src.height || 1080);
    var ctx = dest.getContext("2d", { alpha: false, desynchronized: true });
    if (!ctx) throw new Error("No 2d context to film into");
    if (typeof dest.captureStream !== "function") throw new Error("captureStream is not supported");
    // Rate 0 means the stream carries only the frames we hand it, so the
    // compositor cannot drop a frame the game drew or repeat one it didn't.
    var stream = dest.captureStream(0);
    var track = stream.getVideoTracks()[0];
    if (!track || typeof track.requestFrame !== "function") throw new Error("captureStream cannot be driven frame by frame");
    // H.264 first: it is the only one of these with a hardware encoder behind
    // it, and a software encoder that cannot keep up with 1080p60 silently
    // drops the frames it misses rather than slowing down.
    var wanted = o.mimeType ? [String(o.mimeType)] : [
      "video/mp4;codecs=avc1.640028", "video/mp4;codecs=avc1", "video/mp4",
      "video/webm;codecs=vp8", "video/webm;codecs=vp9", "video/webm",
    ];
    var mimeType = wanted.filter(function (t) { return MediaRecorder.isTypeSupported(t); })[0];
    var options = { videoBitsPerSecond: Number(o.bitrate) || 24e6 };
    if (mimeType) options.mimeType = mimeType;
    var recorder = new MediaRecorder(stream, options);
    var chunks = [];
    recorder.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
    film = {
      frames: 0, chunks: chunks, recorder: recorder, stream: stream,
      track: track, ctx: ctx, dest: dest, running: true, paused: false,
      blob: null, startedAt: performance.now(),
    };
    function shoot() {
      if (!film || !film.running) return;
      var live = largestCanvas();
      if (live) {
        paintPageBackdrop(ctx, dest.width, dest.height);
        try { ctx.drawImage(live, 0, 0, dest.width, dest.height); } catch (e) { /* tainted / lost context */ }
      }
      // Called from afterFrame, so the drawing buffer is still the frame the
      // game just drew.
      track.requestFrame();
      film.frames++;
      afterFrame.push(shoot);
    }
    recorder.start();
    if (qa) qa.recording = true;
    afterFrame.push(shoot);
    return filmStatus();
  }

  function stopFilm() {
    return new Promise(function (resolve, reject) {
      if (!film) return reject(new Error("Not filming"));
      var current = film;
      if (!current.running) return resolve(filmStatus());
      current.running = false;
      current.recorder.onstop = function () {
        current.stream.getTracks().forEach(function (t) { t.stop(); });
        if (qa) qa.recording = false;
        current.blob = new Blob(current.chunks, { type: current.recorder.mimeType || "video/webm" });
        resolve(filmStatus());
      };
      current.recorder.onerror = function () { reject(new Error("MediaRecorder error")); };
      try { current.recorder.stop(); } catch (e) { reject(e); }
    });
  }

  // Stopping the game does not stop the recording: the stream simply carries
  // no new frames, and MediaRecorder holds the last one for as long as the
  // pause lasts. A take that stops to think between every move would be
  // mostly held frames. Pausing the recorder leaves that time out of the
  // recording altogether, so the file contains the game and nothing else.
  function pauseFilm() {
    if (!film || !film.running || film.paused) return filmStatus();
    try { film.recorder.pause(); } catch (e) { return filmStatus(); }
    film.paused = true;
    return filmStatus();
  }

  function resumeFilm() {
    if (!film || !film.running || !film.paused) return filmStatus();
    try { film.recorder.resume(); } catch (e) { /* nothing to resume */ }
    film.paused = false;
    return filmStatus();
  }

  function filmStatus() {
    if (!film) return { filming: false, paused: false, frames: 0, bytes: 0, mimeType: null, realMs: 0 };
    return {
      filming: Boolean(film.running),
      paused: Boolean(film.paused),
      frames: film.frames,
      bytes: film.blob ? film.blob.size : 0,
      mimeType: film.recorder.mimeType || "video/webm",
      realMs: performance.now() - film.startedAt,
    };
  }

  // The finished take is tens of megabytes, so it leaves the page in slices
  // rather than as one string the bridge has to hold twice over.
  function filmSlice(offset, length) {
    return new Promise(function (resolve, reject) {
      if (!film || !film.blob) return reject(new Error("Nothing filmed"));
      var start = Math.max(0, Number(offset) || 0);
      var end = Math.min(film.blob.size, start + (Number(length) || 0));
      var reader = new FileReader();
      reader.onload = function () {
        // readAsDataURL gives "data:...;base64,<payload>".
        var text = String(reader.result);
        resolve(text.slice(text.indexOf(",") + 1));
      };
      reader.onerror = function () { reject(new Error("FileReader failed")); };
      reader.readAsDataURL(film.blob.slice(start, end));
    });
  }

  // A small still of the take in progress. Two parts of the rig have to see
  // what is on screen while it films — the check for a player who has walked
  // into a wall, and the model steering the take — and neither needs 1080p.
  // Scaling it down keeps that off the critical path.
  //
  // Only while filming, deliberately. The mirror is drawn inside the game's
  // own animation frame, which is the one moment a WebGL canvas can be read:
  // its drawing buffer is cleared once the browser composites it, so the
  // same drawImage from outside a frame hands back solid black. Anything
  // needing a still before the take rolls takes a real screenshot instead.
  function filmStill(maxWidth) {
    if (!film) return null;
    var src = film.dest;
    var w = Math.max(16, Math.min(src.width, Number(maxWidth) || 768));
    var h = Math.max(9, Math.round(src.height * (w / src.width)));
    var small = document.createElement("canvas");
    small.setAttribute("data-tesana-film", "1"); // never film our own still
    small.width = w;
    small.height = h;
    var sctx = small.getContext("2d");
    if (!sctx) return null;
    try {
      sctx.drawImage(src, 0, 0, w, h);
      return small.toDataURL("image/jpeg", 0.7);
    } catch (e) {
      return null;
    }
  }

  function discardFilm() {
    if (film && film.running) {
      film.running = false;
      try { film.stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) { /* already gone */ }
      try { film.recorder.stop(); } catch (e) { /* already stopped */ }
      if (qa) qa.recording = false;
    }
    film = null;
    return { filming: false, frames: 0, bytes: 0, mimeType: null, realMs: 0 };
  }

  function errorText(e) { return e instanceof Error ? e.message : String(e); }
  window.addEventListener("message", function (event) {
    var msg = event.data;
    if (!msg || typeof msg !== "object" || typeof msg.type !== "string") return;
    switch (msg.type) {
      case "set-muted":
        muted = Boolean(msg.muted);
        return applyAudio();
      case "set-volume": {
        var v = Number(msg.volume);
        volume = isFinite(v) ? Math.min(1, Math.max(0, v)) : 1;
        return applyAudio();
      }
      case "capture-screenshot":
        return captureDataUrl().then(
          function (dataUrl) { post({ type: "screenshot-result", dataUrl: dataUrl }); },
          function (e) { post({ type: "screenshot-result", dataUrl: null, error: errorText(e) }); },
        );
      case "get-console-logs":
        return post({ type: "console-logs-result", logs: ring.slice() });
      case "start-recording":
        return record(msg.durationMs || msg.duration).then(
          function (r) { post({ type: "recording-result", dataUrl: r.dataUrl, mimeType: r.mimeType, durationMs: r.durationMs }); },
          function (e) { post({ type: "recording-result", dataUrl: null, error: errorText(e) }); },
        );
      case "activity-status":
        return post({ type: "activity-status-result", active: lastInputAt !== null && Date.now() - lastInputAt <= ACTIVITY_WINDOW_MS, lastInputAt: lastInputAt, phase: ready ? "running" : "loading" });
    }
  });

  // ---------------------------------------------------------------- overlay, watermark, readiness
  var CSS =
    ".tesana-overlay{position:fixed;inset:0;z-index:2147483000;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:22px;color:#fff;background:#0b0d12 center/cover no-repeat;font:500 16px system-ui,-apple-system,Segoe UI,Roboto,sans-serif;text-align:center;transition:opacity 280ms ease}" +
    ".tesana-overlay[data-hide]{opacity:0;pointer-events:none}" +
    ".tesana-overlay__shade{position:absolute;inset:0;background:linear-gradient(180deg,rgba(0,0,0,.25),rgba(0,0,0,.7))}" +
    ".tesana-overlay__title{position:relative;margin:0;font-size:clamp(26px,5vw,42px);font-weight:700;letter-spacing:.02em;text-shadow:0 2px 18px rgba(0,0,0,.7);max-width:80vw}" +
    ".tesana-overlay__logo{position:relative;max-width:min(70vw,360px);max-height:28vh;object-fit:contain}" +
    ".tesana-overlay__bar{position:relative;width:min(60vw,320px);height:6px;border-radius:999px;background:rgba(255,255,255,.18);overflow:hidden}" +
    ".tesana-overlay__bar::after{content:'';position:absolute;top:0;bottom:0;left:-40%;width:40%;border-radius:999px;background:#7c5cff;animation:tesana-slide 1.1s ease-in-out infinite}" +
    "@keyframes tesana-slide{to{left:100%}}" +
    // Watermark geometry = Godot's presets/_shared.py (#tesana-watermark / -inner / img): full-viewport
    // fixed layer → 16:9 box fitted (contain) and centred via margin:auto → badge 11.5% of the box width,
    // bottom-right, margins 2.25% right / 1.5% bottom. Hidden until ready. One deliberate departure
    // (orchestrator 2026-09-08, mobile push): narrower than 16:9 (phones in portrait) the box is anchored
    // to the bottom edge instead of centred — Godot's rule puts the badge mid-screen there — and the badge
    // keeps a 96px minimum so it stays legible at 390px wide. Desktop 16:9 is unchanged (box == viewport).
    ".tesana-watermark{display:none;position:fixed;top:0;left:0;width:100vw;height:100vh;justify-content:flex-end;align-items:flex-end;z-index:2147483001;pointer-events:none;user-select:none}" +
    ".tesana-watermark[data-ready]{display:flex}" +
    ".tesana-watermark__inner{position:relative;width:100vw;height:56.25vw;max-width:100vw;max-height:100vh;aspect-ratio:16/9;margin:auto;display:flex;justify-content:flex-end;align-items:flex-end}" +
    ".tesana-watermark__img{width:11.5%;height:auto;display:block;margin-bottom:1.5%;margin-right:2.25%}" +
    "@media (max-aspect-ratio:16/9){.tesana-watermark__inner{width:100vw;height:auto;max-height:100vh;margin-bottom:0;padding-bottom:env(safe-area-inset-bottom,0px)}.tesana-watermark__img{min-width:96px}}" +
    "@media (min-aspect-ratio:16/9){.tesana-watermark__inner{height:100vh;width:auto;max-width:100vw}}" +
    // Text fallback (PNG missing at build): same anchor, the previous 11px badge.
    ".tesana-watermark__text{display:block;margin-bottom:1.5%;margin-right:2.25%;font:500 11px system-ui,sans-serif;color:rgba(255,255,255,.55);letter-spacing:.04em;text-shadow:0 1px 4px rgba(0,0,0,.6)}";
  var ready = false, overlay = null, watermark = null;
  function el(tag, className, parent) {
    var node = document.createElement(tag);
    node.className = className;
    parent.appendChild(node);
    return node;
  }
  function mountDom() {
    document.head.appendChild(document.createElement("style")).textContent = CSS;
    overlay = el("div", "tesana-overlay", document.getElementById("game") || document.body);
    overlay.setAttribute("role", "status");
    if (meta.posterUrl) {
      overlay.style.backgroundImage = 'url("' + meta.posterUrl + '")';
      el("div", "tesana-overlay__shade", overlay);
    }
    if (meta.logoUrl) { var img = el("img", "tesana-overlay__logo", overlay); img.alt = title; img.src = meta.logoUrl; }
    else el("h1", "tesana-overlay__title", overlay).textContent = title;
    el("div", "tesana-overlay__bar", overlay);
    if (!meta.disableWatermark && !qaRig) mountWatermark();
  }
  function mountWatermark() {
    // On <body>, not #game: games that re-render #game must not lose the badge.
    watermark = el("div", "tesana-watermark", document.body);
    watermark.id = "tesana-watermark"; // same hook as Godot's overlay
    watermark.setAttribute("aria-hidden", "true");
    var inner = el("div", "tesana-watermark__inner", watermark);
    if (meta.watermarkUrl) {
      var img = el("img", "tesana-watermark__img", inner);
      img.alt = "Made on Tesana";
      img.draggable = false;
      img.src = meta.watermarkUrl;
    } else {
      el("span", "tesana-watermark__text", inner).textContent = "Made on Tesana";
    }
  }
  function markReady() {
    if (ready) return;
    ready = qa.ready = true;
    if (overlay) { overlay.setAttribute("data-hide", ""); setTimeout(function () { overlay.remove(); }, 320); }
    if (watermark) watermark.setAttribute("data-ready", ""); // Godot reveals it when its loading screen goes, too
    post({ type: "tesana-ready", version: VERSION, adapter: meta.gameType === "3d" ? "three" : "phaser" });
  }
  // A frame is "real" once a 16×9 downscale of the largest canvas is not flat (luminance variance).
  var probe = document.createElement("canvas");
  probe.width = 16; probe.height = 9;
  var probeCtx = probe.getContext("2d", { willReadFrequently: true });
  function frameHasContent() {
    var canvas = largestCanvas();
    if (!canvas || !probeCtx) return false;
    try {
      probeCtx.drawImage(canvas, 0, 0, 16, 9);
      var d = probeCtx.getImageData(0, 0, 16, 9).data, sum = 0, sq = 0, n = d.length / 4;
      for (var i = 0; i < d.length; i += 4) { var lum = (d[i] + d[i + 1] + d[i + 2]) / 3; sum += lum; sq += lum * lum; }
      var mean = sum / n;
      return sq / n - mean * mean > 4;
    } catch (e) { return false; }
  }
  function readinessProbe() {
    if (ready) return;
    if (frameCount % 3 === 0 && frameHasContent()) return markReady();
    afterFrame.push(readinessProbe);
  }
  function start() {
    mountDom();
    afterFrame.push(readinessProbe);
    setTimeout(markReady, READY_TIMEOUT_MS);
  }
  if (document.body) start(); else document.addEventListener("DOMContentLoaded", start);

  // ---------------------------------------------------------------- QA hooks
  var KEYS = { Space: [" ", 32], Enter: ["Enter", 13], Escape: ["Escape", 27], Tab: ["Tab", 9], Backspace: ["Backspace", 8], ArrowLeft: ["ArrowLeft", 37], ArrowUp: ["ArrowUp", 38], ArrowRight: ["ArrowRight", 39], ArrowDown: ["ArrowDown", 40], ShiftLeft: ["Shift", 16], ShiftRight: ["Shift", 16], ControlLeft: ["Control", 17], ControlRight: ["Control", 17], AltLeft: ["Alt", 18], AltRight: ["Alt", 18] };
  function keyInfo(code) {
    var m;
    if (KEYS[code]) return { key: KEYS[code][0], keyCode: KEYS[code][1] };
    if ((m = /^Key([A-Z])$/.exec(code))) return { key: m[1].toLowerCase(), keyCode: m[1].charCodeAt(0) };
    if ((m = /^(?:Digit|Numpad)(\d)$/.exec(code))) return { key: m[1], keyCode: 48 + Number(m[1]) };
    return { key: code, keyCode: 0 };
  }
  function injectKey(code, down) {
    var info = keyInfo(String(code));
    var init = { code: String(code), key: info.key, keyCode: info.keyCode, which: info.keyCode, bubbles: true, cancelable: true };
    // One event dispatched on the focused element (or body) bubbles through document to window, so
    // Phaser's keyboard plugin (window listener) and plain document/element listeners each see it once.
    (document.activeElement || document.body).dispatchEvent(new KeyboardEvent(down ? "keydown" : "keyup", init));
    if (down) noteInput();
  }
  function injectTap(x, y) {
    var target = document.elementFromPoint(x, y) || document.body;
    var init = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, pointerId: 1, pointerType: "mouse", isPrimary: true };
    [["pointerdown", 1], ["mousedown", 1], ["pointerup", 0], ["mouseup", 0], ["click", 0]].forEach(function (pair) {
      init.buttons = pair[1];
      var Ctor = pair[0].indexOf("pointer") === 0 && typeof PointerEvent === "function" ? PointerEvent : MouseEvent;
      target.dispatchEvent(new Ctor(pair[0], init));
    });
    noteInput();
  }
  // ------------------------------------------------------------- mouse look
  // Headless Chromium refuses requestPointerLock: there is no focused OS
  // window to confine a cursor to. Nearly every 3D game gates its mouse-look
  // on document.pointerLockElement, so a recorded take can walk but never
  // turn — it films whichever wall it drifts into. Under the recorder we
  // grant the lock the game asked for and deliver look as movement deltas,
  // which is the input a real pointer lock would have produced. A human
  // never reaches this: nothing here runs until the rig calls engageLook.
  var lockTarget = null;
  var lockShimmed = false;
  /** The element the game last asked to lock, held even after it lets go.
   *
   * Games release the lock when they open a menu, and dying opens a menu.
   * Guessing the biggest canvas to re-take is not good enough: this game
   * locks a wrapper div and checks for it by identity, so a lock handed to
   * the canvas inside it reads as no lock at all and every look event is
   * ignored for the rest of the take. What the game asked for once is what
   * it will accept again.
   */
  var lockAsked = null;

  /** The held element, or null once the game has thrown it away.
   *
   * Games rebuild their canvas on resize and on restart. A lock still
   * pointing at the detached one would report held while every delta went
   * to an element nothing is listening to — a frozen camera again.
   */
  function liveLock() {
    if (lockTarget && lockTarget.isConnected === false) lockTarget = null;
    return lockTarget;
  }

  /** The element a game would most likely lock — its biggest canvas. */
  function lookTarget() {
    if (liveLock()) return lockTarget;
    if (lockAsked && lockAsked.isConnected !== false) return lockAsked;
    var best = null;
    var area = -1;
    var all = document.getElementsByTagName("canvas");
    for (var i = 0; i < all.length; i++) {
      var a = (all[i].clientWidth || 0) * (all[i].clientHeight || 0);
      if (a > area) { area = a; best = all[i]; }
    }
    return best || document.body;
  }

  function engageLook() {
    if (lockShimmed) return lookStatus();
    lockShimmed = true;
    // Grant the lock to whichever element the game asks for, so its own
    // `pointerLockElement === myCanvas` check passes untouched.
    Element.prototype.requestPointerLock = function () {
      lockTarget = this;
      lockAsked = this;
      document.dispatchEvent(new Event("pointerlockchange"));
      return Promise.resolve();
    };
    Object.defineProperty(document, "pointerLockElement", {
      configurable: true,
      get: function () { return liveLock(); },
    });
    document.exitPointerLock = function () {
      lockTarget = null;
      document.dispatchEvent(new Event("pointerlockchange"));
    };
    return lookStatus();
  }

  /** Claim the lock for the game's canvas without waiting for a click. */
  function claimLook() {
    if (!lockShimmed) engageLook();
    if (!liveLock()) {
      lockTarget = lookTarget();
      document.dispatchEvent(new Event("pointerlockchange"));
    }
    return lookStatus();
  }

  function injectLook(dx, dy) {
    // Take the lock back if the game has let go of it since the last look.
    // Delivering the event anyway would be a no-op — the game checks it
    // holds the lock before reading a delta — and the rig would be left
    // with a camera that answers the mouse until the first death and never
    // again, which is a take that films whatever it happened to be facing.
    if (lockShimmed && !liveLock()) claimLook();
    var target = liveLock() || lookTarget();
    var box = (target.getBoundingClientRect && target.getBoundingClientRect()) || {};
    var init = {
      bubbles: true, cancelable: true,
      clientX: (box.left || 0) + (box.width || 0) / 2,
      clientY: (box.top || 0) + (box.height || 0) / 2,
      movementX: Number(dx) || 0,
      movementY: Number(dy) || 0,
      button: 0, buttons: 0, pointerId: 1, pointerType: "mouse", isPrimary: true,
    };
    // The deltas are the whole point — a locked pointer reports movement, not
    // position, and that is what look handlers read. Pinned on after
    // construction because not every engine's MouseEvent honours them as
    // constructor arguments, and a look event without them turns nothing.
    function withMovement(event) {
      if (event.movementX !== init.movementX) {
        try {
          Object.defineProperty(event, "movementX", { value: init.movementX });
          Object.defineProperty(event, "movementY", { value: init.movementY });
        } catch (e) { /* frozen event: the constructor values stand */ }
      }
      return event;
    }
    if (typeof PointerEvent === "function") {
      target.dispatchEvent(withMovement(new PointerEvent("pointermove", init)));
    }
    target.dispatchEvent(withMovement(new MouseEvent("mousemove", init)));
    noteInput();
    return true;
  }

  function lookStatus() {
    var held = liveLock();
    return {
      shimmed: lockShimmed,
      locked: Boolean(held),
      target: held ? (held.tagName || "").toLowerCase() : null,
    };
  }

  // ------------------------------------------------------------------- world
  // What is actually out there, for a recorded take that has to navigate it.
  // A driver working from the picture alone cannot tell a pillar it is
  // wedged against from open floor: one take spent twelve of its fifteen
  // seconds grinding into the same cylinder, its own notes reading "movement
  // blocked, trying a different direction" while it guessed headings.
  //
  // Three's Scene and WebGLRenderer constructors both announce themselves on
  // __THREE_DEVTOOLS__, the hook its browser extension uses. The shell is a
  // classic script and the game a module, so the shell always runs first and
  // catches them — no cooperation needed from the game, and nothing for a
  // game author to remember. Games that are not three (Phaser, 2D) simply
  // never fire it and the probe reports nothing.
  var world = { scene: null, renderer: null, camera: null };
  //: Bounded so a scene with thousands of meshes cannot stall a take or
  //: overflow the bridge. Sorted by distance, so the cap keeps what is near.
  var WORLD_MAX_OBJECTS = 60, WORLD_MAX_INSTANCES = 24, WORLD_RANGE = 60;

  function watchThree() {
    var existing = window.__THREE_DEVTOOLS__;
    // Someone debugging the game has the extension installed; stamping on
    // its hook would break it and gain us nothing. One of ours, though, is a
    // previous shell whose captured scene belongs to a dead closure.
    if (existing && !existing.tesana) return;
    var hook = new EventTarget();
    hook.tesana = true;
    hook.addEventListener("observe", function (event) {
      var found = event && event.detail;
      if (!found || typeof found !== "object") return;
      if (found.isScene) world.scene = found;
      else if (found.isWebGLRenderer && !world.renderer) {
        world.renderer = found;
        // The camera is not announced, it is an argument. Wrapping render is
        // the only way to learn which of possibly several is the live one.
        var render = found.render;
        if (typeof render === "function") {
          found.render = function (scene, camera) {
            if (camera && camera.isCamera) world.camera = camera;
            if (scene && scene.isScene) world.scene = scene;
            return render.apply(this, arguments);
          };
        }
      }
    });
    window.__THREE_DEVTOOLS__ = hook;
  }

  /** World-space half extents of an object: [x, y, z].
   *
   * The local bounding box will not do. A game's floor is a PlaneGeometry
   * lying in XY and rotated flat, so untransformed it reads as a wall 28 m
   * tall and infinitely thin; the arena's actual walls are long thin boxes
   * that, reduced to a single radius, read as discs swallowing the level.
   * Both mislead a driver about where it can walk, so the eight corners go
   * through the object's world matrix and the extents come off the result.
   */
  function extents(object, Vector3) {
    var geometry = object.geometry;
    if (!geometry) return null;
    if (!geometry.boundingBox && typeof geometry.computeBoundingBox === "function") {
      try { geometry.computeBoundingBox(); } catch (e) { return null; }
    }
    var box = geometry.boundingBox;
    if (!box) return null;
    var lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    var corner = new Vector3();
    for (var i = 0; i < 8; i++) {
      corner.set(i & 1 ? box.max.x : box.min.x,
                 i & 2 ? box.max.y : box.min.y,
                 i & 4 ? box.max.z : box.min.z);
      if (object.matrixWorld) corner.applyMatrix4(object.matrixWorld);
      var axes = [corner.x, corner.y, corner.z];
      for (var k = 0; k < 3; k++) {
        if (axes[k] < lo[k]) lo[k] = axes[k];
        if (axes[k] > hi[k]) hi[k] = axes[k];
      }
    }
    if (!isFinite(lo[0]) || !isFinite(hi[0])) return null;
    return [Math.round((hi[0] - lo[0]) / 2 * 100) / 100,
            Math.round((hi[1] - lo[1]) / 2 * 100) / 100,
            Math.round((hi[2] - lo[2]) / 2 * 100) / 100];
  }

  function tint(object) {
    var material = object.material;
    if (Array.isArray(material)) material = material[0];
    if (!material || !material.color || typeof material.color.getHexString !== "function") return null;
    try { return "#" + material.color.getHexString(); } catch (e) { return null; }
  }

  function place(vector) {
    return [Math.round(vector.x * 100) / 100,
            Math.round(vector.y * 100) / 100,
            Math.round(vector.z * 100) / 100];
  }

  /** Every instance of an instanced mesh, as separate actors.
   *
   * Collectibles are usually one instanced mesh — eight orbs in a single
   * draw call. Reported as one object it looks like a single thing at the
   * origin, which is worse than not reporting it.
   */
  function instances(object, Vector3, Matrix4, out) {
    var matrix = new Matrix4();
    var position = new Vector3();
    var scale = new Vector3();
    var instanceSize = extents(object, Vector3);
    var count = Math.min(object.count || 0, WORLD_MAX_INSTANCES);
    for (var i = 0; i < count; i++) {
      try {
        object.getMatrixAt(i, matrix);
        position.setFromMatrixPosition(matrix);
        scale.setFromMatrixScale(matrix);
      } catch (e) { break; }
      // A collected orb is scaled to nothing rather than removed, which is
      // exactly the difference between a target and a target already taken.
      if (Math.max(scale.x, scale.y, scale.z) < 0.05) continue;
      position.applyMatrix4(object.matrixWorld);
      out.push({
        kind: "instance", name: object.name || "", at: place(position),
        size: instanceSize, colour: tint(object),
        shape: (object.geometry && object.geometry.type) || null,
      });
    }
  }

  /** A digest of the live scene: where things are and how big they are. */
  function probeWorld() {
    var scene = world.scene;
    if (!scene || typeof scene.traverse !== "function") {
      return { ok: false, why: "no three.js scene in this page" };
    }
    var camera = world.camera;
    // Reached through the scene's own objects so the shell never imports or
    // bundles three, and works against whatever revision the game shipped.
    var Vector3 = scene.position && scene.position.constructor;
    if (!Vector3) return { ok: false, why: "scene has no readable vectors" };
    var Matrix4 = scene.matrixWorld && scene.matrixWorld.constructor;
    var eye = new Vector3();
    var aim = new Vector3();
    if (camera) {
      camera.getWorldPosition(eye);
      camera.getWorldDirection(aim);
    }
    var actors = [];
    var position = new Vector3();
    scene.traverse(function (object) {
      if (!object || object.isLight || object.isCamera || object.isScene) return;
      if (object.visible === false) return;
      if (object.isInstancedMesh && Matrix4) return instances(object, Vector3, Matrix4, actors);
      if (!object.isMesh) return;
      object.getWorldPosition(position);
      if (camera && position.distanceTo(eye) > WORLD_RANGE) return;
      actors.push({
        kind: "mesh", name: object.name || "", at: place(position),
        size: extents(object, Vector3), colour: tint(object),
        shape: (object.geometry && object.geometry.type) || null,
      });
    });
    if (camera) {
      actors.sort(function (a, b) {
        var da = Math.hypot(a.at[0] - eye.x, a.at[2] - eye.z);
        var db = Math.hypot(b.at[0] - eye.x, b.at[2] - eye.z);
        return da - db;
      });
    }
    return {
      ok: true,
      camera: camera ? {
        at: place(eye),
        // Compass bearing of the way the camera looks, degrees clockwise
        // from -Z, which is the axis every three camera looks down at rest.
        heading: Math.round(Math.atan2(aim.x, -aim.z) * 180 / Math.PI),
        pitch: Math.round(Math.asin(Math.max(-1, Math.min(1, aim.y))) * 180 / Math.PI),
      } : null,
      actors: actors.slice(0, WORLD_MAX_OBJECTS),
      truncated: actors.length > WORLD_MAX_OBJECTS,
    };
  }

  function worldStatus() {
    return {
      scene: Boolean(world.scene),
      camera: Boolean(world.camera),
      renderer: Boolean(world.renderer),
    };
  }

  watchThree();

  var qa = {
    ready: false,
    recording: false,
    version: VERSION,
    screenshot: captureDataUrl,
    stats: function () { return { fps: Math.round(fps * 10) / 10, canvases: document.getElementsByTagName("canvas").length }; },
    inject: function (actions) {
      return (Array.isArray(actions) ? actions : []).reduce(function (chain, action) {
        return chain.then(function () {
          if (!action) return;
          if (action.type === "key") injectKey(action.code, Boolean(action.down));
          else if (action.type === "tap") injectTap(Number(action.x) || 0, Number(action.y) || 0);
          else if (action.type === "look") injectLook(action.dx, action.dy);
          else if (action.type === "wait") return new Promise(function (r) { setTimeout(r, Math.max(0, Number(action.ms) || 0)); });
        });
      }, Promise.resolve());
    },
    record: record,
    world: {
      probe: probeWorld,
      status: worldStatus,
    },
    look: {
      engage: engageLook,
      claim: claimLook,
      move: injectLook,
      status: lookStatus,
    },
    film: {
      start: startFilm,
      stop: stopFilm,
      pause: pauseFilm,
      resume: resumeFilm,
      status: filmStatus,
      still: filmStill,
      slice: filmSlice,
      discard: discardFilm,
    },
    clock: {
      engage: engageCaptureClock,
      release: releaseCaptureClock,
      grant: grantCaptureCredit,
      rate: setCaptureClockRate,
      status: clockStatus,
    },
  };
  window["__TESANA_QA__"] = qa;
})();
