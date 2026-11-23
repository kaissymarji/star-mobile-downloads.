/* STAR MOBILE • ECU Universe entrance. Visual only: never intercepts product or download links. */
(() => {
  "use strict";

  const DURATION_MS = 4350;
  const overlayId = "sm-portal-overlay";
  let overlay, canvas, ctx, skipButton, phaseLabel;
  let running = false;
  let rafId = 0;
  let fadeTimer = 0;
  let tasks = [];
  let stars = [];
  let width = 0, height = 0, pixelRatio = 1;
  let lastPaint = 0, begin = 0;
  let windowResizeListening = false;
  const TWO_PI = Math.PI * 2;
  const prefersReducedMotion = window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function makeOverlay() {
    const node = document.createElement("section");
    node.id = overlayId;
    node.className = "sm-portal";
    node.setAttribute("role", "dialog");
    node.setAttribute("aria-modal", "true");
    node.setAttribute("aria-label", "Entering Star Mobile ECU Command Center");
    node.setAttribute("aria-hidden", "true");
    node.innerHTML = [
      '<div class="sm-portal-backdrop" aria-hidden="true"></div>',
      '<canvas class="sm-portal-canvas" aria-hidden="true"></canvas>',
      '<div class="sm-portal-vortex" aria-hidden="true"><div class="sm-portal-orbit"></div></div>',
      '<div class="sm-portal-core" aria-hidden="true"><div class="sm-portal-chip"><b>ECU</b><small>GATEWAY</small></div></div>',
      '<div class="sm-portal-scanline" aria-hidden="true"></div>',
      '<div class="sm-portal-ui">',
      '  <div class="sm-portal-top">',
      '    <div class="sm-portal-brand">STAR MOBILE SERVICE<span>SOFTWARE LAB // COMMAND CENTER</span></div>',
      '    <button class="sm-portal-skip" type="button">Skip Intro ↗</button>',
      '  </div>',
      '  <div class="sm-portal-copy">',
      '    <p class="sm-portal-eyebrow">WELCOME TO THE ECU UNIVERSE</p>',
      '    <h2 class="sm-portal-title">SYSTEM <em>PORTAL</em></h2>',
      '    <p class="sm-portal-subtitle">ENTERING THE ECU COMMAND CENTER</p>',
      '  </div>',
      '  <div class="sm-portal-bottom">',
      '    <div class="sm-portal-hud"><div class="sm-portal-phase" aria-live="off">INITIALIZING ECU GATEWAY...</div><div class="sm-portal-progress"><span></span></div></div>',
      '    <div class="sm-portal-indicator">VIRTUAL SYSTEM LINK // ONLINE</div>',
      '  </div>',
      '</div>',
      '<div class="sm-portal-gates" aria-hidden="true">',
      '  <div class="sm-portal-gate left"><span>ECU MATRIX</span></div>',
      '  <div class="sm-portal-gate right"><span>COMMAND CENTER</span></div>',
      '</div>'
    ].join("");
    document.body.appendChild(node);
    return node;
  }

  function addReplayButton() {
    const footerNav = document.querySelector(".bottom-links");
    if (!footerNav || document.getElementById("sm-portal-replay")) return;
    const replay = document.createElement("button");
    replay.type = "button";
    replay.id = "sm-portal-replay";
    replay.title = "Replay the ECU wormhole entrance";
    replay.textContent = "↻ Replay Wormhole";
    replay.addEventListener("click", () => start(true));
    footerNav.insertBefore(replay, footerNav.querySelector(".owner-dropdown"));
  }

  function setPhase(text) {
    if (phaseLabel) phaseLabel.textContent = text;
  }

  function schedule(fn, delay) {
    tasks.push(window.setTimeout(fn, delay));
  }

  function resize() {
    if (!canvas || !running) return;
    width = Math.max(1, window.innerWidth);
    height = Math.max(1, window.innerHeight);
    pixelRatio = Math.min(window.devicePixelRatio || 1, width < 700 ? 1.25 : 1.5);
    canvas.width = Math.round(width * pixelRatio);
    canvas.height = Math.round(height * pixelRatio);
    if (!ctx) return;
    ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  }

  function randomStar(z) {
    return {
      a: Math.random() * TWO_PI,
      r: 0.65 + Math.random() * 1.6,
      z: z === undefined ? 0.45 + Math.random() * 8 : z,
      v: 0.55 + Math.random() * 1.15,
      violet: Math.random() < 0.15
    };
  }

  function drawFrame(now) {
    if (!running || !ctx) return;
    rafId = window.requestAnimationFrame(drawFrame);
    if (now - lastPaint < 31) return; // ~30 fps cap to protect older phones.
    const dt = Math.min(0.06, (now - (lastPaint || now)) / 1000);
    lastPaint = now;
    const elapsed = (now - begin) / 1000;
    const warp = Math.min(1, elapsed / 3.0);
    const cx = width / 2, cy = height / 2;
    const basis = Math.min(width, height);
    ctx.clearRect(0, 0, width, height);

    // A luminous vanishing point: the tunnel is drawn toward the page beneath it.
    const halo = ctx.createRadialGradient(cx, cy, 2, cx, cy, basis * 0.65);
    halo.addColorStop(0, "rgba(104,255,252,.55)");
    halo.addColorStop(0.09, "rgba(25,155,240,.35)");
    halo.addColorStop(0.35, "rgba(4,64,120,.15)");
    halo.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = halo;
    ctx.fillRect(cx - basis, cy - basis, basis * 2, basis * 2);

    // Nested, rotating energy tunnels; no external WebGL library required.
    ctx.save();
    ctx.translate(cx, cy);
    const ringMotion = (elapsed * (0.75 + warp * 1.15)) % 1;
    for (let i = 15; i >= 0; i--) {
      const depth = ((i + ringMotion) / 16) * 6.8 + 0.40;
      const radius = Math.min(basis * 1.5, basis * 0.62 / (depth * 0.55 + 0.23));
      const rotation = elapsed * (0.20 + i * 0.012);
      const alpha = Math.min(0.77, 0.10 + 0.6 / (depth + 0.25));
      ctx.beginPath();
      ctx.setLineDash(i % 2 ? [radius * .30, radius * .11] : [radius * .14, radius * .085]);
      ctx.lineDashOffset = -elapsed * (24 + i * 2);
      ctx.ellipse(0, 0, radius, radius * 0.84, rotation, 0, TWO_PI);
      ctx.strokeStyle = i % 4 === 0 ? "rgba(172,126,255," + alpha + ")" : "rgba(42,237,255," + alpha + ")";
      ctx.lineWidth = Math.min(2.5, 0.6 + (7 - depth) * .18);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // Point-light streaks move from the center toward the viewer.
    const velocity = 0.56 + warp * 2.15;
    for (let i = 0; i < stars.length; i++) {
      const p = stars[i];
      p.z -= dt * velocity * p.v;
      if (p.z < .17) {
        stars[i] = randomStar(7.1 + Math.random() * 1.4);
        continue;
      }
      const twist = p.a + elapsed * 0.17 * (1 / (p.z + 0.55));
      const scale = basis * p.r * 0.32;
      const r1 = Math.min(basis * 2, scale / (p.z * 0.72 + 0.16));
      const r2 = Math.min(basis * 2, scale / ((p.z + 0.38 + warp * 0.27) * 0.72 + 0.16));
      const x1 = Math.cos(twist) * r1, y1 = Math.sin(twist) * r1 * 0.86;
      const x2 = Math.cos(twist - 0.03) * r2, y2 = Math.sin(twist - 0.03) * r2 * 0.86;
      const opacity = Math.min(.95, .22 + .95 / (p.z + .35));
      ctx.beginPath();
      ctx.moveTo(x2, y2);
      ctx.lineTo(x1, y1);
      ctx.strokeStyle = p.violet ? "rgba(179,150,255," + opacity + ")" : "rgba(92,240,255," + opacity + ")";
      ctx.lineWidth = Math.min(3, Math.max(.65, 2.8 / (p.z + .45)));
      ctx.stroke();
    }
    ctx.restore();

    // Four faint HUD crosshairs frame the destination.
    const bracket = Math.min(basis * .48, 270);
    ctx.strokeStyle = "rgba(91,243,255,.3)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx - bracket, cy - bracket * .48);
    ctx.lineTo(cx - bracket, cy - bracket * .74);
    ctx.lineTo(cx - bracket * .81, cy - bracket * .74);
    ctx.moveTo(cx + bracket, cy + bracket * .48);
    ctx.lineTo(cx + bracket, cy + bracket * .74);
    ctx.lineTo(cx + bracket * .81, cy + bracket * .74);
    ctx.stroke();
  }

  function installResize() {
    if (windowResizeListening) return;
    window.addEventListener("resize", resize, { passive: true });
    windowResizeListening = true;
  }
  function removeResize() {
    if (!windowResizeListening) return;
    window.removeEventListener("resize", resize);
    windowResizeListening = false;
  }

  function finish() {
    if (!running) return;
    running = false;
    for (const timer of tasks) window.clearTimeout(timer);
    tasks = [];
    window.cancelAnimationFrame(rafId);
    rafId = 0;
    removeResize();
    document.documentElement.classList.remove("sm-portal-lock");
    document.body.classList.remove("sm-portal-lock");
    overlay.classList.add("sm-finished");
    // Never leave a transparent overlay intercepting clicks.
    overlay.setAttribute("aria-hidden", "true");
    if (skipButton && document.activeElement === skipButton) {
      skipButton.blur();
      const home = document.querySelector(".identity");
      if (home && typeof home.focus === "function") {
        try { home.focus({ preventScroll: true }); } catch (_) {}
      }
    }
    fadeTimer = window.setTimeout(() => {
      overlay.classList.remove("sm-on", "sm-opening", "sm-finished");
      fadeTimer = 0;
    }, 480);
  }

  function start(isReplay) {
    if (running) return;
    // Play on every fresh homepage visit (previous visits no longer suppress it).
    // Direct #section links skip it so buyers can still reach their requested tool.
    // ?intro=1 explicitly forces the intro for testing or sharing.
    const forceIntro = new URLSearchParams(window.location.search).get("intro") === "1";
    if (!isReplay && !forceIntro && window.location.hash && window.location.hash !== "#home") return;
    if (!overlay) return;

    if (fadeTimer) { window.clearTimeout(fadeTimer); fadeTimer = 0; }
    for (const timer of tasks) window.clearTimeout(timer);
    tasks = [];
    running = true;
    overlay.classList.remove("sm-finished", "sm-opening", "sm-on");
    // Force the progress animation to restart when someone replays the portal.
    void overlay.offsetWidth;
    overlay.classList.add("sm-on");
    overlay.setAttribute("aria-hidden", "false");
    document.documentElement.classList.add("sm-portal-lock");
    document.body.classList.add("sm-portal-lock");
    setPhase("INITIALIZING ECU GATEWAY...");
    try { skipButton.focus({ preventScroll: true }); }
    catch (_) { skipButton.focus(); }

    begin = window.performance.now();
    lastPaint = 0;
    if (!prefersReducedMotion && ctx) {
      stars = Array.from({ length: window.innerWidth < 650 ? 135 : 220 }, () => randomStar());
      resize();
      installResize();
      rafId = window.requestAnimationFrame(drawFrame);
    }

    if (prefersReducedMotion) {
      setPhase("COMMAND CENTER READY");
      schedule(finish, 1400);
      return;
    }

    schedule(() => setPhase("ESTABLISHING VIRTUAL DATA LINK..."), 700);
    schedule(() => setPhase("TRAVERSING ECU DATASTREAM..."), 1600);
    schedule(() => setPhase("COMMAND CENTER ACQUIRED"), 2750);
    schedule(() => {
      overlay.classList.add("sm-opening");
      setPhase("ACCESS GRANTED — WELCOME");
    }, 3200);
    schedule(finish, DURATION_MS);
  }

  function init() {
    if (document.getElementById(overlayId)) return;
    // The Command Center and its existing scripts are never modified by this module.
    overlay = makeOverlay();
    canvas = overlay.querySelector(".sm-portal-canvas");
    skipButton = overlay.querySelector(".sm-portal-skip");
    phaseLabel = overlay.querySelector(".sm-portal-phase");
    try { ctx = canvas.getContext("2d", { alpha: true, desynchronized: true }); }
    catch (_) { ctx = null; }
    skipButton.addEventListener("click", finish);
    overlay.addEventListener("keydown", event => {
      if (event.key === "Escape") { event.preventDefault(); finish(); }
      // Keep keyboard focus on the Skip button while the overlay is visible.
      if (event.key === "Tab" && running) { event.preventDefault(); skipButton.focus(); }
    });
    // Do not dismiss the intro just because Android briefly hides Chrome
    // while switching from a link or another app.
    addReplayButton();
    const topReplay = document.getElementById("sm-portal-trigger");
    if (topReplay) topReplay.addEventListener("click", () => start(true));
    // Keep the catalog immediately accessible. The intro is opt-in or explicitly shared.
    if (new URLSearchParams(window.location.search).get("intro") === "1") start(false);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
