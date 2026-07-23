/* ==========================================================================
   Question definitions + deck builder.
   The deck is rebuilt whenever onboarding answers change, because the
   orientation branch and all downstream wording depend on them.
   ========================================================================== */

(function (global) {
  "use strict";

  // ---- Onboarding -------------------------------------------------------

  const ONBOARDING = [
    {
      id: "bio_sex",
      type: "choice",
      kicker: "About you",
      title: "What is your biological sex?",
      sub: "Sex assigned at birth. This helps us group responses for the study.",
      options: ["Male", "Female"],
    },
    {
      id: "sexuality",
      type: "choice",
      kicker: "About you",
      title: "Which best describes your sexuality?",
      options: ["Straight", "Homosexual", "Pansexual", "Bisexual"],
    },
    // Conditional — only present when sexuality is Pansexual or Bisexual,
    // since target sex can't be inferred from the first two answers.
    {
      id: "attracted_to",
      type: "choice",
      kicker: "About you",
      title: "Which biological sex are you most attracted to?",
      sub: "For the rest of the quiz we’ll ask about this group.",
      options: ["Biological males", "Biological females"],
      onlyIf: (a) => a.sexuality === "Pansexual" || a.sexuality === "Bisexual",
    },
    {
      id: "religion",
      type: "choice",
      kicker: "About you",
      title: "What is your religious affiliation?",
      options: ["Christian", "Jewish", "Muslim", "Atheist / Agnostic", "Other", "Prefer not to say"],
    },
  ];

  // ---- Profile derivation ----------------------------------------------

  // Returns null until enough onboarding is answered to resolve the branch.
  function deriveProfile(answers) {
    const sex = answers.bio_sex;
    const orient = answers.sexuality;
    if (!sex || !orient) return null;

    let targetSex = null;
    if (orient === "Straight") {
      targetSex = sex === "Male" ? "Female" : "Male";
    } else if (orient === "Homosexual") {
      targetSex = sex;
    } else {
      if (!answers.attracted_to) return null;
      targetSex = answers.attracted_to === "Biological males" ? "Male" : "Female";
    }

    // Straight respondents get gendered partner words + pronouns.
    // Everyone else gets "Partner" + they/them, per study design.
    let vars;
    if (orient === "Straight") {
      vars = targetSex === "Female"
        ? { partner: "Wife", they: "she", them: "her", their: "her", theirs: "hers", themself: "herself", theyre: "she's", s: "s" }
        : { partner: "Husband", they: "he", them: "him", their: "his", theirs: "his", themself: "himself", theyre: "he's", s: "s" };
    } else {
      // {s} conjugates verbs after {they}: "walk{s}" -> "walks" / "walk"
      vars = { partner: "Partner", they: "they", them: "them", their: "their", theirs: "theirs", themself: "themselves", theyre: "they're", s: "" };
    }

    return { sex, orient, targetSex, vars };
  }

  function applyVars(text, vars) {
    if (!text) return text;
    return text.replace(/\{(\w+)\}/g, (m, key) => {
      const lower = key.toLowerCase();
      let v = vars[lower];
      if (v === undefined) return m;
      // {They} capitalized -> "She" / "He" / "They"
      if (key[0] === key[0].toUpperCase()) v = v[0].toUpperCase() + v.slice(1);
      return v;
    });
  }

  // ---- Body diagram region sets ----------------------------------------
  // Region ids map to SVG shape ids in figures below.

  const REGIONS = {
    Female: [
      { id: "face",  label: "Face" },
      { id: "hair",  label: "Hair" },
      { id: "chest", label: "Chest / Bust" },
      { id: "waist", label: "Waist" },
      { id: "hips",  label: "Hips & Glutes" },
      { id: "legs",  label: "Legs" },
      { id: "arms",  label: "Arms" },
    ],
    Male: [
      { id: "face",  label: "Face" },
      { id: "hair",  label: "Hair" },
      { id: "chest", label: "Chest" },
      { id: "arms",  label: "Arms & Shoulders" },
      { id: "waist", label: "Core / Abs" },
      { id: "hips",  label: "Glutes" },
      { id: "legs",  label: "Legs" },
    ],
  };

  // Stylized silhouettes. Each answerable region is a shape with data-region.
  // Female: narrower shoulders, wider hips. Male: broader shoulders.
  const FIGURES = {
    Female: `
      <svg viewBox="0 0 120 300" role="img" aria-label="Body diagram">
        <ellipse class="region" data-region="hair" cx="60" cy="26" rx="20" ry="18"/>
        <ellipse class="region" data-region="face" cx="60" cy="34" rx="13" ry="15"/>
        <rect class="silhouette" x="54" y="50" width="12" height="10" rx="4"/>
        <path class="region" data-region="chest" d="M42 62 Q60 54 78 62 L80 96 Q60 104 40 96 Z"/>
        <path class="region" data-region="arms" d="M40 64 Q28 70 26 100 L24 138 Q28 144 34 140 L40 100 Z M80 64 Q92 70 94 100 L96 138 Q92 144 86 140 L80 100 Z"/>
        <path class="region" data-region="waist" d="M42 98 Q60 106 78 98 L76 122 Q60 128 44 122 Z"/>
        <path class="region" data-region="hips" d="M44 124 Q60 130 76 124 Q86 140 82 158 Q60 168 38 158 Q34 140 44 124 Z"/>
        <path class="region" data-region="legs" d="M42 162 L40 240 Q40 252 48 252 L52 252 Q57 250 56 240 L58 176 L62 176 L64 240 Q63 250 68 252 L72 252 Q80 252 80 240 L78 162 Q60 170 42 162 Z"/>
      </svg>`,
    Male: `
      <svg viewBox="0 0 120 300" role="img" aria-label="Body diagram">
        <ellipse class="region" data-region="hair" cx="60" cy="24" rx="17" ry="15"/>
        <ellipse class="region" data-region="face" cx="60" cy="33" rx="13" ry="15"/>
        <rect class="silhouette" x="54" y="49" width="12" height="10" rx="4"/>
        <path class="region" data-region="chest" d="M36 60 Q60 52 84 60 L82 100 Q60 108 38 100 Z"/>
        <path class="region" data-region="arms" d="M36 60 Q22 68 20 102 L18 140 Q23 146 29 142 L36 102 Z M84 60 Q98 68 100 102 L102 140 Q97 146 91 142 L84 102 Z"/>
        <path class="region" data-region="waist" d="M40 102 Q60 110 80 102 L78 128 Q60 134 42 128 Z"/>
        <path class="region" data-region="hips" d="M42 130 Q60 136 78 130 Q82 144 80 156 Q60 164 40 156 Q38 144 42 130 Z"/>
        <path class="region" data-region="legs" d="M40 160 L40 240 Q40 252 48 252 L52 252 Q57 250 56 240 L58 172 L62 172 L64 240 Q63 250 68 252 L72 252 Q80 252 80 240 L80 160 Q60 168 40 160 Z"/>
      </svg>`,
  };

  // ---- Main quiz --------------------------------------------------------
  // Text supports {partner} {they} {them} {their} (capitalize for sentence
  // starts). Types: choice | multi | scale | diagram

  const QUIZ = [
    {
      id: "looks_importance",
      type: "scale",
      kicker: "The body",
      title: "How important is physical attraction when picking a long-term {partner}?",
      min: 1, max: 7,
      lowLabel: "Barely matters", highLabel: "Essential",
    },
    {
      id: "first_notice",
      type: "choice",
      kicker: "The body",
      title: "What do you notice first when {they} walk{s} into the room?",
      options: ["Face", "Body / physique", "Style & presentation", "Voice", "Energy / vibe"],
    },
    // Personality probes (ids prefixed p_) are woven through the deck.
    // Three axes, two items each, all numeric 1-10 for raw correlation:
    //   E/I:   high = extraverted        (p_social_energy, p_ideal_weekend)
    //   N/S:   high = gut/intuition      (p_gut_analysis, p_first_impressions)
    //   F/T:   high = heart/feeling      (p_head_heart, p_support_style)
    {
      id: "p_social_energy",
      type: "scale",
      kicker: "You, briefly",
      title: "After a big social event, how do you feel?",
      bipolar: true,
      min: 1, max: 7,
      lowLabel: "Drained — need alone time", highLabel: "Energized — want more",
    },
    // Likert agree/disagree statements (type "likert", stored 1-5 where
    // 1 = strongly disagree, 5 = strongly agree). Comments give the pilot
    // discrimination index (1 = best spread of opinions, 3 = most unified).
    {
      id: "l_politics",   // pilot DI: 1
      type: "likert",
      kicker: "Agree or disagree?",
      title: "My {partner}’s political beliefs should align with mine.",
    },
    {
      id: "l_communication",   // pilot DI: 2
      type: "likert",
      kicker: "Agree or disagree?",
      title: "My {partner}’s desire for communication is important.",
    },
    {
      id: "body_map",
      type: "diagram",
      kicker: "The body",
      title: "Rate how much each feature draws your attention",
      sub: "1 = barely notice it · 5 = major factor. Glowing items still need an answer.",
      scaleMax: 5,
      regionsFor: "target",   // resolved from profile.targetSex at build time
    },
    {
      id: "height_pref",
      type: "choice",
      kicker: "The body",
      title: "Ideal height for your {partner}, relative to you?",
      options: ["Much taller", "A little taller", "About my height", "Shorter than me", "Doesn’t matter"],
    },
    {
      id: "l_desire",   // pilot DI: 3
      type: "likert",
      kicker: "Agree or disagree?",
      title: "My {partner}’s desire for me is important.",
    },
    {
      id: "l_affection",   // pilot DI: 3
      type: "likert",
      kicker: "Agree or disagree?",
      title: "I want my {partner} to show me physical affection.",
    },
    // Covert self-centeredness / relationship-maturity probes (v_ prefix).
    // Sex-targeted via onlyForSex. Items marked REVERSE are relationship-
    // realism markers: invert (6 - x) before averaging into a selfishness
    // score. Deliberately dressed as ordinary "Agree or disagree?" cards.
    {
      id: "v_m_effort",   // entitlement: outsources relationship effort
      onlyForSex: "Male",
      type: "likert",
      kicker: "Agree or disagree?",
      title: "It’s mostly my {partner}’s job to keep the relationship exciting.",
    },
    {
      id: "v_f_mindread",   // naivety: mind-reading expectation
      onlyForSex: "Female",
      type: "likert",
      kicker: "Agree or disagree?",
      title: "If {they} really loved me, {they} would know what I need without being told.",
    },
    {
      id: "p_gut_analysis",
      type: "scale",
      kicker: "You, briefly",
      title: "When you make big decisions, what do you actually rely on?",
      bipolar: true,
      min: 1, max: 7,
      lowLabel: "Careful analysis", highLabel: "Gut instinct",
    },
    {
      id: "fitness_importance",
      type: "scale",
      kicker: "The body",
      title: "How important is it that {they} stay{s} physically fit?",
      min: 1, max: 7,
      lowLabel: "Not at all", highLabel: "Deal-breaker",
    },
    {
      id: "l_gifts",   // pilot DI: 3
      type: "likert",
      kicker: "Agree or disagree?",
      title: "My {partner} should buy me cool gifts.",
    },
    {
      id: "l_self_spend",   // pilot DI: 2
      type: "likert",
      kicker: "Agree or disagree?",
      title: "My {partner} should spend money on {themself} sometimes.",
    },
    {
      // Replaced l_save_money ("…help me save money for expensive occasions",
      // pilot DI: 2) — wording confused respondents (whose money? saved by
      // whom? what occasion?). New id so old rows never mix with new ones.
      id: "l_shared_finances",
      type: "likert",
      kicker: "Agree or disagree?",
      title: "My {partner} and I should share one bank account for everything.",
    },
    {
      id: "v_f_spoiled",   // entitlement
      onlyForSex: "Female",
      type: "likert",
      kicker: "Agree or disagree?",
      title: "I deserve to be spoiled by my {partner}.",
    },
    {
      id: "v_m_trophy",   // status/vanity: partner as social accessory
      onlyForSex: "Male",
      type: "likert",
      kicker: "Agree or disagree?",
      title: "Part of a great {partner} is how good {they} make{s} me look in front of my friends.",
    },
    {
      id: "single_feature",
      type: "choice",
      kicker: "The body",
      title: "If you could only keep one, which is most attractive?",
      options: ["A great smile", "Captivating eyes", "Amazing hair", "A fit physique", "A beautiful voice"],
    },
    {
      id: "p_head_heart",
      type: "scale",
      kicker: "You, briefly",
      title: "In a conflict with someone close to you, what usually wins?",
      bipolar: true,
      min: 1, max: 7,
      lowLabel: "Head — facts & fairness", highLabel: "Heart — feelings & harmony",
    },
    {
      id: "mind_map",
      type: "diagram",
      kicker: "The mind",
      title: "Rate how attractive each trait is in a {partner}",
      sub: "1 = neutral · 5 = irresistible. Glowing items still need an answer.",
      scaleMax: 5,
      parts: [
        { id: "humor",       label: "Sense of humor" },
        { id: "intelligence",label: "Intelligence" },
        { id: "kindness",    label: "Kindness / warmth" },
        { id: "confidence",  label: "Confidence" },
        { id: "ambition",    label: "Ambition / drive" },
        { id: "emotional",   label: "Emotional depth" },
      ],
    },
    {
      id: "l_charity",   // pilot DI: 3
      type: "likert",
      kicker: "Agree or disagree?",
      title: "My {partner} should spend money to help other people.",
    },
    {
      id: "l_my_spending",   // pilot DI: 1
      type: "likert",
      kicker: "Agree or disagree?",
      title: "My {partner} should let me spend money however I please.",
    },
    {
      id: "v_m_league",   // entitlement: deserves above own level
      onlyForSex: "Male",
      type: "likert",
      kicker: "Agree or disagree?",
      title: "I deserve a {partner} whose looks are out of my league.",
    },
    {
      id: "v_f_status",   // status/vanity: appearance to peers vs. treatment
      onlyForSex: "Female",
      type: "likert",
      kicker: "Agree or disagree?",
      title: "How my {partner} looks to my friends matters nearly as much as how {they} treat{s} me.",
    },
    {
      id: "humor_style",
      type: "choice",
      kicker: "The mind",
      title: "Which sense of humor would win you over?",
      options: ["Quick witty banter", "Goofy & playful", "Dry sarcasm", "Playful teasing", "Doesn’t matter, just laugh at my jokes"],
    },
    {
      id: "p_ideal_weekend",
      type: "scale",
      kicker: "You, briefly",
      title: "Your ideal weekend looks like…",
      bipolar: true,
      min: 1, max: 7,
      lowLabel: "Quiet, just me or a few people", highLabel: "Out with a big crowd",
    },
    {
      id: "l_crying",   // pilot DI: 3 — pilot showed zero variance; candidate to cut
      type: "likert",
      kicker: "Agree or disagree?",
      title: "I want my {partner} to feel comfortable crying near me.",
    },
    {
      id: "l_space",   // pilot DI: 2
      type: "likert",
      kicker: "Agree or disagree?",
      title: "I want my {partner} to give me some space when I feel down.",
    },
    {
      id: "v_m_win",   // low maturity: winning over understanding
      onlyForSex: "Male",
      type: "likert",
      kicker: "Agree or disagree?",
      title: "I’d rather win an argument with {them} than dig into why we’re arguing.",
    },
    {
      id: "v_f_effortless",   // naivety: soulmate fallacy
      onlyForSex: "Female",
      type: "likert",
      kicker: "Agree or disagree?",
      title: "With the right person, love should feel effortless.",
    },
    {
      id: "intelligence_importance",
      type: "scale",
      kicker: "The mind",
      title: "How important is it that {they} challenge{s} you intellectually?",
      min: 1, max: 7,
      lowLabel: "Not needed", highLabel: "Essential",
    },
    {
      id: "logic_emotion",
      type: "choice",
      kicker: "The mind",
      title: "Would you rather your {partner} lean logical or emotional?",
      options: ["Strongly logical", "Slightly logical", "Perfectly balanced", "Slightly emotional", "Strongly emotional"],
    },
    {
      id: "l_creative",   // pilot DI: 2
      type: "likert",
      kicker: "Agree or disagree?",
      title: "I want my {partner} to be creative and find new solutions.",
    },
    {
      id: "p_first_impressions",
      type: "scale",
      kicker: "You, briefly",
      title: "How much do you trust your first impression of a new person?",
      min: 1, max: 7,
      lowLabel: "Not much — I wait for evidence", highLabel: "Completely — it’s always right",
    },
    {
      id: "looks_vs_personality",
      type: "scale",
      kicker: "The balance",
      title: "Where do you honestly land on the trade-off?",
      sub: "Pick the spot between the two that matches you best.",
      bipolar: true,
      min: 1, max: 7,
      lowLabel: "Looks", highLabel: "Personality",
    },
    {
      id: "l_obedience",   // pilot DI: 1
      type: "likert",
      kicker: "Agree or disagree?",
      title: "I want my {partner} to do exactly as {theyre} told.",
    },
    {
      id: "v_m_work",   // REVERSE — relationship realism: effort when calm
      onlyForSex: "Male",
      type: "likert",
      kicker: "Agree or disagree?",
      title: "A good relationship still takes deliberate work even when nothing is wrong.",
    },
    {
      id: "v_f_boredom",   // REVERSE — relationship realism: boredom is normal
      onlyForSex: "Female",
      type: "likert",
      kicker: "Agree or disagree?",
      title: "Feeling bored once in a while in a long relationship is normal and okay.",
    },
    {
      id: "p_support_style",
      type: "scale",
      kicker: "You, briefly",
      title: "A friend comes to you upset about a problem. Your instinct is to…",
      bipolar: true,
      min: 1, max: 7,
      lowLabel: "Fix it — offer solutions", highLabel: "Feel it — offer comfort",
    },
    {
      id: "longterm_traits",
      type: "multi",
      kicker: "The balance",
      title: "Which qualities would make you commit to {them} long-term?",
      sub: "Pick up to 4.",
      maxPicks: 4,
      options: ["Loyalty", "Humor", "Ambition", "Kindness", "Intelligence", "Passion", "Stability", "Adventurousness"],
    },
    {
      id: "fantasy",
      type: "text",
      kicker: "Last one",
      title: "What’s an unspoken fantasy you’d want in a {partner}?",
      sub: "A sentence or two — keep it PG-13. Anonymous either way; public answers may be shown (filtered) to other quiz-takers.",
      placeholder: "I’ve always wished for…",
    },
  ];

  // ---- Deck builder -----------------------------------------------------

  // opts.hideSexuality / opts.hideReligion: the answer was preset via a
  // share-link URL parameter, so the question is skipped entirely.
  function buildDeck(answers, opts) {
    opts = opts || {};
    const deck = [];

    deck.push({
      id: "_welcome",
      type: "info",
      emoji: "✨",
      kicker: "Welcome",
      title: "The Attraction Study",
      sub: "A quick quiz about what the body and mind find attractive. Anonymous, one response per person. Swipe or scroll through the cards — your progress saves automatically. <a class=\"policy-link\" href=\"/privacy-policy\" target=\"_blank\" rel=\"noopener\">Privacy policy</a>",
      cta: "Start",
    });

    for (const q of ONBOARDING) {
      if (q.id === "sexuality" && opts.hideSexuality) continue;
      if (q.id === "religion" && opts.hideReligion) continue;
      if (q.onlyIf && !q.onlyIf(answers)) continue;
      deck.push(Object.assign({}, q));
    }

    const profile = deriveProfile(answers);
    if (profile) {
      for (const q of QUIZ) {
        // Some items are shown only to respondents of one biological sex.
        if (q.onlyForSex && profile.sex !== q.onlyForSex) continue;
        const c = Object.assign({}, q);
        c.title = applyVars(c.title, profile.vars);
        c.sub = applyVars(c.sub, profile.vars);
        if (c.options) c.options = c.options.map((o) => applyVars(o, profile.vars));
        if (c.regionsFor === "target") {
          c.parts = REGIONS[profile.targetSex];
          c.figure = FIGURES[profile.targetSex];
        }
        deck.push(c);
      }
      deck.push({
        id: "_submit",
        type: "submit",
        kicker: "All done",
        title: "Ready to send your answers?",
        sub: "Responses are anonymous and used only in aggregate.",
      });
    }

    return { deck, profile };
  }

  global.StudyQuestions = { buildDeck, deriveProfile, applyVars };
})(window);
