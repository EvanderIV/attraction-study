/* ==========================================================================
   Device fingerprint for duplicate-submission prevention.

   Strategy: combine signals that are stable across browsers/incognito on the
   same physical device (screen geometry, GPU renderer string, CPU cores,
   device memory, timezone, platform) with renderer-level entropy (canvas +
   audio hashes). Browser-specific bits like the full user agent are kept OUT
   of the cross-browser hash so Chrome vs. Firefox on one machine collide,
   which is exactly what we want. A secondary browser-scoped hash is included
   for diagnostics.

   This is best-effort deterrence, not a security boundary.
   ========================================================================== */

(function (global) {
  "use strict";

  // FNV-1a 32-bit — sync fallback when crypto.subtle is unavailable
  // (e.g. non-localhost plain HTTP).
  function fnv1a(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h * 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, "0");
  }

  async function sha256(str) {
    if (global.crypto && crypto.subtle) {
      try {
        const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
        return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
      } catch (e) { /* fall through */ }
    }
    // Weak but deterministic fallback: chain FNV over shifted copies.
    return fnv1a(str) + fnv1a(str + "|1") + fnv1a(str + "|2") + fnv1a(str + "|3");
  }

  function canvasSignal() {
    try {
      const c = document.createElement("canvas");
      c.width = 240; c.height = 60;
      const ctx = c.getContext("2d");
      if (!ctx) return "nocanvas";
      ctx.textBaseline = "alphabetic";
      ctx.fillStyle = "#f60";
      ctx.fillRect(90, 4, 80, 40);
      ctx.fillStyle = "#069";
      ctx.font = "15px 'Arial'";
      ctx.fillText("AttractionStudy \u{1F498} 4.2", 4, 30);
      ctx.fillStyle = "rgba(102, 204, 0, 0.7)";
      ctx.font = "17px 'Times New Roman'";
      ctx.fillText("fingerprint", 8, 48);
      ctx.beginPath();
      ctx.arc(200, 30, 18, 0, Math.PI * 1.7);
      ctx.strokeStyle = "#7a5";
      ctx.stroke();
      return c.toDataURL();
    } catch (e) {
      return "nocanvas";
    }
  }

  function webglSignal() {
    try {
      const c = document.createElement("canvas");
      const gl = c.getContext("webgl") || c.getContext("experimental-webgl");
      if (!gl) return "nowebgl";
      const dbg = gl.getExtension("WEBGL_debug_renderer_info");
      const vendor = dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR);
      const renderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
      return vendor + "~" + renderer + "~" + gl.getParameter(gl.MAX_TEXTURE_SIZE);
    } catch (e) {
      return "nowebgl";
    }
  }

  // OfflineAudioContext render hash — stable per audio stack, no sound played.
  function audioSignal() {
    return new Promise((resolve) => {
      try {
        const AC = global.OfflineAudioContext || global.webkitOfflineAudioContext;
        if (!AC) return resolve("noaudio");
        const ctx = new AC(1, 44100, 44100);
        const osc = ctx.createOscillator();
        osc.type = "triangle";
        osc.frequency.value = 10000;
        const comp = ctx.createDynamicsCompressor();
        osc.connect(comp);
        comp.connect(ctx.destination);
        osc.start(0);
        const timer = setTimeout(() => resolve("audiotimeout"), 1200);
        ctx.startRendering().then((buf) => {
          clearTimeout(timer);
          const data = buf.getChannelData(0);
          let sum = 0;
          for (let i = 4500; i < 5000; i++) sum += Math.abs(data[i]);
          resolve(sum.toFixed(6));
        }).catch(() => { clearTimeout(timer); resolve("audiofail"); });
      } catch (e) {
        resolve("noaudio");
      }
    });
  }

  async function compute() {
    const s = global.screen || {};
    const deviceSignals = [
      // Cross-browser-stable, device-bound signals only:
      s.width + "x" + s.height + "x" + (s.colorDepth || 0) + "x" + (global.devicePixelRatio || 1),
      navigator.hardwareConcurrency || 0,
      navigator.deviceMemory || 0,
      navigator.platform || "",
      (navigator.maxTouchPoints || 0) > 0 ? "touch" : "notouch",
      Intl.DateTimeFormat().resolvedOptions().timeZone || "",
      new Date().getTimezoneOffset(),
      webglSignal(),
      canvasSignal(),
      await audioSignal(),
    ].join("||");

    const deviceHash = await sha256(deviceSignals);
    const browserHash = await sha256(deviceSignals + "||" + navigator.userAgent + "||" + (navigator.language || ""));

    return {
      device: deviceHash,     // used server-side for cross-browser dedup
      browser: browserHash,   // diagnostics only
    };
  }

  global.StudyFingerprint = { compute };
})(window);
