/**
 * Cert Buddy passive outcome logger.
 *
 * Zero-interaction: watches for the "Correct answer." / "Incorrect answer."
 * result banner Udemy practice questions render after you answer, and logs
 * the outcome against the on-screen question — no click, no tagger panel.
 *
 * Also owns the two-stage confidence toast (Feature 2): the moment a *new*
 * outcome is logged, a tiny non-blocking toast offers a confidence pick.
 * The toast speaks a different DIALECT per outcome — different buttons, in
 * a different order, under different digit keys — because "knew it" reads
 * absurd on a wrong answer and "memorized"/"intuition" are impossible there
 * (you can't recognize the right answer and still pick the wrong one):
 *   - CORRECT: memorized(1) / knew it(2) / intuition(3) / between two(4) /
 *     guessed(5). 'memorized' = pure answer-recognition, zero reasoning;
 *     'intuition' = genuine recognition-primed competence — NOT discounted
 *     the way 'memorized' is (see focusTopics/isStubborn in store.js).
 *   - WRONG: silly mistake(1) / was sure(2) / between two(3) / guessed(4) /
 *     didn't know(5), ordered by descending actual-knowledge. 'slip' ("silly
 *     mistake") and 'didnt-know' each auto-classify the auto-captured miss's
 *     reason the instant they're picked (misread / never-learned
 *     respectively — see AUTO_REASON_BY_CONFIDENCE and
 *     Store.setReasonIfEmpty) — 'slip' = knowledge was there, execution/
 *     attention failed; 'was sure' = a misconception (confidently believed
 *     the wrong thing); these two used to be conflated under one button.
 * Since the SAME key can mean different things on different dialects (key 1
 * is 'memorized' on the correct side, 'silly mistake' on the wrong one),
 * there's no static key->value table — each button's meaning/order/key is
 * assigned per-dialect in applyDialect(), and keydown resolves against
 * whichever VISIBLE button currently claims that key.
 *
 * A confidence tap morphs the SAME toast into a stage 2 one-line "why"
 * prompt, PLUS a 1-10 numeric confidence scale (same dialect-agnostic
 * scale on both outcomes) — the sentence is the primary capture this
 * feature exists to collect, the scale is a lower-friction number-only
 * fallback, not the manual tagger panel.
 *
 * Mistap recovery: a stage-1 pick is no longer permanent. A small ← in
 * stage 2's upper-left corner (the visual twin of the × in the upper-right
 * — ← re-choose, × close) returns to stage 1 for the SAME fp with all
 * buttons re-enabled; re-picking OVERWRITES the earlier choice (see the
 * `force` option on Store.setConfidence/setConfNum — first-tap-wins is
 * still the default for every other caller, it's only overridden on this
 * toast's own re-pick path). The why-text and any tapped scale value
 * survive the round trip unchanged; only a genuinely NEW toast (a different
 * fp) resets them. If the backed-out choice was one of the two that
 * auto-classify the miss's reason ('didnt-know' or 'slip' — see
 * AUTO_REASON_BY_CONFIDENCE, Store.setReasonIfEmpty), moving to a different
 * choice reverts or replaces that classification via
 * Store.clearAutoReason/replaceAutoReason, guarded by this toast's own
 * toastAutoReason flag (which reason, if any, THIS toast currently has
 * standing) so a pre-existing or panel-set reason is never touched.
 *
 * The toast no longer dismisses on an outside click (that killed it mid-
 * flow every time the page itself was scrolled or read) — only [save],
 * [skip], the × (top-right), or a new question's toast replacing it end
 * this one. × is "close", not "undo": anything already committed (a
 * stage-1 confidence pick commits immediately; a tapped-but-unsaved scale
 * value commits on close too, see commitConfNum) stays recorded.
 *
 * Feature 3 (auto-capture): an INCORRECT outcome automatically creates/merges
 * a miss record from the same extraction used for the outcome, so the record
 * exists before the user ever opens the tagger panel. A CORRECT outcome only
 * gets a record if stage 2 has something worth keeping (text, or a shaky
 * confidence). See handleCandidate / finishStage2 below.
 *
 * Runs after adapters.js (needs CertBuddyAdapters.inNav/extract) and before
 * tagger.js (order doesn't matter between those two, but the manifest keeps
 * store -> taxonomy -> adapters -> outcomes -> tagger). Loaded both as a
 * static content script and via the popup's on-demand injection.
 */
