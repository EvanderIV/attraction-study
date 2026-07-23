/* ==========================================================================
   The Attraction Study — quiz engine

   Custom transform-based "wheel" (no native scroll) so we fully control:
   - snap physics (spring toward the target card, always snappy)
   - gating (you cannot pass an unanswered card; blocked attempts shake it
     and pulse the breathing indicators)
   - parallax (background layers track wheel position via a CSS var)

   Perf tiers: html.perf-high / perf-mid / perf-low set from hardware hints
   plus a live frame-time probe. Low tier drops blur/3D/breathing animation.
   ========================================================================== */

(function () {
  "use strict";

  const STORAGE_KEY = "attraction_study_v1";
  const API = "api.php";

  const wheel = document.getElementById("wheel");
  const bgEl = document.getElementById("bg");
  const navPrev = document.getElementById("nav-prev");
  const navNext = document.getElementById("nav-next");
  const toastEl = document.getElementById("toast");

  // ---- State ------------------------------------------------------------

  const state = {
    answers: {},          // questionId -> value
    index: 0,             // current card
    done: false,          // submitted successfully
    fp: null,             // fingerprint {device, browser}
    alreadySubmitted: false,
    submitting: false,
    stats: null,          // aggregate stats fetched after submission
  };

  let deck = [];          // current card definitions
  let profile = null;     // derived respondent profile
  let cardEls = [];       // DOM nodes parallel to deck

  // Share-link presets: short opaque params prefill demographics and skip
  // those questions. ?s=<sexuality>&r=<religion>, either alone is fine.
  //   s: s=Straight  h=Homosexual  p=Pansexual  b=Bisexual
  //   r: cn=Christian j=Jewish m=Muslim n=Atheist/Agnostic o=Other x=Prefer not to say
  // Unrecognized codes are ignored (the question is asked normally).
  // Presets are flagged in submission meta so preset rows can be separated
  // from self-reported ones during analysis.
  const SEX_CODES = { s: "Straight", h: "Homosexual", p: "Pansexual", b: "Bisexual" };
  const REL_CODES = { cn: "Christian", j: "Jewish", m: "Muslim", n: "Atheist / Agnostic", o: "Other", x: "Prefer not to say" };
  const urlParams = new URLSearchParams(location.search);
  const presetSexuality = SEX_CODES[(urlParams.get("s") || "").toLowerCase()] || null;
  const presetReligion = REL_CODES[(urlParams.get("r") || "").toLowerCase()] || null;

  // Wheel motion: time-based tween (not a spring — springs jolt on frame 1).
  let pos = 0;            // continuous position (card units)
  let target = 0;         // settle target
  let animFrom = 0;       // tween start position
  let animStart = 0;      // tween start timestamp
  let animDur = 0;        // tween duration ms
  let dragging = false;
  let rafId = null;

  // Ease-out quart: responds instantly (most of the travel happens in the
  // first ~150ms, like the spring did) but decelerates into a soft landing
  // instead of a hard stop. Fast feel, no jolt at the end.
  function smoother(t) {
    const u = 1 - t;
    return 1 - u * u * u * u;
  }

  function startAnim() {
    animFrom = pos;
    animStart = performance.now();
    const dist = Math.abs(target - pos);
    // ~330ms for a one-card move; slightly longer for multi-card flights.
    animDur = dist < 0.001 ? 0 : 210 + 120 * Math.min(dist, 2);
    kickPhysics();
  }

  // ---- Persistence ------------------------------------------------------

  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        answers: state.answers,
        index: state.index,
        done: state.done,
      }));
    } catch (e) { /* private mode with no quota — quiz still works in-memory */ }
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const s = JSON.parse(raw);
      if (s && typeof s === "object") {
        state.answers = s.answers || {};
        state.index = s.index | 0;
        state.done = !!s.done;
      }
    } catch (e) { /* corrupted — start fresh */ }
  }

  // ---- Performance tiers ------------------------------------------------

  function initPerfTier() {
    const html = document.documentElement;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const mem = navigator.deviceMemory || 8;        // undefined on FF/Safari -> assume ok
    const cores = navigator.hardwareConcurrency || 8;

    let tier = "high";
    if (reduced || mem <= 2 || cores <= 2) tier = "low";
    else if (mem <= 4 || cores <= 4) tier = "mid";
    html.classList.add("perf-" + tier);

    // Live probe: if real frame times are bad, demote after ~1.5s regardless
    // of what the hardware hints claimed.
    if (tier !== "low") {
      let frames = 0, slow = 0, last = performance.now();
      function probe(now) {
        const dt = now - last;
        last = now;
        frames++;
        if (dt > 26) slow++;                       // < ~38fps frame
        if (frames < 80) requestAnimationFrame(probe);
        else if (slow / frames > 0.35) {
          html.classList.remove("perf-high", "perf-mid");
          html.classList.add("perf-low");
        }
      }
      requestAnimationFrame(probe);
    }
    return tier;
  }

  const perfTier = initPerfTier();
  const use3D = perfTier === "high";

  // ---- Toast ------------------------------------------------------------

  // Short haptic tick when a question is COMPLETED (unanswered -> answered).
  // Fires once per completion, not per tap — a consistent reward signal.
  // No-ops silently where unsupported (iOS Safari, desktops).
  function buzz() {
    if (navigator.vibrate) {
      try { navigator.vibrate(12); } catch (e) { /* blocked by browser policy */ }
    }
  }

  let toastTimer = null;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("show"), 2200);
  }

  // ---- Answer completeness ----------------------------------------------

  function isAnswered(card) {
    if (!card) return false;
    if (["info", "statpct", "scatter", "share"].includes(card.type)) return true;
    if (card.optional) return true;   // never gates the wheel (see dwell lock in go)
    if (card.type === "submit") return state.done;
    const a = state.answers[card.id];
    if (a === undefined || a === null) return false;
    if (card.type === "multi") return Array.isArray(a) && a.length > 0;
    if (card.type === "diagram") {
      return card.parts.every((p) => a && a[p.id] !== undefined);
    }
    if (card.type === "text") return typeof a === "string" && a.trim().length >= 3;
    return true;
  }

  // Furthest card the user may travel to: first unanswered card.
  function maxReachable() {
    for (let i = 0; i < deck.length; i++) {
      if (!isAnswered(deck[i])) return i;
    }
    return deck.length - 1;
  }

  // ---- Deck / DOM building ----------------------------------------------

  function rebuildDeck(keepIndex) {
    if (presetSexuality && !state.answers.sexuality) {
      state.answers.sexuality = presetSexuality;
    }
    if (presetReligion && !state.answers.religion) {
      state.answers.religion = presetReligion;
    }
    const built = window.StudyQuestions.buildDeck(state.answers, {
      hideSexuality: !!presetSexuality,
      hideReligion: !!presetReligion,
    });
    deck = built.deck;
    profile = built.profile;

    // After submission, the wheel keeps going: personalized results cards.
    if (state.done && state.stats) {
      deck = deck.concat(buildResultCards(state.stats, deck));
    }

    wheel.innerHTML = "";
    cardEls = deck.map((card, i) => {
      const el = renderCard(card, i);
      wheel.appendChild(el);
      return el;
    });

    const max = maxReachable();
    state.index = Math.min(keepIndex !== undefined ? keepIndex : state.index, max);
    armDwell(deck[state.index]);   // restored onto an optional card
    target = state.index;
    if (Math.abs(pos - target) > 3) pos = target;   // avoid long flights after rebuild
    updateChrome();
    startAnim();
  }

  function el(tag, cls, html) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html !== undefined) e.innerHTML = html;
    return e;
  }

  function renderCard(card, idx) {
    const root = el("article", "card is-off");
    root.dataset.idx = idx;
    const inner = el("div", "card-inner");
    root.appendChild(inner);

    if (card.emoji) inner.appendChild(el("div", "emoji-hero", card.emoji));
    if (card.kicker) inner.appendChild(el("div", "card-kicker", card.kicker));
    if (card.title) inner.appendChild(el("h2", "card-title", card.title));
    if (card.sub) inner.appendChild(el("p", "card-sub", card.sub));

    const body = el("div", "card-body");
    inner.appendChild(body);

    switch (card.type) {
      case "info":    renderInfo(card, body, inner); break;
      case "choice":  renderChoice(card, body); break;
      case "multi":   renderMulti(card, body, inner); break;
      case "scale":   renderScale(card, body); break;
      case "likert":  renderLikert(card, body); break;
      case "diagram": renderDiagram(card, body, inner); break;
      case "text":    renderText(card, body, inner); break;
      case "submit":  renderSubmit(card, body, inner); break;
      case "statpct": renderStatPct(card, body); break;
      case "scatter": renderScatter(card, body); break;
      case "share":   renderShare(card, body); break;
    }
    return root;
  }

  function footNext(label) {
    const foot = el("div", "card-foot");
    foot.appendChild(el("span", "hint", "Scroll or swipe to move between cards"));
    const btn = el("button", "btn", label || "Next");
    btn.type = "button";
    btn.addEventListener("click", () => go(state.index + 1));
    foot.appendChild(btn);
    return { foot, btn };
  }

  function renderInfo(card, body, inner) {
    const { foot } = footNext(card.cta || "Continue");
    inner.appendChild(foot);
  }

  function renderChoice(card, body) {
    const list = el("div", "choices");
    (card.options || []).forEach((opt) => {
      const b = el("button", "choice", `<span class="dot"></span><span>${opt}</span>`);
      b.type = "button";
      if (state.answers[card.id] === opt) b.classList.add("selected");
      b.addEventListener("click", () => {
        const wasAnswered = state.answers[card.id] !== undefined;
        state.answers[card.id] = opt;
        if (!wasAnswered) buzz();
        list.querySelectorAll(".choice").forEach((c) => c.classList.remove("selected"));
        b.classList.add("selected");

        // Onboarding answers change the branch/wording downstream.
        const isOnboarding = ["bio_sex", "sexuality", "attracted_to"].includes(card.id);
        saveState();
        if (isOnboarding) {
          // Drop answers to questions whose wording may have changed context.
          rebuildDeck(state.index);
        }
        // Snappy auto-advance — no extra gesture needed after picking.
        setTimeout(() => { if (state.index === idxOf(card.id)) go(state.index + 1); }, 320);
      });
      list.appendChild(b);
    });
    body.appendChild(list);
  }

  function renderMulti(card, body, inner) {
    const list = el("div", "choices");
    const current = () => state.answers[card.id] || [];
    (card.options || []).forEach((opt) => {
      const b = el("button", "choice multi", `<span class="dot"></span><span>${opt}</span>`);
      b.type = "button";
      if (current().includes(opt)) b.classList.add("selected");
      b.addEventListener("click", () => {
        const hadAny = current().length > 0;
        let sel = current().slice();
        if (sel.includes(opt)) sel = sel.filter((o) => o !== opt);
        else if (sel.length < (card.maxPicks || 99)) sel.push(opt);
        else { toast(`Pick at most ${card.maxPicks}. Deselect one first.`); return; }
        state.answers[card.id] = sel;
        if (!hadAny && sel.length > 0) buzz();
        b.classList.toggle("selected", sel.includes(opt));
        nextBtn.disabled = sel.length === 0;
        saveState();
        updateChrome();
      });
      list.appendChild(b);
    });
    body.appendChild(list);
    const { foot, btn } = footNext("Next");
    const nextBtn = btn;
    nextBtn.disabled = current().length === 0;
    inner.appendChild(foot);
  }

  function renderScale(card, body) {
    // Bipolar scales (lean between two poles) show unnumbered circles and a
    // single picked position; intensity scales show a numbered fill-up track.
    const track = el("div", "scale-track" + (card.bipolar ? " bipolar" : ""));
    const cells = [];
    for (let v = card.min; v <= card.max; v++) {
      const c = el("button", "scale-cell" + (card.bipolar ? " circle" : ""), card.bipolar ? "" : String(v));
      c.type = "button";
      c.setAttribute("aria-label", card.bipolar
        ? `Position ${v} of ${card.max}, between "${card.lowLabel}" and "${card.highLabel}"`
        : `${v} of ${card.max}`);
      c.addEventListener("click", () => {
        const wasAnswered = state.answers[card.id] !== undefined;
        state.answers[card.id] = v;
        if (!wasAnswered) buzz();
        paint(v);
        saveState();
        setTimeout(() => { if (state.index === idxOf(card.id)) go(state.index + 1); }, 340);
      });
      cells.push(c);
      track.appendChild(c);
    }
    function paint(v) {
      cells.forEach((c, i) => {
        c.classList.toggle("lit", card.bipolar ? card.min + i === v : card.min + i <= v);
        c.classList.toggle("picked", card.min + i === v);
      });
    }
    if (state.answers[card.id] !== undefined) paint(state.answers[card.id]);
    body.appendChild(track);
    body.appendChild(el("div", "scale-labels",
      `<span>${card.lowLabel || card.min}</span><span>${card.highLabel || card.max}</span>`));
  }

  // 5-point agree/disagree: circles grow with distance from the neutral
  // center, Strongly Disagree on the left, Strongly Agree on the right.
  function renderLikert(card, body) {
    const LABELS = ["Strongly disagree", "Disagree", "Neutral", "Agree", "Strongly agree"];
    const track = el("div", "scale-track likert");
    const cells = [];
    for (let v = 1; v <= 5; v++) {
      const dist = Math.abs(v - 3);            // 0 center … 2 at the poles
      const c = el("button", `scale-cell circle d${dist}`, "");
      c.type = "button";
      c.setAttribute("aria-label", LABELS[v - 1]);
      c.addEventListener("click", () => {
        const wasAnswered = state.answers[card.id] !== undefined;
        state.answers[card.id] = v;
        if (!wasAnswered) buzz();
        paint(v);
        saveState();
        setTimeout(() => { if (state.index === idxOf(card.id)) go(state.index + 1); }, 340);
      });
      cells.push(c);
      track.appendChild(c);
    }
    function paint(v) {
      cells.forEach((c, i) => {
        c.classList.toggle("lit", i + 1 === v);
        c.classList.toggle("picked", i + 1 === v);
      });
    }
    if (state.answers[card.id] !== undefined) paint(state.answers[card.id]);
    body.appendChild(track);
    body.appendChild(el("div", "scale-labels",
      `<span>Strongly disagree</span><span>Strongly agree</span>`));
  }

  function renderDiagram(card, body, inner) {
    const wrap = el("div", "diagram-wrap" + (card.figure ? "" : " no-figure"));
    let svgBox = null;
    if (card.figure) {
      svgBox = el("div", "figure-box", card.figure);
      wrap.appendChild(svgBox);
    }
    const rows = el("div", "parts");
    wrap.appendChild(rows);
    body.appendChild(wrap);

    const vals = () => state.answers[card.id] || {};

    function syncVisuals() {
      const v = vals();
      card.parts.forEach((p) => {
        const row = rows.querySelector(`[data-part="${p.id}"]`);
        const done = v[p.id] !== undefined;
        row.classList.toggle("filled", done);
        row.classList.toggle("breathing", !done);
        row.querySelector(".part-val").textContent = done ? v[p.id] + " / " + card.scaleMax : "";
        if (svgBox) {
          const shape = svgBox.querySelector(`[data-region="${p.id}"]`);
          if (shape) {
            shape.classList.toggle("filled", done);
            shape.classList.toggle("breathing", !done);
          }
        }
      });
      const complete = card.parts.every((p) => v[p.id] !== undefined);
      nextBtn.disabled = !complete;
      if (complete) navNext.classList.add("pulse");
      else navNext.classList.remove("pulse");
    }

    card.parts.forEach((p) => {
      const row = el("div", "part-row");
      row.dataset.part = p.id;
      row.appendChild(el("div", "part-name", `<span>${p.label}</span><span class="part-val"></span>`));
      const pips = el("div", "pips");
      for (let v = 1; v <= card.scaleMax; v++) {
        const pip = el("button", "pip", String(v));
        pip.type = "button";
        pip.setAttribute("aria-label", `${p.label}: ${v} of ${card.scaleMax}`);
        pip.addEventListener("click", () => {
          const wasComplete = card.parts.every((pp) => vals()[pp.id] !== undefined);
          const cur = Object.assign({}, vals());
          cur[p.id] = v;
          state.answers[card.id] = cur;
          if (!wasComplete && card.parts.every((pp) => cur[pp.id] !== undefined)) buzz();
          pips.querySelectorAll(".pip").forEach((pp, i) => pp.classList.toggle("lit", i < v));
          saveState();
          syncVisuals();
          updateChrome();
        });
        pips.appendChild(pip);
      }
      row.appendChild(pips);
      rows.appendChild(row);
      const existing = vals()[p.id];
      if (existing !== undefined) {
        pips.querySelectorAll(".pip").forEach((pp, i) => pp.classList.toggle("lit", i < existing));
      }
    });

    const { foot, btn } = footNext("Next");
    const nextBtn = btn;
    inner.appendChild(foot);
    syncVisuals();
  }

  // ---- Personalized results ---------------------------------------------

  // Phrase pools are sampled at build time, so two friends comparing screens
  // (or one user refreshing) see differently-worded versions of their stats.
  const AGREE_TMPL = [
    (p, s) => `You and ${p} of people agree — ${s}.`,
    (p, s) => `${p} of respondents stand with you: ${s}.`,
    (p, s) => `It’s not just you. ${p} of people also say ${s}.`,
    (p, s) => `You called it, and so did ${p} of the crowd: ${s}.`,
  ];
  const DISAGREE_TMPL = [
    (p, s) => `You and ${p} of people push back on the idea that ${s}.`,
    (p, s) => `${p} of respondents, like you, don’t buy that ${s}.`,
    (p, s) => `Skeptics club: ${p} of people also doubt that ${s}.`,
  ];
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

  // "My Wife should…" -> "my Wife should…" (statements embed mid-sentence)
  function embedStatement(title) {
    let s = title.replace(/[.。]\s*$/, "");
    if (!/^I\b|^I’|^I'/.test(s)) s = s[0].toLowerCase() + s.slice(1);
    return s;
  }

  function pctText(same, tot) {
    return tot >= 10 ? Math.round((same / tot) * 100) + "%" : `${same} of the ${tot}`;
  }

  const PAIR_META = {
    self_expect: {
      title: "Self-focus vs. expectations",
      x: "Self-focus score",
      y: "Expectations of a partner",
      theme: "how much people expect from a partner",
    },
    self_looks: {
      title: "Self-focus vs. looks",
      x: "Self-focus score",
      y: "Importance of looks",
      theme: "how much looks matter to people",
    },
    extra_comm: {
      title: "Extraversion vs. communication",
      x: "Extraversion score",
      y: "Communication importance",
      theme: "how much people value communication",
    },
  };

  function interpret(meta, fit) {
    const r = fit.r;
    const strength = Math.abs(r) > 0.5 ? "strongly" : Math.abs(r) > 0.25 ? "moderately" : "slightly";
    if (Math.abs(r) < 0.12) return `So far there’s no real link between these two — self-contained mysteries.`;
    return r > 0
      ? `These ${strength} rise together: higher scores on the first go with ${meta.theme} being higher too (r = ${r}).`
      : `These ${strength} pull in opposite directions: the higher the first, the lower ${meta.theme} (r = ${r}).`;
  }

  function buildResultCards(stats, builtDeck) {
    const cards = [];
    cards.push({
      id: "_r_intro", type: "info", emoji: "📊", kicker: "Your results",
      title: "How you compare",
      sub: `Your answers, side by side with ${stats.n} response${stats.n === 1 ? "" : "s"} so far. Keep scrolling.`,
      cta: "Show me",
    });

    // Agreement cards: likert statements where the user took a side.
    const cands = [];
    for (const c of builtDeck) {
      if (c.type !== "likert") continue;
      const mine = state.answers[c.id];
      if (mine === undefined || mine === 3) continue;
      const d = stats.dist[c.id];
      if (!d) continue;
      let same = 0, tot = 0;
      for (const [val, cnt] of Object.entries(d)) {
        const v = +val;
        tot += cnt;
        if ((mine > 3 && v > 3) || (mine < 3 && v < 3)) same += cnt;
      }
      if (tot < 2) continue;
      cands.push({ card: c, mine, same, tot, ratio: same / tot });
    }
    // Most-shared opinions first, then shuffle within the shortlist so the
    // card mix varies between users too.
    cands.sort((a, b) => b.ratio - a.ratio);
    const shortlist = cands.slice(0, 6).sort(() => Math.random() - 0.5).slice(0, 4);
    shortlist.forEach((c, i) => {
      const tmpl = pick(c.mine > 3 ? AGREE_TMPL : DISAGREE_TMPL);
      cards.push({
        id: "_r_agree_" + i, type: "statpct", kicker: "Crowd check",
        big: pctText(c.same, c.tot),
        text: tmpl(pctText(c.same, c.tot), embedStatement(c.card.title)),
      });
    });

    // One first-impression stat from the choice distributions.
    const fn = state.answers.first_notice;
    const fnDist = stats.dist.first_notice;
    if (fn && fnDist) {
      let same = 0, tot = 0;
      for (const [opt, cnt] of Object.entries(fnDist)) { tot += cnt; if (opt === fn) same += cnt; }
      if (tot >= 2) {
        cards.push({
          id: "_r_notice", type: "statpct", kicker: "Crowd check",
          big: pctText(same, tot),
          text: `${pctText(same, tot)} of people also look at ${fn.toLowerCase()} first. Eyes up.`,
        });
      }
    }

    // Correlation scatter cards.
    for (const [pid, pair] of Object.entries(stats.pairs || {})) {
      const meta = PAIR_META[pid];
      if (!meta || !pair.fit || !pair.you || pair.points.length < 3) continue;
      cards.push({
        id: "_r_pair_" + pid, type: "scatter", kicker: "Correlation",
        title: meta.title, pair, meta,
        sub: interpret(meta, pair.fit),
      });
    }

    cards.push({
      id: "_r_share", type: "share", emoji: "💬", kicker: "That’s you",
      title: "Compare notes",
      sub: "Send the quiz to a friend and compare crowd stats — the wording shuffles between people, the numbers don’t.",
      fantasies: Array.isArray(stats.fantasies) ? stats.fantasies : [],
    });
    return cards;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (m) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
  }

  // ---- Share card --------------------------------------------------------

  const SHARE_URL = "https://eminich.com/s/attr-study";
  const SHARE_URL_DISPLAY = "eminich.com/s/attr-study";

  async function copyText(t) {
    try {
      await navigator.clipboard.writeText(t);
      return true;
    } catch (e) {
      // Legacy fallback for older mobile browsers
      try {
        const ta = document.createElement("textarea");
        ta.value = t;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand("copy");
        ta.remove();
        return ok;
      } catch (e2) {
        return false;
      }
    }
  }

  function renderShare(card, body) {
    // Public fantasies from similar respondents of the same biological sex,
    // server-filtered before they ever reach the client.
    if (card.fantasies && card.fantasies.length) {
      const list = el("div", "fantasy-list");
      list.appendChild(el("div", "fantasy-head", "Unspoken fantasies from people like you"));
      card.fantasies.forEach((f) => {
        list.appendChild(el("blockquote", "fantasy-quote", "“" + escapeHtml(f) + "”"));
      });
      body.appendChild(list);
    }

    const row = el("div", "share-row");
    row.appendChild(el("span", "share-link", SHARE_URL_DISPLAY));
    const copyBtn = el("button", "copy-btn",
      `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>`);
    copyBtn.type = "button";
    copyBtn.setAttribute("aria-label", "Copy quiz link");
    copyBtn.addEventListener("click", async () => {
      const ok = await copyText(SHARE_URL);
      if (ok) {
        buzz();
        toast("Link copied to your clipboard");
      } else {
        toast("Couldn’t copy — long-press the link instead");
      }
    });
    row.appendChild(copyBtn);
    body.appendChild(row);

    const shareBtn = el("button", "btn share-cta", "Share the quiz");
    shareBtn.type = "button";
    shareBtn.addEventListener("click", async () => {
      if (navigator.share) {
        try {
          await navigator.share({
            title: "The Attraction Study",
            text: "What do you actually find attractive? Quick, anonymous quiz:",
            url: SHARE_URL,
          });
        } catch (e) { /* user dismissed the sheet — not an error */ }
      } else {
        const ok = await copyText(SHARE_URL);
        toast(ok ? "Link copied — paste it anywhere" : "Couldn’t copy — long-press the link instead");
        if (ok) buzz();
      }
    });
    body.appendChild(shareBtn);
  }

  function renderStatPct(card, body) {
    body.appendChild(el("div", "stat-big", card.big));
    body.appendChild(el("p", "stat-text", card.text));
  }

  function renderScatter(card, body) {
    const { points, fit, you } = card.pair;
    const W = 340, H = 230, m = { l: 36, r: 14, t: 14, b: 34 };
    const all = points.concat([you]);
    let xmin = Math.min(...all.map((p) => p[0])) - 0.4;
    let xmax = Math.max(...all.map((p) => p[0])) + 0.4;
    let ymin = Math.min(...all.map((p) => p[1])) - 0.4;
    let ymax = Math.max(...all.map((p) => p[1])) + 0.4;
    const sx = (x) => m.l + ((x - xmin) / (xmax - xmin)) * (W - m.l - m.r);
    const sy = (y) => H - m.b - ((y - ymin) / (ymax - ymin)) * (H - m.t - m.b);
    // Deterministic jitter de-stacks integer-grid points.
    const jit = (i) => ((((i * 9301 + 49297) % 233280) / 233280) - 0.5) * 8;

    let dots = "";
    points.forEach((p, i) => {
      dots += `<circle class="pt" cx="${(sx(p[0]) + jit(i)).toFixed(1)}" cy="${(sy(p[1]) + jit(i + 7)).toFixed(1)}" r="3.2"/>`;
    });
    const yAt = (x) => Math.max(ymin, Math.min(ymax, fit.slope * x + fit.intercept));
    const trend = `<line class="trend" x1="${sx(xmin).toFixed(1)}" y1="${sy(yAt(xmin)).toFixed(1)}" x2="${sx(xmax).toFixed(1)}" y2="${sy(yAt(xmax)).toFixed(1)}"/>`;
    const youDot = `<circle class="you-dot" cx="${sx(you[0]).toFixed(1)}" cy="${sy(you[1]).toFixed(1)}" r="6"/>` +
      `<text class="you-lbl" x="${(sx(you[0]) + 10).toFixed(1)}" y="${(sy(you[1]) + 4).toFixed(1)}">You</text>`;

    const svg =
      `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${card.meta.title} scatter plot">` +
      `<line class="ax" x1="${m.l}" y1="${H - m.b}" x2="${W - m.r}" y2="${H - m.b}"/>` +
      `<line class="ax" x1="${m.l}" y1="${m.t}" x2="${m.l}" y2="${H - m.b}"/>` +
      `<text class="axlbl" x="${(m.l + W - m.r) / 2}" y="${H - 8}" text-anchor="middle">${card.meta.x} →</text>` +
      `<text class="axlbl" transform="rotate(-90 12 ${(m.t + H - m.b) / 2})" x="12" y="${(m.t + H - m.b) / 2}" text-anchor="middle">${card.meta.y} →</text>` +
      dots + trend + youDot +
      `<text class="axlbl" x="${W - m.r}" y="${m.t + 6}" text-anchor="end">r = ${fit.r} · n = ${fit.n}</text>` +
      `</svg>`;
    body.appendChild(el("div", "scatter-wrap", svg));
  }

  async function fetchStats() {
    await ensureFingerprint();
    try {
      const res = await api("stats", {
        fingerprint: state.fp,
        // Christian respondents (self-selected or via r=cn preset) get the
        // stricter fantasy filter. The server also derives this from the
        // stored row, so a missing local answer can't weaken it.
        strict: state.answers.religion === "Christian",
      });
      if (res.ok) {
        state.stats = res;
        rebuildDeck(state.index);
        toast("Your results are ready — keep scrolling ↓");
      }
    } catch (e) { /* stats are a bonus; the thank-you stands alone */ }
  }

  // Free-text answer with a public-consent checkbox in the footer.
  // The public flag is stored alongside as "<id>_public" (default true).
  function renderText(card, body, inner) {
    const pubKey = card.id + "_public";
    if (state.answers[pubKey] === undefined) state.answers[pubKey] = true;

    const ta = document.createElement("textarea");
    ta.className = "text-input";
    ta.maxLength = 240;
    ta.rows = 3;
    ta.placeholder = card.placeholder || "";
    ta.value = state.answers[card.id] || "";
    ta.addEventListener("input", () => {
      const was = isAnswered(card);
      state.answers[card.id] = ta.value;
      if (!was && isAnswered(card)) buzz();
      nextBtn.disabled = !isAnswered(card);
      saveState();
      updateChrome();
    });
    body.appendChild(ta);

    const foot = el("div", "card-foot");
    const lab = el("label", "pub-check");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = state.answers[pubKey] !== false;
    cb.addEventListener("change", () => {
      state.answers[pubKey] = cb.checked;
      saveState();
    });
    lab.appendChild(cb);
    lab.appendChild(el("span", "pub-box",
      `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M4 12.5l5 5L20 6.5" fill="none" stroke="#0b0f1e" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`));
    lab.appendChild(el("span", "pub-label", "Share my answer publicly (anonymous)"));
    foot.appendChild(lab);

    const nextBtn = el("button", "btn", "Next");
    nextBtn.type = "button";
    nextBtn.disabled = !isAnswered(card);
    nextBtn.addEventListener("click", () => go(state.index + 1));
    foot.appendChild(nextBtn);
    inner.appendChild(foot);
  }

  function renderSubmit(card, body, inner) {
    if (state.done) {
      renderThanks(body);
      return;
    }
    // Compact review of key answers
    const review = el("div", "review-list");
    const show = [
      ["bio_sex", "Biological sex"],
      ["sexuality", "Sexuality"],
      ["religion", "Religion"],
      ["first_notice", "First notice"],
      ["single_feature", "Top feature"],
      ["humor_style", "Humor"],
    ];
    show.forEach(([id, label]) => {
      // Don't echo preset values back — the respondent never answered them.
      if (id === "sexuality" && presetSexuality) return;
      if (id === "religion" && presetReligion) return;
      if (state.answers[id] !== undefined) {
        review.appendChild(el("div", "review-item",
          `<span class="q">${label}</span><span class="a">${state.answers[id]}</span>`));
      }
    });
    body.appendChild(review);

    const errBox = el("div", "err-text");
    body.appendChild(errBox);

    const foot = el("div", "card-foot");
    foot.appendChild(el("span", "hint", "One response per device"));
    const btn = el("button", "btn", "Submit my answers");
    btn.type = "button";
    btn.addEventListener("click", async () => {
      if (state.submitting) return;
      state.submitting = true;
      errBox.textContent = "";
      btn.innerHTML = `<span class="spinner"></span>Sending…`;
      btn.disabled = true;
      try {
        const res = await submitAnswers();
        if (res.ok) {
          state.done = true;
          saveState();
          body.innerHTML = "";
          foot.remove();
          renderThanks(body);
          updateChrome();
          fetchStats();
        } else if (res.error === "duplicate") {
          state.done = true;   // treat as complete locally so they aren't stuck
          saveState();
          body.innerHTML = "";
          foot.remove();
          renderThanks(body, "It looks like this device already submitted a response — thanks for taking part!");
          fetchStats();
        } else {
          throw new Error(res.error || "Unknown error");
        }
      } catch (e) {
        errBox.textContent = "Couldn’t reach the server. Your answers are saved on this device — try again in a moment.";
        btn.innerHTML = "Try again";
        btn.disabled = false;
      } finally {
        state.submitting = false;
      }
    });
    foot.appendChild(btn);
    inner.appendChild(foot);
  }

  function renderThanks(body, msg) {
    body.appendChild(el("div", "emoji-hero", "💖"));
    body.appendChild(el("h2", "card-title ok-text", "Thank you!"));
    body.appendChild(el("p", "card-sub", msg ||
      (state.stats
        ? "Your response has been recorded."
        : "Your response has been recorded. Crunching your personalized results…")));
    if (state.stats) {
      const b = el("button", "btn", "See how you compare");
      b.type = "button";
      b.addEventListener("click", () => go(state.index + 1));
      body.appendChild(b);
    }
  }

  function idxOf(id) {
    return deck.findIndex((c) => c.id === id);
  }

  // ---- Wheel physics ----------------------------------------------------

  const SPACING = () => Math.min(window.innerHeight * 0.72, 560);

  function kickPhysics() {
    if (rafId === null) rafId = requestAnimationFrame(tick);
  }

  function tick() {
    rafId = null;
    if (!dragging) {
      const t = animDur > 0 ? Math.min(1, (performance.now() - animStart) / animDur) : 1;
      pos = t >= 1 ? target : animFrom + (target - animFrom) * smoother(t);
    }
    layout();
    if (dragging || pos !== target) kickPhysics();
  }

  function layout() {
    const spacing = SPACING();
    const settled = !dragging && pos === target;

    for (let i = 0; i < cardEls.length; i++) {
      const d = i - pos;                       // distance from center in card units
      const elCard = cardEls[i];
      if (Math.abs(d) > 1.6) {
        elCard.classList.add("is-off");
        continue;
      }
      elCard.classList.remove("is-off");

      // At rest, snap the front card to the PHYSICAL pixel grid and drop its
      // compositor layer so text re-rasterizes crisp. Snapping must use
      // devicePixelRatio: on scaled desktop displays (dpr 1.25/1.5) whole
      // CSS pixels are themselves fractional device pixels.
      if (settled && i === state.index) {
        const dpr = window.devicePixelRatio || 1;
        const snap = (v) => Math.round(v * dpr) / dpr;
        const tx = snap(window.innerWidth / 2 - elCard.offsetWidth / 2) - window.innerWidth / 2;
        const ty = snap(window.innerHeight / 2 - elCard.offsetHeight / 2) - window.innerHeight / 2;
        elCard.style.transform = `translate(${tx}px, ${ty}px)`;
        elCard.style.opacity = "1";
        elCard.style.willChange = "auto";
        elCard.classList.add("is-active");
        continue;
      }
      elCard.style.willChange = "transform, opacity";

      const y = d * spacing;
      let t;
      if (use3D) {
        const rot = Math.max(-55, Math.min(55, d * -38));   // wheel curvature
        const z = -Math.abs(d) * 160;
        const scale = 1 - Math.min(0.18, Math.abs(d) * 0.14);
        t = `translate(-50%, -50%) translate3d(0, ${y.toFixed(1)}px, ${z.toFixed(1)}px) rotateX(${rot.toFixed(2)}deg) scale(${scale.toFixed(3)})`;
      } else {
        const scale = 1 - Math.min(0.12, Math.abs(d) * 0.1);
        t = `translate(-50%, -50%) translateY(${y.toFixed(1)}px) scale(${scale.toFixed(3)})`;
      }
      elCard.style.transform = t;
      elCard.style.opacity = String(Math.max(0, 1 - Math.abs(d) * 0.75));
      elCard.classList.toggle("is-active", i === state.index);
    }
    // Parallax: background layers track wheel position at different rates.
    bgEl.style.setProperty("--scroll-shift", (pos * 60).toFixed(1));
    document.documentElement.style.setProperty("--hue-a", String(258 + pos * 14));
    document.documentElement.style.setProperty("--hue-b", String(190 + pos * 10));
    document.documentElement.style.setProperty("--hue-c", String(320 + pos * 12));
  }

  // ---- Navigation & gating ----------------------------------------------

  // Optional cards don't gate the wheel, but hold it briefly on FIRST
  // arrival (once per page session) so they're at least seen before they
  // can be flicked past. Revisits scroll through freely.
  let dwellLockUntil = 0;
  const dwelledCards = new Set();

  function armDwell(card) {
    if (card && card.optional && !dwelledCards.has(card.id)) {
      dwelledCards.add(card.id);
      dwellLockUntil = performance.now() + 500;
    }
  }

  function go(i, force) {
    const max = maxReachable();
    if (i < 0) i = 0;
    if (i >= deck.length) i = deck.length - 1;
    // Forward moves one card at a time (drag flicks can't skip an optional
    // card entirely); backward jumps and programmatic moves are unrestricted.
    if (!force && i > state.index + 1) i = state.index + 1;
    if (i > max) {
      blockedFeedback();
      i = max;
    }
    if (!force && i > state.index && deck[state.index] && deck[state.index].optional
        && performance.now() < dwellLockUntil) {
      i = state.index;   // still inside the dwell window — hold
    }
    if (i !== state.index) {
      state.index = i;
      saveState();
      armDwell(deck[i]);
    }
    target = i;
    updateChrome();
    startAnim();
  }

  function blockedFeedback() {
    const card = deck[state.index];
    const elCard = cardEls[state.index];
    if (elCard) {
      elCard.classList.remove("shake");
      void elCard.offsetWidth;                 // restart animation
      elCard.classList.add("shake");
    }
    if (card && card.type === "diagram") {
      toast("The glowing items still need a rating");
    } else if (card && card.type === "multi") {
      toast("Pick at least one option first");
    } else if (card && card.type !== "info" && card.type !== "submit") {
      toast("Answer this one first — it only takes a tap");
    }
  }

  function updateChrome() {
    // No progress bar / step count by design: showing quiz length up front
    // discourages completion.
    navPrev.classList.toggle("dim", state.index === 0);
    navNext.classList.toggle("dim", state.index >= deck.length - 1);
    if (deck[state.index] && isAnswered(deck[state.index]) && state.index < deck.length - 1) {
      navNext.classList.add("pulse");
    } else {
      navNext.classList.remove("pulse");
    }
  }

  navPrev.addEventListener("click", () => go(state.index - 1));
  navNext.addEventListener("click", () => go(state.index + 1));

  // ---- Input: wheel, touch, keyboard ------------------------------------

  // If the gesture starts inside a scrollable card body that can still move
  // in that direction, let the inner content scroll instead of the wheel.
  function innerScrollConsumes(targetNode, dy) {
    const body = targetNode && targetNode.closest ? targetNode.closest(".card-body") : null;
    if (!body || body.scrollHeight <= body.clientHeight + 1) return false;
    if (dy > 0) return body.scrollTop + body.clientHeight < body.scrollHeight - 1;
    return body.scrollTop > 0;
  }

  let wheelAccum = 0;
  let wheelLock = false;
  window.addEventListener("wheel", (e) => {
    if (innerScrollConsumes(e.target, e.deltaY)) return;   // native inner scroll
    e.preventDefault();
    if (wheelLock) return;
    wheelAccum += e.deltaY;
    if (Math.abs(wheelAccum) > 60) {
      go(state.index + (wheelAccum > 0 ? 1 : -1));
      wheelAccum = 0;
      wheelLock = true;
      setTimeout(() => { wheelLock = false; }, 260);  // debounce inertial trains
    }
  }, { passive: false });

  // Touch: drag the wheel directly; taps pass through to inputs untouched.
  let touchStartY = 0, touchStartPos = 0, touchStartT = 0, touchMoved = false;
  let innerScrolling = false;

  window.addEventListener("touchstart", (e) => {
    if (e.touches.length !== 1) return;
    touchStartY = e.touches[0].clientY;
    touchStartPos = pos;
    touchStartT = performance.now();
    touchMoved = false;
    innerScrolling = false;
  }, { passive: true });

  window.addEventListener("touchmove", (e) => {
    if (e.touches.length !== 1) return;
    const dy = touchStartY - e.touches[0].clientY;
    if (!touchMoved && Math.abs(dy) < 10) return;   // tap tolerance — don't hijack input taps
    if (!touchMoved) {
      // Decide once per gesture whether inner content owns it.
      innerScrolling = innerScrollConsumes(e.target, dy);
      touchMoved = true;
    }
    if (innerScrolling) return;                     // browser handles inner pan
    e.preventDefault();
    dragging = true;
    const spacing = SPACING();
    let p = touchStartPos + dy / spacing;
    // Rubber-band at the edges and at the gate.
    const max = maxReachable();
    if (p < 0) p = p * 0.3;
    if (p > max) p = max + (p - max) * 0.25;
    pos = p;
    kickPhysics();
  }, { passive: false });

  window.addEventListener("touchend", (e) => {
    if (!touchMoved) { dragging = false; return; }
    dragging = false;
    const dt = performance.now() - touchStartT;
    const travelled = pos - touchStartPos;
    let next = state.index;
    // Flick: fast short swipe still advances one card. Drag: settle nearest.
    if (dt < 260 && Math.abs(travelled) > 0.12) next = state.index + Math.sign(travelled);
    else next = Math.round(pos);
    const max = maxReachable();
    if (next > max && next > state.index) blockedFeedback();
    go(next);
  }, { passive: true });

  window.addEventListener("keydown", (e) => {
    // Never hijack keys while the user is typing in a field.
    const tag = e.target && e.target.tagName;
    if (tag === "TEXTAREA" || tag === "INPUT") return;
    if (e.key === "ArrowDown" || e.key === "PageDown") { e.preventDefault(); go(state.index + 1); }
    if (e.key === "ArrowUp" || e.key === "PageUp") { e.preventDefault(); go(state.index - 1); }
  });

  window.addEventListener("resize", () => { layout(); });

  // ---- Server I/O -------------------------------------------------------

  // Resolve the device fingerprint, tolerating a blocked/broken module.
  // Ad blockers strip scripts with "fingerprint" in the URL (hence the file
  // is named device-id.js) — but if anything still fails, fall back to a
  // stable random id in localStorage. Dedup degrades from per-device to
  // per-browser for those users; submission must never hard-fail on this.
  async function ensureFingerprint() {
    if (state.fp) return state.fp;
    try {
      if (window.StudyFingerprint) state.fp = await window.StudyFingerprint.compute();
    } catch (e) { /* fall through to fallback */ }
    if (!state.fp) {
      let fid = null;
      try { fid = localStorage.getItem("as_fid"); } catch (e) {}
      if (!fid || !/^[0-9a-f]{64}$/.test(fid)) {
        const bytes = new Uint8Array(32);
        if (window.crypto && crypto.getRandomValues) crypto.getRandomValues(bytes);
        else for (let i = 0; i < 32; i++) bytes[i] = Math.floor(Math.random() * 256);
        fid = Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
        try { localStorage.setItem("as_fid", fid); } catch (e) {}
      }
      state.fp = { device: fid, browser: fid };
    }
    return state.fp;
  }

  async function api(action, payload) {
    const r = await fetch(`${API}?action=${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    // Error statuses (e.g. 409 duplicate) still carry a JSON body we handle.
    const data = await r.json().catch(() => null);
    if (data === null) throw new Error("HTTP " + r.status);
    return data;
  }

  async function submitAnswers() {
    await ensureFingerprint();
    return api("submit", {
      fingerprint: state.fp,
      profile: profile ? { sex: profile.sex, orientation: profile.orient, targetSex: profile.targetSex } : null,
      answers: state.answers,
      meta: {
        screen: (screen.width || 0) + "x" + (screen.height || 0),
        perfTier: document.documentElement.className.match(/perf-(\w+)/)?.[1] || "?",
        presets: (presetSexuality || presetReligion)
          ? { sexuality: presetSexuality, religion: presetReligion }
          : null,
        completedAt: new Date().toISOString(),
      },
    });
  }

  // ---- Boot -------------------------------------------------------------

  async function boot() {
    loadState();
    rebuildDeck(state.index);
    layout();

    // Fingerprint check runs in the background; the user can start answering
    // immediately. If this device already submitted, we surface it via the
    // submit card (and a toast if they're mid-quiz).
    try {
      await ensureFingerprint();
      const res = await api("check", { fingerprint: state.fp });
      if (res.submitted && !state.done) {
        state.alreadySubmitted = true;
        state.done = true;
        saveState();
        rebuildDeck(idxOf("_submit") >= 0 ? idxOf("_submit") : state.index);
        go(deck.length - 1, true);
        toast("This device has already submitted a response");
      }
      if (state.done) fetchStats();   // returning visitor: results still browsable
    } catch (e) {
      // Offline / server down: quiz still runs, dedup enforced at submit time.
    }
  }

  boot();
})();