(function () {
  if (window.__certBuddyOutcomesLoaded) return;
  window.__certBuddyOutcomesLoaded = true;

  const Store = globalThis.CertBuddyStore;
  const Adapters = globalThis.CertBuddyAdapters;
  const Theme = globalThis.CertBuddyTheme;
  const Tax = globalThis.CertBuddyTaxonomy;
  if (!Store || !Adapters || !Theme || !Tax) return; // load-order guard, mirrors tagger.js

  function safe(fn, fallback) {
    try {
      return fn();
    } catch (e) {
      console.debug('[Cert Buddy] outcomes error', e);
      return fallback;
    }
  }

  /* ------------------------------------------------------------------ *
   * Feature 1 — banner detection                                        *
   * ------------------------------------------------------------------ */

  // Matches "Correct answer" / "Incorrect answer" at the start of the
  // banner's trimmed text, with or without the trailing "." Udemy ships.
  const BANNER_RE = /^(correct|incorrect)\s+answer\b/i;
  const MAX_BANNER_LEN = 200; // banners are short; explanation blocks are not
  const THROTTLE_MS = 5000; // mutation storms re-render the same banner

  // { fp, outcome, at } of the last thing we actually tried to log, so a
  // burst of mutation events for one real banner doesn't get logged twice.
  let lastLogged = null;

  function isAlertish(el) {
    if (safe(() => el.matches('[role="alert"]'), false)) return true;
    const cls = typeof el.className === 'string' ? el.className : '';
    return /alert/i.test(cls);
  }

  /**
   * A candidate banner: short text starting with "Correct/Incorrect answer",
   * not inside the question-nav sidebar/footer, and not one of the
   * per-option "Correct answer" badges that sit on every review row
   * regardless of what you picked.
   */
  function isCandidate(el) {
    if (!el || el.nodeType !== 1) return false;
    const t = safe(() => (el.innerText || el.textContent || '').trim(), '');
    if (!t || !BANNER_RE.test(t) || t.length >= MAX_BANNER_LEN) return false;
    if (safe(() => Adapters.inNav(el), false)) return false;
    if (safe(() => el.closest('[data-purpose="answer"]'), null)) return false;
    return true;
  }

  /** Only the outermost matches — a wrapper and its own matching child text
   *  node would otherwise double-count the same banner. */
  function outermost(els) {
    return els.filter((el) => !els.some((other) => other !== el && other.contains(el)));
  }

  /**
   * Scans one MutationObserver batch for banner candidates. When more than
   * one distinct candidate shows up in the same batch, prefer the
   * role="alert" / class*="alert" one(s) — that's the real banner; anything
   * else that happens to start with the same words in the same batch is
   * page chrome, not a result.
   */
  function collectCandidates(mutations) {
    const found = [];
    for (const mut of mutations) {
      for (const node of mut.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (isCandidate(node)) found.push(node);
        for (const el of safe(() => [...node.querySelectorAll('*')], [])) {
          if (isCandidate(el)) found.push(el);
        }
      }
    }
    const candidates = outermost([...new Set(found)]);
    if (candidates.length <= 1) return candidates;
    const preferred = candidates.filter(isAlertish);
    return preferred.length ? preferred : candidates;
  }

  /**
   * `forcedOutcome` lets the wpProQuiz attribute-toggle path (below) hand
   * over an outcome it already knows from a class token, instead of this
   * function re-deriving one from banner text that may not even say
   * "correct"/"incorrect" for that markup.
   */
  function handleCandidate(el, forcedOutcome) {
    const t = safe(() => (el.innerText || el.textContent || '').trim(), '');
    const outcome = forcedOutcome || (/^correct/i.test(t) ? 'correct' : 'incorrect');

    const data = safe(() => Adapters.extract(), null);
    if (!data) return;
    const fp = Store.fingerprint(data.question);
    if (!fp) return; // never log an outcome we can't attribute to a question

    const now = Date.now();
    if (lastLogged && lastLogged.fp === fp && now - lastLogged.at < THROTTLE_MS) {
      return; // same question re-detected inside the throttle window — noise
    }
    lastLogged = { fp, outcome, at: now };

    Store.logOutcome({
      fp,
      questionSnippet: data.question,
      outcome,
      yourAnswers: data.yourAnswers,
      correctAnswers: data.correctAnswers,
      selectCount: data.selectCount,
      exam: data.exam,
      url: location.href.slice(0, 500),
      qnum: data.qnum ?? null,
      qtotal: data.qtotal ?? null
    })
      .then(({ record, deduped }) => {
        // Auto-capture runs on EVERY incorrect detection, deduped or not —
        // a deduped re-detection still needs to append an attempt onto the
        // existing miss record (addMiss's own fp-merge handles that), it
        // just doesn't get a fresh toast. Same `data` extraction that
        // produced `fp` above is reused here so miss.fp === outcome.fp
        // always (addMiss recomputes fp from `data.question`, which is byte-
        // identical to what fingerprinted the outcome).
        if (outcome === 'incorrect') autoCaptureMiss(data);
        if (!deduped && record) showToast(fp, outcome, data);
      })
      .catch((e) => console.debug('[Cert Buddy] logOutcome failed', e));
  }

  /**
   * Auto-creates (or, via addMiss's existing fp-merge, appends an attempt
   * onto) the miss record for an incorrect outcome — no tagger interaction
   * required. Confidence is deliberately left unset here: addMiss's own
   * join-from-outcome fills it in from whatever the toast records next (or
   * from an outcome that already has one, on a repeat).
   */
  function autoCaptureMiss(data) {
    const detected = safe(
      () =>
        Tax.detectWeighted({
          question: data.question,
          yourAnswer: data.yourAnswer,
          correctAnswer: data.correctAnswer
        }),
      { apply: [], suggest: [] }
    );
    Store.addMiss({
      host: location.hostname,
      url: location.href.slice(0, 500),
      exam: data.exam,
      question: data.question,
      yourAnswer: data.yourAnswer,
      correctAnswer: data.correctAnswer,
      yourAnswers: data.yourAnswers,
      correctAnswers: data.correctAnswers,
      selectCount: data.selectCount,
      topics: detected.apply,
      disc: data.disc,
      notes: '',
      triaged: false,
      qnum: data.qnum ?? null,
      qtotal: data.qtotal ?? null
    }).catch((e) => console.debug('[Cert Buddy] auto-capture addMiss failed', e));
  }

  /**
   * Tutorials Dojo's quiz engine (wpProQuiz) reveals its Correct!/
   * Incorrect! feedback box by toggling `style.display` (or a class) on a
   * box that already exists in the DOM, hidden, from page load — the
   * addedNodes-based scan above never sees this, since nothing is ADDED.
   * Computed once at load so every attribute-mutation callback can bail in
   * one boolean check instead of doing any class-string work — Udemy's own
   * player mutates style/class plenty, and none of that should pay the cost
   * of a closest()/class scan just to find out it isn't this site.
   */
  // The `|| globalThis.__certBuddyForceTutorialsDojo` half exists only for a
  // local test harness served off http://localhost, which obviously can't
  // navigate to a real *.tutorialsdojo.com origin to exercise this path —
  // that global is never set on a real page, so real-site behavior is
  // governed by the hostname check alone.
  const IS_TUTORIALS_DOJO =
    /(^|\.)tutorialsdojo\.com$/i.test(location.hostname) ||
    !!globalThis.__certBuddyForceTutorialsDojo;

  /**
   * True if `el` itself carries the wpProQuiz_correct/incorrect class token
   * (separator-guarded, same idea as adapters.js's `marks()`, so
   * "incorrect" can never read as containing "correct"). Returns '' if
   * neither.
   */
  function wpProQuizOutcomeClass(el) {
    const cls = typeof el.className === 'string' ? el.className : '';
    if (/(?:^|\s)wpProQuiz_correct(?:\s|$)/.test(cls)) return 'correct';
    if (/(?:^|\s)wpProQuiz_incorrect(?:\s|$)/.test(cls)) return 'incorrect';
    return '';
  }

  // outcomes.js's own tiny visibility check — adapters.js's `isVisible` isn't
  // exported, and duplicating a one-line getClientRects check isn't worth
  // widening that module's public surface for.
  const isNowVisible = (el) => !!(el && el.getClientRects && el.getClientRects().length);

  /**
   * Scans one MutationObserver batch for a wpProQuiz feedback box that just
   * became visible via a style/class attribute change. `mutation.target` is
   * either the box itself or a descendant whose own attribute changed
   * (e.g. an inner span) — closest() covers the latter.
   */
  function collectAttributeCandidates(mutations) {
    if (!IS_TUTORIALS_DOJO) return [];
    const found = new Map(); // element -> outcome
    for (const mut of mutations) {
      if (mut.type !== 'attributes') continue;
      const el = mut.target;
      if (!el || el.nodeType !== 1) continue;
      let outcomeEl = el;
      let outcome = wpProQuizOutcomeClass(el);
      if (!outcome) {
        const closest = safe(() => el.closest('.wpProQuiz_correct,.wpProQuiz_incorrect'), null);
        if (closest) {
          outcomeEl = closest;
          outcome = wpProQuizOutcomeClass(closest);
        }
      }
      if (outcome && isNowVisible(outcomeEl)) found.set(outcomeEl, outcome);
    }
    return outermost([...found.keys()]).map((el) => ({ el, outcome: found.get(el) }));
  }

  const observer = new MutationObserver((mutations) => {
    for (const el of collectCandidates(mutations)) handleCandidate(el);
    for (const { el, outcome } of collectAttributeCandidates(mutations)) handleCandidate(el, outcome);
  });

  function startObserving() {
    if (document.body) {
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['style', 'class']
      });
    } else {
      document.addEventListener('DOMContentLoaded', startObserving, { once: true });
    }
  }
  startObserving();

  /* ------------------------------------------------------------------ *
   * Feature 2 — one-tap confidence toast                                *
   * ------------------------------------------------------------------ */

  // Shared :host token palette (light/dark) + box-sizing/font reset — see
  // src/lib/theme.js. tagger.js's panel/launcher composes the same base.
  const TOAST_CSS = Theme.css + `
    /* Luminance inversion: the toast lands in peripheral vision, which is
       nearly colorblind but sharply luminance- and motion-sensitive. So the
       toast is always the OPPOSITE brightness of the page — an ink pill on
       light pages, a paper pill on dark ones — and announces itself with
       delayed motion, not hue. */
    :host {
      --toast-bg: #171d1a;
      --toast-fg: #eef2ef;
      --toast-muted: #9fb0a7;
      --toast-accent: #3ddc97;
      --toast-accent-ink: #062018;
    }
    @media (prefers-color-scheme: dark) {
      :host {
        --toast-bg: #fafbf9;
        --toast-fg: #14171a;
        --toast-muted: #5c6a63;
        --toast-accent: #149463;
        --toast-accent-ink: #ffffff;
      }
    }
    .toast {
      /* Bottom-right, stacked above the tagger's ⚑ badge — on the mouse path
         to Udemy's "Next question" (Fitts: less travel than bottom-center). */
      position: fixed; right: 16px; bottom: 76px;
      z-index: 2147483645; /* one below the tagger's panel/launcher */
      display: flex; align-items: center; gap: 10px;
      background: var(--toast-bg); color: var(--toast-fg);
      border: 1px solid color-mix(in srgb, var(--toast-fg) 14%, transparent);
      border-left: 4px solid var(--toast-accent);
      border-radius: var(--radius);
      box-shadow: 0 14px 36px rgba(0,0,0,.35);
      /* Right padding leaves room for .x in the top-right corner without it
         overlapping button/label text — .toast's own fixed positioning is
         already a valid containing block, so .x/.corner-back just need
         absolute positioning, no extra wrapper. Left padding stays the
         plain 16px here (not widened to match) — only STAGE 2 needs
         corner clearance on the left for ←, since stage 1 has no button
         there; see .stage2's own extra padding-left below instead of
         indenting stage 1 unnecessarily too. */
      padding: 12px 32px 12px 16px; font-size: 14px;
      animation: cb-toast-in .26s cubic-bezier(.2,.9,.3,1.15);
    }
    /* One small overshoot — a lone motion onset in a settled scene. */
    @keyframes cb-toast-in {
      0%   { transform: translateY(22px); opacity: 0; }
      70%  { transform: translateY(-4px); opacity: 1; }
      100% { transform: translateY(0);    opacity: 1; }
    }
    @media (prefers-reduced-motion: reduce) { .toast { animation: none; } }
    .toast[hidden] { display: none; }

    /* Stage 1 (confidence buttons) and stage 2 (the "why" prompt + scale)
       are two children of the same .toast — only one is ever unhidden, so
       the toast morphs in place instead of dismissing and re-entering.
       Stage 1 stays a single row; stage 2 stacks the scale ABOVE its own
       input/save/skip row, so it's a column instead. */
    .stage1 { display: flex; align-items: center; gap: 10px; }
    /* Extra left inset (on top of .toast's own 16px) clears room for
       .corner-back, nested inside #stage2 — see the markup — so it hides
       for free whenever stage 2 does, no separate JS toggle needed. Stage 1
       has no such button, so it isn't indented to match. */
    .stage2 { display: flex; flex-direction: column; align-items: stretch; gap: 8px; padding-left: 18px; }
    .stage1[hidden], .stage2[hidden] { display: none; }
    .stage2-row { display: flex; align-items: center; gap: 10px; }

    .label {
      font-family: var(--mono); font-size: 12.5px; color: var(--toast-fg);
      white-space: nowrap; letter-spacing: .01em; font-weight: 600;
    }
    /* Honesty marker: a MISS record already exists for this fp, so this
       "correct" is exactly the shape of question where recognition (not
       reasoning) tends to happen. Muted + non-bold so it reads as a quiet
       footnote, not another instruction. */
    .seen {
      font-weight: 400; color: var(--toast-muted); letter-spacing: 0;
    }
    .btns { display: flex; gap: 6px; }
    .btn {
      font-family: var(--mono); font-size: 13px; font-weight: 600;
      padding: 8px 11px; border-radius: 7px;
      border: 1px solid color-mix(in srgb, var(--toast-accent) 55%, transparent);
      background: transparent; color: var(--toast-fg); cursor: pointer;
      transition: background .12s, border-color .12s, color .12s;
      white-space: nowrap;
    }
    .btn:hover { background: var(--toast-accent); border-color: var(--toast-accent); color: var(--toast-accent-ink); }
    .btn:focus-visible { outline: 2px solid var(--toast-accent); outline-offset: 2px; }
    .btn .k { opacity: .6; margin-left: 5px; }
    .btn.flash { background: var(--toast-accent); border-color: var(--toast-accent); color: var(--toast-accent-ink); }
    .btn.flash .k { opacity: .85; }

    /* Stage-2 numeric scale — renders on BOTH outcome dialects, above the
       why-input. tabindex=-1 on .scale lets showStage2() focus the
       container itself (not a specific button) so bare digit keys drive
       selection before the user ever touches the input. */
    .scale-label {
      font-family: var(--mono); font-size: 10.5px; color: var(--toast-muted);
      letter-spacing: .02em; margin-bottom: 4px;
    }
    .scale { display: flex; gap: 4px; outline: none; }
    .scale-btn {
      font-family: var(--mono); font-size: 12px; font-weight: 600;
      width: 24px; height: 24px; padding: 0; line-height: 1;
      border-radius: 6px; border: 1px solid color-mix(in srgb, var(--toast-accent) 45%, transparent);
      background: transparent; color: var(--toast-fg); cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      transition: background .12s, border-color .12s, color .12s;
    }
    .scale-btn:hover { background: var(--toast-accent); border-color: var(--toast-accent); color: var(--toast-accent-ink); }
    .scale-btn:focus-visible { outline: 2px solid var(--toast-accent); outline-offset: 2px; }
    .scale-btn.selected { background: var(--toast-accent); border-color: var(--toast-accent); color: var(--toast-accent-ink); }
    .scale-hint {
      font-family: var(--mono); font-size: 10.5px; color: var(--toast-muted);
      letter-spacing: .01em; margin-top: 4px;
    }

    .stage2-input {
      font-family: var(--mono); font-size: 13px; min-width: 220px;
      background: transparent; color: var(--toast-fg);
      border: 1px solid color-mix(in srgb, var(--toast-fg) 24%, transparent);
      border-radius: 7px; padding: 8px 10px; outline: none;
    }
    .stage2-input::placeholder { color: var(--toast-muted); }
    .stage2-input:focus { border-color: var(--toast-accent); }
    .details-link {
      border: 0; background: transparent; color: var(--toast-muted); padding: 0;
      font-family: var(--mono); font-size: 11px; text-decoration: underline; cursor: pointer;
    }
    .details-link:hover { color: var(--toast-fg); }
    .details-link:focus-visible { outline: 2px solid var(--toast-accent); outline-offset: 2px; }

    /* Corner buttons: × (close, top-right — same muted styling this toast
       had pre-v0.15, before outside-click dismiss briefly replaced it) and
       .corner-back (← re-choose, top-left — its visual twin, stage-2 only).
       Both absolutely positioned against .toast's own fixed positioning
       (already a valid containing block, no extra wrapper needed) rather
       than sitting in the normal flex flow, since stage 2's column layout
       (scale + input row) is taller than the single-row shape × was
       originally styled against. Shared min-width/height + flex-centering
       gives both a consistent ~24px+ hit area regardless of how narrow
       their glyph (← vs ×) renders. */
    .x, .corner-back {
      position: absolute; top: 6px;
      border: 0; background: transparent; color: var(--toast-muted); cursor: pointer;
      font-size: 16px; line-height: 1; padding: 4px 6px; border-radius: 6px;
      min-width: 24px; min-height: 24px;
      display: flex; align-items: center; justify-content: center;
    }
    .x { right: 6px; }
    .corner-back { left: 6px; }
    .x:hover, .corner-back:hover { color: var(--toast-fg); background: color-mix(in srgb, var(--toast-fg) 10%, transparent); }
    .x:focus-visible, .corner-back:focus-visible { outline: 2px solid var(--toast-accent); outline-offset: 2px; }
  `;

  const ALL_CONFIDENCE_VALS = ['knew', 'narrowed', 'guessed', 'memorized', 'intuition', 'didnt-know', 'slip'];
  const CONFIDENCE_VALUES = new Set(ALL_CONFIDENCE_VALS);

  // Per-dialect button config: order in the array IS the visual left-to-
  // right order (applied via style.order), `key` is the digit that selects
  // it while stage 1 is open. Replaces a static key->value table (see the
  // file-header comment) since the correct dialect's own key mapping was
  // reshuffled independently of the wrong dialect's, and every key means a
  // different value on each side (key 1 is 'memorized' vs 'slip', etc).
  const CORRECT_DIALECT = [
    { val: 'memorized', key: '1', label: 'memorized' },
    { val: 'knew', key: '2', label: 'knew it' },
    { val: 'intuition', key: '3', label: 'intuition' },
    { val: 'narrowed', key: '4', label: 'between two' },
    { val: 'guessed', key: '5', label: 'guessed' }
  ];
  // Ordered by descending actual-knowledge: a silly mistake (knew it, just
  // slipped) means the most real knowledge, then was-sure (a misconception —
  // confidently wrong), then between-two, then guessed, then didn't know at
  // all (the least).
  const WRONG_DIALECT = [
    { val: 'slip', key: '1', label: 'silly mistake' },
    { val: 'knew', key: '2', label: 'was sure' },
    { val: 'narrowed', key: '3', label: 'between two' },
    { val: 'guessed', key: '4', label: 'guessed' },
    { val: 'didnt-know', key: '5', label: "didn't know" }
  ];

  // Confidence values that ARE, in themselves, an explicit reason
  // classification — choosing one auto-fills `reason` onto the
  // auto-captured miss the instant it's picked (see chooseConfidence),
  // instead of waiting for a debrief triage pass. Generalizes what used to
  // be a didnt-know-only mechanism (see Store.setReasonIfEmpty/
  // clearAutoReason/replaceAutoReason and the toastAutoReason flag below).
  const AUTO_REASON_BY_CONFIDENCE = {
    'didnt-know': 'never-learned',
    slip: 'misread'
  };

  // Stage-2 numeric scale: digit keys 1-9 map to themselves, 0 maps to 10.
  const SCALE_KEYS = { '1': 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '0': 10 };

  let toastShadow = null;
  let toastEl = null;
  let toastTimer = null;
  let toastFp = null;
  let toastOutcome = null; // 'correct' | 'incorrect' — which outcome spawned the current toast
  let toastData = null; // the Adapters.extract() snapshot that produced toastFp
  let toastConfidence = null; // the stage-1 choice, once made
  let toastConfNum = null; // the stage-2 scale choice (1-10), once made
  let toastStage = 1; // 1 (confidence buttons) | 2 (the "why" prompt + scale)
  // Set the moment "← back" is used at least once in this toast's session —
  // reused for two things that are really the same underlying condition:
  // (1) Store.setConfidence/setConfNum calls pass { force: toastRepicked }
  //     so a re-pick overwrites instead of losing to first-tap-wins, and
  // (2) showStage2() skips its input/scale reset on re-entry, so a mistap
  //     doesn't cost an already-typed sentence or an already-tapped number.
  let toastRepicked = false;
  // WHICH reason (if any) THIS toast's own setReasonIfEmpty/replaceAutoReason
  // call currently has standing in the miss's reason field — null, or one of
  // AUTO_REASON_BY_CONFIDENCE's values ('never-learned' | 'misread'). Not a
  // plain boolean any more (was toastAutoReasonSetByToast pre-v0.16.2, back
  // when 'didnt-know' was the only auto-classifying pick): with two such
  // picks now, switching between them needs to know WHICH one is standing so
  // it can replace it rather than just clear-or-not. See chooseConfidence and
  // Store.clearAutoReason/replaceAutoReason's doc comments for why this has
  // to be state the toast owns, not a value comparison against a
  // pre-existing/panel-set reason.
  let toastAutoReason = null;

  function buildToastHost() {
    const host = document.createElement('div');
    host.id = 'cert-buddy-outcomes-root';
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = TOAST_CSS;
    shadow.appendChild(style);

    const wrap = document.createElement('div');
    wrap.innerHTML = `
      <div class="toast" id="toast" hidden role="status" aria-live="polite">
        <div class="stage1" id="stage1">
          <span class="label">How confident?<span class="seen" id="toastSeen" hidden> · seen before</span></span>
          <div class="btns" id="stage1Btns">
            <button type="button" class="btn" data-val="knew"><span class="lbl">knew it</span><span class="k">1</span></button>
            <button type="button" class="btn" data-val="narrowed"><span class="lbl">between two</span><span class="k">2</span></button>
            <button type="button" class="btn" data-val="guessed"><span class="lbl">guessed</span><span class="k">3</span></button>
            <button type="button" class="btn" data-val="memorized"><span class="lbl">memorized</span><span class="k">4</span></button>
            <button type="button" class="btn" data-val="intuition"><span class="lbl">intuition</span><span class="k">5</span></button>
            <button type="button" class="btn" data-val="didnt-know"><span class="lbl">didn't know</span><span class="k">4</span></button>
            <button type="button" class="btn" data-val="slip"><span class="lbl">silly mistake</span><span class="k">1</span></button>
          </div>
        </div>
        <div class="stage2" id="stage2" hidden>
          <button type="button" class="corner-back" id="stage2Back" aria-label="back" title="Back — re-choose">←</button>
          <div class="scale-wrap" id="scaleWrap">
            <div class="scale-label">how sure? (1–10)</div>
            <div class="scale" id="scale" tabindex="-1">
              <button type="button" class="scale-btn" data-n="1">1</button>
              <button type="button" class="scale-btn" data-n="2">2</button>
              <button type="button" class="scale-btn" data-n="3">3</button>
              <button type="button" class="scale-btn" data-n="4">4</button>
              <button type="button" class="scale-btn" data-n="5">5</button>
              <button type="button" class="scale-btn" data-n="6">6</button>
              <button type="button" class="scale-btn" data-n="7">7</button>
              <button type="button" class="scale-btn" data-n="8">8</button>
              <button type="button" class="scale-btn" data-n="9">9</button>
              <button type="button" class="scale-btn" data-n="10">10</button>
            </div>
            <div class="scale-hint">1 = no idea · 10 = for sure</div>
          </div>
          <div class="stage2-row">
            <input type="text" id="stage2Input" class="stage2-input" autocomplete="off" spellcheck="false"
                   placeholder="why? didn't know… / not sure about…">
            <div class="btns">
              <button type="button" class="btn" id="stage2Save">save</button>
              <button type="button" class="btn" id="stage2Skip">skip</button>
            </div>
            <button type="button" class="details-link" id="stage2Details">details</button>
          </div>
        </div>
        <button type="button" class="x" id="toastX" title="Close — anything already recorded stays">×</button>
      </div>`;
    shadow.appendChild(wrap);

    // The toast is built lazily — if its first appearance happens while the
    // player is ALREADY element-fullscreened, mounting outside that subtree
    // makes it invisible and no later fullscreenchange will rescue it. Same
    // fullscreen ride-along as the tagger's panel; shared in
    // src/lib/theme.js since element-fullscreen would hide this toast too,
    // and it IS the confidence feature during an exam.
    Theme.mountFullscreenAware(host);

    for (const btn of shadow.querySelectorAll('.stage1 .btn')) {
      btn.addEventListener('click', () => chooseConfidence(btn.dataset.val));
    }

    // Clicking a scale button works regardless of what currently has focus
    // (unlike the digit-key path below, which is gated off once the
    // why-input is focused) — see selectConfNum's own doc comment.
    for (const btn of shadow.querySelectorAll('.scale-btn')) {
      btn.addEventListener('click', () => selectConfNum(Number(btn.dataset.n)));
    }

    shadow.getElementById('stage2Save').addEventListener('click', stage2Save);
    shadow.getElementById('stage2Skip').addEventListener('click', stage2Skip);
    shadow.getElementById('stage2Back').addEventListener('click', backToStage1);
    shadow.getElementById('toastX').addEventListener('click', dismissToast);
    // Loose coupling by design: outcomes.js and tagger.js are two independent
    // shadow-root modules with no shared object between them (see the
    // manifest's load order — this file has no reference to tagger.js's
    // open()). A CustomEvent is the whole interface.
    shadow.getElementById('stage2Details').addEventListener('click', () => {
      window.dispatchEvent(new CustomEvent('certbuddy:open-panel'));
    });

    const stage2Input = shadow.getElementById('stage2Input');
    stage2Input.addEventListener('keydown', (e) => {
      // Stop here (never let this reach the page) — this field IS the point
      // at which digits must become plain text again, not toast/scale
      // shortcuts. The window listener below doesn't actually depend on
      // this stopPropagation (it runs in the capture phase, before this
      // handler); isTypingTarget() there is the real guard. This call stays
      // for defense in depth against anything else on the page listening
      // for keydown in the bubble phase.
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        stage2Save();
      } else if (e.key === 'Escape') {
        // Escape in stage 2 means BACK now, not skip — [skip] stays
        // available as its own explicit button for "discard and end".
        e.preventDefault();
        backToStage1();
      }
    });

    return shadow;
  }

  function ensureToast() {
    if (!toastShadow) {
      toastShadow = buildToastHost();
      toastEl = toastShadow.getElementById('toast');
    }
    return toastShadow;
  }

  /**
   * Applies one dialect config (CORRECT_DIALECT or WRONG_DIALECT, see their
   * definitions above) to the stage-1 button row: every button whose value
   * isn't in this dialect gets hidden (and stripped of data-key, so the
   * keydown resolver below can never match it — the hidden-button guard
   * falls out for free instead of needing a separate check). Every button
   * that IS in this dialect gets shown, repositioned (style.order, so the
   * DOM's own child order doesn't need to change), relabeled, and rekeyed.
   */
  function applyDialect(dialect) {
    const shownVals = new Set(dialect.map((d) => d.val));
    for (const val of ALL_CONFIDENCE_VALS) {
      const btn = toastShadow.querySelector(`.stage1 .btn[data-val="${val}"]`);
      if (btn && !shownVals.has(val)) {
        btn.hidden = true;
        delete btn.dataset.key;
      }
    }
    dialect.forEach((entry, i) => {
      const btn = toastShadow.querySelector(`.stage1 .btn[data-val="${entry.val}"]`);
      if (!btn) return;
      btn.hidden = false;
      btn.style.order = i;
      btn.dataset.key = entry.key;
      btn.querySelector('.lbl').textContent = entry.label;
      btn.querySelector('.k').textContent = entry.key;
    });
  }

  function showToast(fp, outcome, data) {
    ensureToast();
    toastFp = fp;
    toastOutcome = outcome;
    toastData = data;
    toastConfidence = null;
    toastConfNum = null;
    toastStage = 1;
    toastRepicked = false;
    toastAutoReason = null;

    // Always (re-)enter on stage 1, buttons unflashed — a toast for a new
    // question reuses this same host/shadow, so a stage-2/flash/scale-
    // selection state left over from the PREVIOUS question must not bleed
    // into this one.
    const stage1El = toastShadow.getElementById('stage1');
    const stage2El = toastShadow.getElementById('stage2');
    stage1El.hidden = false;
    stage2El.hidden = true;
    for (const b of toastShadow.querySelectorAll('.stage1 .btn')) b.classList.remove('flash');
    for (const b of toastShadow.querySelectorAll('.scale-btn')) b.classList.remove('selected');

    // The toast speaks a different dialect per outcome — see applyDialect
    // and the CORRECT_DIALECT/WRONG_DIALECT configs above for exactly which
    // buttons, in what order, under which key.
    applyDialect(outcome === 'incorrect' ? WRONG_DIALECT : CORRECT_DIALECT);

    // Change-blindness fix: the banner's own render masks a simultaneous
    // onset, so the toast enters ~400ms later, once the scene has settled —
    // a lone motion in a still scene is what peripheral vision is built to
    // catch. Hidden-then-shown also replays the entrance animation when one
    // toast replaces another.
    toastEl.hidden = true;

    // "Seen before" honesty marker: a MISS record already on file for this
    // fp means you've gotten this question wrong before via the tagger —
    // exactly where a "correct" now is more likely recognition than
    // reasoning. Async, but resolves well inside the 400ms reveal delay
    // below in practice; the toastFp guard drops a stale result if a second
    // outcome fires before this one resolves.
    const seenEl = toastShadow.getElementById('toastSeen');
    seenEl.hidden = true;
    Store.getMissByFp(fp)
      .then((miss) => {
        if (toastFp === fp) seenEl.hidden = !miss;
      })
      .catch((e) => console.debug('[Cert Buddy] getMissByFp failed', e));

    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastEl.hidden = false;
    }, 400);
    // No auto-dismiss (user decision): the tap is high-value and costs
    // nothing, so the toast stays until [save], [skip], the ×, or a new
    // question's toast replaces it via this same function. (An outside
    // click on the page used to dismiss it too — removed: live use showed
    // it killing the toast mid-flow on nothing more than a page scroll.)
  }

  function hideToast() {
    clearTimeout(toastTimer);
    toastFp = null;
    toastOutcome = null;
    toastData = null;
    toastConfidence = null;
    toastConfNum = null;
    toastStage = 1;
    toastRepicked = false;
    toastAutoReason = null;
    if (toastEl) toastEl.hidden = true;
  }

  /**
   * × / stage-1 Escape: closes the toast WITHOUT recording anything new —
   * but it's "close", not "undo". A stage-1 confidence pick already
   * committed the instant it was tapped (chooseConfidence's own
   * Store.setConfidence call), so it needs no help here; confNum is the one
   * field normally left uncommitted until [save]/[skip]
   * (finishStage2/commitConfNum), so this commits it too if the user tapped
   * a scale value — closing must never silently drop that the way it
   * wouldn't if they'd hit [skip] instead. No notes/miss-record side effect
   * beyond that: that's what [skip] is for.
   */
  function dismissToast() {
    commitConfNum(toastFp);
    hideToast();
  }

  function chooseConfidence(value) {
    if (!toastFp || toastStage !== 1 || !CONFIDENCE_VALUES.has(value)) return;
    const fp = toastFp;
    const btn = toastShadow.querySelector(`.stage1 .btn[data-val="${value}"]`);
    if (btn) btn.classList.add('flash'); // accent select flash on tap
    toastConfidence = value;
    // force: toastRepicked — plain first-tap-wins would make a stage-1
    // mistap permanent, which stopped being acceptable once there were 5
    // reshuffled buttons to fat-finger. toastRepicked is false on the very
    // first pick (so this behaves exactly as it always did — a no-op
    // difference, since there's nothing to overwrite yet) and becomes true
    // the moment "← back" is used, so every pick AFTER a back overwrites
    // instead of losing to first-wins.
    const setConfidenceDone = Store.setConfidence(fp, value, { force: toastRepicked }).catch((e) =>
      console.debug('[Cert Buddy] setConfidence failed', e)
    );
    // 'didnt-know' and 'slip' (wrong-dialect only) ARE explicit reason
    // classifications in themselves — fill the mapped reason onto the
    // auto-captured miss the moment one is picked, instead of waiting for a
    // debrief triage pass (see AUTO_REASON_BY_CONFIDENCE above). Every Store
    // call in this block is chained off setConfidenceDone (never fired in
    // parallel with it, or with each other): they all read-mutate-write the
    // same storage blob, and racing any two of them risks one silently
    // dropping another's change on write. None of this delays the stage-2
    // morph below, which is scheduled independently.
    const newAutoReason = AUTO_REASON_BY_CONFIDENCE[value] || null;
    if (newAutoReason && newAutoReason === toastAutoReason) {
      // Re-picking the SAME auto-classifying value straight after a back,
      // with no different choice in between — this toast's classification
      // is already standing, nothing to redo. (Calling setReasonIfEmpty
      // again here would see the reason it set earlier as already
      // non-empty, no-op, and incorrectly report "not mine" by returning
      // null, which would wrongly clear toastAutoReason below.)
    } else if (newAutoReason && toastAutoReason) {
      // Switching from ONE of this toast's own auto-reasons to the OTHER
      // (e.g. 'slip' -> back -> 'didnt-know') — replaceAutoReason
      // overwrites unconditionally in one write, since setReasonIfEmpty's
      // only-if-empty guard would otherwise refuse to write over the FIRST
      // auto-reason this same toast already applied.
      setConfidenceDone.then(() =>
        Store.replaceAutoReason(fp, newAutoReason)
          .then((m) => {
            toastAutoReason = m ? newAutoReason : null;
          })
          .catch((e) => console.debug('[Cert Buddy] replaceAutoReason failed', e))
      );
    } else if (newAutoReason) {
      // Nothing of this toast's own standing yet — plain only-if-empty
      // write, so a pre-existing or panel-set reason is never touched.
      setConfidenceDone.then(() =>
        Store.setReasonIfEmpty(fp, newAutoReason)
          .then((m) => {
            toastAutoReason = m ? newAutoReason : null;
          })
          .catch((e) => console.debug('[Cert Buddy] setReasonIfEmpty failed', e))
      );
    } else if (toastAutoReason) {
      // Moving AWAY from an auto-classifying pick to one that isn't (e.g.
      // 'slip'/'didnt-know' -> 'guessed') reverts it — but ONLY because the
      // flag says THIS toast is what set it (see Store.clearAutoReason's
      // doc comment: a pre-existing or panel-set reason is never touched,
      // and the flag — not a value comparison — is what tells them apart).
      toastAutoReason = null;
      setConfidenceDone.then(() =>
        Store.clearAutoReason(fp).catch((e) =>
          console.debug('[Cert Buddy] clearAutoReason failed', e)
        )
      );
    }
    // Morph to stage 2 shortly after — the flash gets one short paint first,
    // same timing feel as the old dismiss-on-tap, but the toast itself stays
    // (does NOT dismiss): the "why" prompt is the point of this feature.
    clearTimeout(toastTimer);
    toastTimer = setTimeout(showStage2, 120);
  }

  function showStage2() {
    if (!toastFp || !toastShadow) return;
    toastStage = 2;
    toastShadow.getElementById('stage1').hidden = true;
    const stage2El = toastShadow.getElementById('stage2');
    stage2El.hidden = false;
    const input = toastShadow.getElementById('stage2Input');

    // A FRESH entry into stage 2 (toastRepicked still false — no back has
    // happened yet this session) resets the input/scale same as always. A
    // re-entry AFTER "← back" deliberately preserves both instead — a
    // mistapped CATEGORY shouldn't cost the user a sentence they'd already
    // started typing or a scale value they'd already tapped.
    if (!toastRepicked) {
      input.value = '';
      toastConfNum = null;
      for (const b of toastShadow.querySelectorAll('.scale-btn')) b.classList.remove('selected');
    }

    // The numeric scale renders on BOTH dialects (it's dialect-agnostic —
    // just "how sure, 1-10") — focus the scale CONTAINER (tabindex=-1),
    // not the input, either way, so a bare digit keypress drives it first
    // (still true on a preserved re-entry: the user may want to CHANGE the
    // number, not just keep it). Typing into the input is still one
    // click/tab away, and once it has focus, isTypingTarget() hands digits
    // back to plain text (same guard stage 1 already relies on for its own
    // digit keys).
    toastShadow.getElementById('scale').focus();
  }

  /**
   * "← back": returns the toast to stage 1 for the SAME fp, all buttons
   * re-enabled (applyDialect already ran for this outcome back in
   * showToast and never needs to run again — the dialect doesn't change
   * mid-toast) so the user can re-pick. Unflashes every stage-1 button so
   * the re-pick starts from a clean slate instead of showing two buttons
   * "selected" at once. Marks toastRepicked so the NEXT chooseConfidence
   * call force-overwrites (see its own comment) and the NEXT showStage2
   * call preserves rather than resets the why-text/scale.
   */
  function backToStage1() {
    if (toastStage !== 2) return;
    toastRepicked = true;
    toastStage = 1;
    toastShadow.getElementById('stage2').hidden = true;
    toastShadow.getElementById('stage1').hidden = false;
    for (const b of toastShadow.querySelectorAll('.stage1 .btn')) b.classList.remove('flash');
  }

  /**
   * Stage-2 numeric confidence scale. Fires from either a scale-button
   * click (works no matter what currently has focus) or a bare digit
   * keydown while the why-input isn't focused (see the window keydown
   * listener below). Either path ends by moving focus INTO the why-input —
   * the scale tap is a fast first move, but the sentence is still the
   * point of this feature.
   */
  function selectConfNum(n) {
    if (toastStage !== 2 || !toastShadow) return;
    toastConfNum = n;
    for (const b of toastShadow.querySelectorAll('.scale-btn')) {
      b.classList.toggle('selected', Number(b.dataset.n) === n);
    }
    const input = toastShadow.getElementById('stage2Input');
    if (input) input.focus();
  }

  /**
   * Fire-and-forget confNum commit, shared by finishStage2 ([save]/[skip])
   * and dismissToast (×) — the two ways a toast can end while a tapped
   * scale value is still sitting only in local state (toastConfNum). A
   * no-op (returns an already-resolved promise) if nothing was tapped.
   * force mirrors toastRepicked for the same reason chooseConfidence does —
   * see its comment.
   */
  function commitConfNum(fp) {
    if (fp && toastConfNum !== null) {
      return Store.setConfNum(fp, toastConfNum, { force: toastRepicked }).catch((e) =>
        console.debug('[Cert Buddy] setConfNum failed', e)
      );
    }
    return Promise.resolve();
  }

  function stage2Save() {
    if (toastStage !== 2) return;
    const text = (toastShadow.getElementById('stage2Input').value || '').trim();
    finishStage2(text);
  }

  function stage2Skip() {
    if (toastStage !== 2) return;
    finishStage2('');
  }

  /**
   * Common landing point for both [save] and [skip] — the only difference
   * between them is whether `text` is empty.
   *
   *  - confNum commits on EITHER dialect, [save] or [skip] alike — a tapped
   *    number is data even with no sentence attached, same "first tap wins"
   *    (or force, on a re-pick — see commitConfNum) rule as confidence.
   *    Chained ahead of whichever Store call follows it below (not fired in
   *    parallel with it) so the two read-mutate-write cycles against the
   *    same storage blob can't race and silently drop one of the writes.
   *  - INCORRECT: the miss record already exists (auto-captured back in
   *    handleCandidate/autoCaptureMiss) — non-empty text just fills/appends
   *    its notes via Store.setNotesByFp. Empty text is a true no-op beyond
   *    the confNum commit above; the record and its (possibly still-null)
   *    confidence are otherwise untouched here.
   *  - CORRECT: nothing was auto-created at detection time. A record is
   *    worth creating only if this capture has something to say: non-empty
   *    text, OR a shaky confidence ('guessed'/'memorized') that's worth
   *    flagging even with no sentence attached. Plain "knew it"/"between
   *    two"/"intuition" with no text is a clean right — outcome-only, no
   *    record.
   */
  function finishStage2(text) {
    const fp = toastFp;
    const outcome = toastOutcome;
    const data = toastData;
    const confidence = toastConfidence;
    const confNum = toastConfNum;

    const confNumDone = commitConfNum(fp);

    if (fp && outcome === 'incorrect' && text) {
      confNumDone.then(() =>
        Store.setNotesByFp(fp, text).catch((e) =>
          console.debug('[Cert Buddy] setNotesByFp failed', e)
        )
      );
    } else if (fp && outcome === 'correct' && (text || confidence === 'guessed' || confidence === 'memorized')) {
      const detected = safe(
        () =>
          Tax.detectWeighted({
            question: data && data.question,
            yourAnswer: data && data.yourAnswer,
            correctAnswer: data && data.correctAnswer
          }),
        { apply: [], suggest: [] }
      );
      confNumDone.then(() =>
        Store.addMiss({
          host: location.hostname,
          url: location.href.slice(0, 500),
          exam: (data && data.exam) || '',
          question: (data && data.question) || '',
          yourAnswer: (data && data.yourAnswer) || '',
          correctAnswer: (data && data.correctAnswer) || '',
          yourAnswers: (data && data.yourAnswers) || [],
          correctAnswers: (data && data.correctAnswers) || [],
          selectCount: (data && data.selectCount) || 1,
          topics: detected.apply,
          disc: (data && data.disc) || '',
          notes: text,
          reason: '',
          triaged: true,
          shaky: confidence === 'guessed',
          confidence,
          confNum,
          qnum: (data && data.qnum) ?? null,
          qtotal: (data && data.qtotal) ?? null
        }).catch((e) => console.debug('[Cert Buddy] correct-capture addMiss failed', e))
      );
    }

    hideToast();
  }

  /** True if the event's target (or anything in its composed path) is a
   *  place the user could be typing — never steal 1/2/3 from there. */
  function isTypingTarget(e) {
    const path = typeof e.composedPath === 'function' ? e.composedPath() : [e.target];
    for (const node of path) {
      if (!node || !node.tagName) continue;
      const tag = node.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
      if (node.isContentEditable) return true;
    }
    return false;
  }

  window.addEventListener(
    'keydown',
    (e) => {
      if (!toastFp || !toastEl || toastEl.hidden) return;
      if (e.altKey || e.ctrlKey || e.metaKey) return; // plain keys only
      // isTypingTarget is the REAL guard against stealing digits from the
      // stage-2 input (not stopPropagation on the input's own listener
      // below — this is a capture-phase listener on window, so it sees the
      // event before that handler runs). Checked once, up front, for both
      // branches below.
      if (isTypingTarget(e)) return;

      if (toastStage === 1) {
        // Escape in stage 1 = same as × (close, nothing new recorded).
        if (e.key === 'Escape') {
          e.preventDefault();
          dismissToast();
          return;
        }
        // Key meaning is dialect- AND position-dependent (key 1 is
        // 'memorized' on the correct dialect, 'slip' on the wrong one) —
        // see applyDialect above, which stamps each VISIBLE button with the
        // data-key it currently claims. A hidden button was stripped of its
        // data-key there, so it can never match here — the hidden-button
        // guard falls out for free instead of needing a separate check.
        const btnFor = toastShadow.querySelector(`.stage1 .btn[data-key="${e.key}"]:not([hidden])`);
        if (!btnFor) return;
        e.preventDefault();
        chooseConfidence(btnFor.dataset.val);
        return;
      }

      if (toastStage === 2) {
        // Escape in stage 2 = back (not skip — [skip] is its own explicit
        // button). This branch covers Escape while the SCALE container (not
        // the why-input) has focus; the input's own keydown listener
        // handles Escape when it's focused there instead (isTypingTarget
        // above already excludes that case from reaching here).
        if (e.key === 'Escape') {
          e.preventDefault();
          backToStage1();
          return;
        }
        const n = SCALE_KEYS[e.key];
        if (!n) return;
        e.preventDefault();
        selectConfNum(n);
      }
    },
    true
  );
})();
