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
 *
 * Modes (v0.21.0): everything above (the gate, both toast dialects, the
 * slim post-outcome toast) is DEEP mode — unchanged from v0.20.0. QUICK
 * mode is the new default: zero mandatory interaction. The submit-click
 * gate never engages (onDocumentClickCapture returns before
 * preventDefault), and handleCandidate's outcome branch skips every toast
 * — a correct outcome gets nothing at all, an incorrect one still
 * auto-captures the miss (passive capture is unaffected by mode either
 * way) and surfaces it via a small, non-blocking "captured" pill instead.
 * Quick mode offers exactly two OPTIONAL touchpoints in place of all that:
 * a digit key pressed before Check pre-rates a numeric confidence ahead of
 * time (see the keydown handler's quick-mode branch and the flash pill),
 * and the captured pill itself can be clicked (or dismissed with N) to
 * open the same slim toast for an on-demand note — never a prompt. The
 * module-level `mode` is read once via Store.getMode() at init and kept
 * live via chrome.storage.onChanged, defaulting to 'quick' (fail-open)
 * until that first read resolves.
 */
(function () {
  if (window.__certBuddyOutcomesLoaded) return;
  window.__certBuddyOutcomesLoaded = true;

  const Store = globalThis.CertBuddyStore;
  const Adapters = globalThis.CertBuddyAdapters;
  const Theme = globalThis.CertBuddyTheme;
  const Tax = globalThis.CertBuddyTaxonomy;
  if (!Store || !Adapters || !Theme || !Tax) return; // load-order guard, mirrors tagger.js

  /* ------------------------------------------------------------------ *
   * Capture mode, v0.21.0 — 'quick' (zero mandatory interaction, the    *
   * default) or 'deep' (v0.20.0's pre-submit gate + full toasts,        *
   * unchanged). Read once at init and kept live via chrome.storage.     *
   * onChanged so a mode flip in the popup takes effect without a page   *
   * reload. Defaults to 'quick' (fail-open: the module-level `mode`     *
   * starts 'quick' before the async read resolves, and a page that gets *
   * a click in that tiny window sees quick behavior — no gate, no       *
   * blocked click — rather than deep's blocking one; a broken/slow read *
   * must never leave the user stuck behind a toast). *
   * ------------------------------------------------------------------ */
  let mode = 'quick';
  Store.getMode().then((m) => {
    mode = m;
  });
  // Guarded so a test-harness chrome stub with no onChanged (or no
  // chrome.storage at all) is a silent no-op rather than a load-time throw.
  const oc = globalThis.chrome && chrome.storage && chrome.storage.onChanged;
  if (oc && oc.addListener) {
    oc.addListener((changes, area) => {
      if (area === 'local' && changes[Store.KEY]) Store.getMode().then((m) => {
        mode = m;
      });
    });
  }

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
  /**
   * Runs the SAME Adapters.extract() + Store.fingerprint(question)
   * derivation handleCandidate has always used for "what question is on
   * screen, and its fp" — factored out (v0.20.0) so the submit gate below,
   * which needs the identical derivation to decide whether to engage,
   * can't drift from it.
   */
  function extractCurrentQuestionFp() {
    const data = safe(() => Adapters.extract(), null);
    const fp = data ? Store.fingerprint(data.question) : '';
    return { data, fp };
  }

  function handleCandidate(el, forcedOutcome) {
    const t = safe(() => (el.innerText || el.textContent || '').trim(), '');
    const outcome = forcedOutcome || (/^correct/i.test(t) ? 'correct' : 'incorrect');

    const { data, fp } = extractCurrentQuestionFp();
    if (!data) return;
    if (!fp) return; // never log an outcome we can't attribute to a question

    const now = Date.now();
    if (lastLogged && lastLogged.fp === fp && now - lastLogged.at < THROTTLE_MS) {
      return; // same question re-detected inside the throttle window — noise
    }
    lastLogged = { fp, outcome, at: now };

    // Measured ONCE here and shared with autoCaptureMiss below — same
    // reasoning as before v0.20.0 (banner-shifted fp on generic-adapter
    // pages makes a later recompute unreliable). v0.20.0: a fp with a
    // pending pre-submit rating overrides this with the snapshot taken at
    // submit-click time instead — see `pending` below; `measuredSeconds` is
    // still computed unconditionally as the fallback for when that
    // snapshot isn't a finite number.
    const measuredSeconds = computeSecondsSince(fp);

    // v0.20.0 — outcome join: a pending pre-submit rating for this exact fp
    // (see the submit gate section below) makes this outcome a genuine
    // PREDICTION rather than a postdiction. Consumed (deleted) once the
    // logOutcome().then() below confirms a fresh (non-deduped) record.
    const pending = pendingPre.get(fp) || null;
    const confAt = pending ? 'pre' : null;
    // v0.21.0 — submitSnapshots (taken in onDocumentClickCapture, both
    // modes, the instant the site's own submit control was clicked) is the
    // most reliable seconds-at-submit reading available: in deep mode it's
    // the exact same value pending.secondsAtSubmit already carries (that
    // branch is now just this same snapshot read back — see
    // onDocumentClickCapture), and in quick mode it's the ONLY submit-time
    // reading there is (a digit-key pre-rating's own secondsAtSubmit is
    // always null — see the keydown handler below). Falls through to
    // pending's own snapshot, then to the live measurement, for an outcome
    // that never went through the submit-selector click path at all
    // (forcedOutcome / the wpProQuiz attribute-toggle path has no click to
    // snapshot).
    const snap = submitSnapshots.get(fp);
    const seconds = Number.isFinite(snap)
      ? snap
      : pending && Number.isFinite(pending.secondsAtSubmit)
      ? pending.secondsAtSubmit
      : measuredSeconds;
    const confidence = pending ? pending.confidence : null;
    const confNum = pending ? pending.confNum : null;

    Store.logOutcome({
      fp,
      questionSnippet: data.question,
      outcome,
      confidence,
      confNum,
      confAt,
      mode,
      yourAnswers: data.yourAnswers,
      correctAnswers: data.correctAnswers,
      selectCount: data.selectCount,
      exam: data.exam,
      url: location.href.slice(0, 500),
      qnum: data.qnum ?? null,
      qtotal: data.qtotal ?? null,
      seconds
    })
      .then(({ record, deduped }) => {
        if (outcome === 'incorrect') autoCaptureMiss(data, seconds, pending, confAt);
        if (deduped) {
          // A pending entry surviving on an fp that already had an outcome
          // logged shouldn't happen in normal flow (the gate marks a fp
          // "handled" the instant it resolves, before any outcome could
          // exist yet) — but don't let it leak or apply to a later
          // re-detection if it somehow does.
          pendingPre.delete(fp);
          submitSnapshots.delete(fp);
          return;
        }
        if (!record) return;
        pendingPre.delete(fp); // consumed — the join above already used it
        submitSnapshots.delete(fp);
        if (mode === 'quick') {
          // QUICK: zero mandatory interaction. Correct gets no toast at
          // all; incorrect gets the passive captured pill (autoCaptureMiss
          // above already logged/merged the miss) — notes are opt-in via
          // the pill/N key, never prompted.
          if (outcome === 'incorrect') showCapturedPill(fp, data.qnum);
          return;
        }
        if (pending) {
          // Pre-rating present: correct gets no toast at all (the rating
          // is already recorded); incorrect gets the slim toast.
          if (outcome === 'incorrect') showSlimToast(fp);
        } else {
          showToast(fp, outcome, data); // today's full two-stage flow, confAt:'post'
        }
      })
      .catch((e) => console.debug('[Cert Buddy] logOutcome failed', e));
  }

  /**
   * Auto-creates (or, via addMiss's existing fp-merge, appends an attempt
   * onto) the miss record for an incorrect outcome — no tagger interaction
   * required. `pending`/`confAt` (v0.20.0): when a pre-submit rating exists
   * for this fp, its confidence/confNum are passed straight through here
   * (same `pending` handleCandidate already read for the logOutcome call
   * this follows) instead of being left for addMiss's join-from-outcome to
   * fill in later. With no pending entry, confidence/confNum/confAt stay
   * unset exactly as before v0.20.0 — addMiss's join-from-outcome fills
   * confidence in from whatever the (still today's-flow) toast records next.
   */
  function autoCaptureMiss(data, seconds, pending, confAt) {
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
      qtotal: data.qtotal ?? null,
      // Handed down from handleCandidate's single measurement — see the
      // comment above its logOutcome call.
      seconds,
      confidence: pending ? pending.confidence : null,
      confNum: pending ? pending.confNum : null,
      confAt: pending ? confAt : null,
      // Capture mode this miss was auto-captured under, v0.21.0 — the
      // module-level `mode`, same value just stamped onto the sibling
      // outcome record above.
      mode
    })
      .then(({ miss }) => {
        // Pre-rated 'didnt-know' keeps the same auto-classification the
        // post-outcome toast's AUTO_REASON_BY_CONFIDENCE path would have
        // applied — that path is skipped entirely when a pre-rating exists
        // (the gate replaces stage 1), so it's applied here at the join
        // instead. 'slip' is unreachable pre-submit (postdictive by nature),
        // so 'didnt-know' -> 'never-learned' is the only mapping that can
        // apply; setReasonIfEmpty keeps panel-set reasons untouchable.
        if (pending && pending.confidence === 'didnt-know' && miss && miss.fp) {
          return Store.setReasonIfEmpty(miss.fp, AUTO_REASON_BY_CONFIDENCE['didnt-know']);
        }
      })
      .catch((e) => console.debug('[Cert Buddy] auto-capture addMiss failed', e));
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

  /* ------------------------------------------------------------------ *
   * Feature 3 (v0.19.0) — per-question timer                            *
   *                                                                      *
   * fp -> epoch ms of the first time this question's fp was SIGHTED (the *
   * adapter reporting a question on screen — no banner/outcome needed).  *
   * `seconds` (time spent on the question before its outcome/miss is     *
   * recorded) is computed from this map at outcome-record creation and   *
   * in autoCaptureMiss below, via computeSecondsSince(). v1 has no        *
   * "un-sight" — a fp's first-seen stamp lives for the lifetime of this   *
   * content-script instance (a fresh page load resets it), same-shaped    *
   * accepted-limitation as the `lastLogged` dedupe var above.             *
   * ------------------------------------------------------------------ */
  const firstSeen = new Map();
  let lastSightedFp = null;
  let lastSightAt = 0;
  const SIGHT_THROTTLE_MS = 1500; // matches THROTTLE_MS's role above — mutation storms fire often, sighting doesn't need to

  /**
   * Measured exactly once per outcome event, in handleCandidate just before
   * its logOutcome call, and handed down to autoCaptureMiss so both records
   * share one value (recomputing in the async .then re-read a map the same
   * batch's sighting had since re-stamped). 3600s ceiling, 0s floor.
   * Returns null when this fp was never sighted (or fp is falsy).
   */
  function computeSecondsSince(fp) {
    if (!fp || !firstSeen.has(fp)) return null;
    return Math.min(3600, Math.max(0, Math.round((Date.now() - firstSeen.get(fp)) / 1000)));
  }

  /**
   * Runs the SAME adapter extraction + fingerprint derivation handleCandidate
   * uses (no second fingerprint path) for whatever question is currently on
   * screen, and stamps firstSeen the first time a given fp is noticed. Not
   * throttled itself — callers gate that (see maybeNoteSighting below) so
   * this stays cheap to call from a hot MutationObserver callback.
   */
  function noteSighting() {
    const data = safe(() => Adapters.extract(), null);
    const fp = data ? Store.fingerprint(data.question) : '';
    if (fp && fp !== lastSightedFp && !firstSeen.has(fp)) {
      firstSeen.set(fp, Date.now());
    }
    lastSightedFp = fp;
  }

  /** Throttle gate first (cheap escape for the common case — most mutation
   *  batches fire well inside the window), so noteSighting's own adapter
   *  extraction only actually runs at most once per SIGHT_THROTTLE_MS. */
  function maybeNoteSighting() {
    const now = Date.now();
    if (now - lastSightAt < SIGHT_THROTTLE_MS) return;
    lastSightAt = now;
    noteSighting();
  }

  const observer = new MutationObserver((mutations) => {
    // Outcomes first, sighting after: on a page where the outcome banner's
    // own arrival shifts the extracted question string (generic-adapter
    // fallback pages), sighting-first would stamp the shifted fp in this
    // same tick and hand its own outcome a false 0s — outcome-first makes
    // that case an honest null instead. Stable-fp pages (both real site
    // adapters) are order-indifferent: their fp is already stamped.
    for (const el of collectCandidates(mutations)) handleCandidate(el);
    for (const { el, outcome } of collectAttributeCandidates(mutations)) handleCandidate(el, outcome);
    maybeNoteSighting();
  });

  function startObserving() {
    if (document.body) {
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['style', 'class']
      });
      // Once at script init too — covers landing mid-question, before any
      // mutation has fired yet to trigger the observer-driven sighting above.
      maybeNoteSighting();
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
      --toast-accent: #6aabff;
      --toast-accent-ink: #071a33;
    }
    @media (prefers-color-scheme: dark) {
      :host {
        --toast-bg: #fafbf9;
        --toast-fg: #14171a;
        --toast-muted: #5c6a63;
        --toast-accent: #1b7af3;
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

    /* v0.20.0 pre-submit gate toast body — flex-column like .stage2, minus
       its padding-left (no corner-back button here to clear room for). */
    .gate { display: flex; flex-direction: column; align-items: stretch; gap: 8px; }
    /* Six labeled mechanism buttons make this the widest toast variant —
       cap it to the viewport and let the button row wrap instead of
       spilling past the left screen edge on narrow windows. */
    #toastGate { max-width: min(94vw, 720px); }
    #toastGate .btns { flex-wrap: wrap; }

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

    /* v0.21.0 — QUICK mode's compact pill, the two OPTIONAL touchpoints
       (digit-before-Check flash, post-miss "captured" confirmation).
       Docked just above where the toast variants sit (.toast bottom:76px)
       so the two never visually collide on the rare tick they'd both be up
       — see the hidePill() calls in showToast/showGateToast/showSlimToast,
       which are the actual mechanism that keeps them apart in practice.
       No delayed entrance (unlike .toast's 400ms change-blindness delay):
       the pill is a direct response to the user's OWN keypress or to a
       miss that was just captured, never a passively-arriving banner. */
    .pill {
      position: fixed; right: 16px; bottom: 132px;
      z-index: 2147483645;
      display: flex; align-items: center;
      background: var(--toast-bg); color: var(--toast-fg);
      border: 1px solid color-mix(in srgb, var(--toast-fg) 14%, transparent);
      border-left: 4px solid var(--toast-accent);
      border-radius: var(--radius);
      box-shadow: 0 10px 26px rgba(0,0,0,.3);
      padding: 7px 12px; font-family: var(--mono); font-size: 12px; font-weight: 600;
      cursor: default; pointer-events: auto;
    }
    .pill[hidden] { display: none; }
    /* Only the CAPTURED pill is clickable (the flash pill is a passive
       digit echo, nothing to click) — toggled via this class rather than
       always-interactive so the flash variant doesn't invite a click that
       does nothing. */
    .pill.captured { cursor: pointer; }
    .pill.captured:hover { background: color-mix(in srgb, var(--toast-accent) 14%, var(--toast-bg)); }
    .pill.captured:focus-visible { outline: 2px solid var(--toast-accent); outline-offset: 2px; }
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
      </div>
      <div class="toast" id="toastGate" hidden role="status" aria-live="polite">
        <div class="gate" id="gateBody">
          <span class="label">how sure?</span>
          <div class="btns" id="gateBtns">
            <button type="button" class="btn" data-val="memorized" data-key="1"><span class="lbl">memorized</span><span class="k">1</span></button>
            <button type="button" class="btn" data-val="knew" data-key="2"><span class="lbl">know it</span><span class="k">2</span></button>
            <button type="button" class="btn" data-val="intuition" data-key="3"><span class="lbl">intuition</span><span class="k">3</span></button>
            <button type="button" class="btn" data-val="narrowed" data-key="4"><span class="lbl">between two</span><span class="k">4</span></button>
            <button type="button" class="btn" data-val="guessed" data-key="5"><span class="lbl">guessed</span><span class="k">5</span></button>
            <button type="button" class="btn" data-val="didnt-know" data-key="6"><span class="lbl">didn't know</span><span class="k">6</span></button>
          </div>
          <div class="scale-wrap" id="gateScaleWrap" hidden>
            <div class="scale-label">how sure? (1–10)</div>
            <div class="scale" id="gateScale" tabindex="-1">
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
            <button type="button" class="btn" id="gateContinue">continue →</button>
          </div>
        </div>
        <button type="button" class="x" id="gateX" title="Skip — no rating recorded, click goes through">×</button>
      </div>
      <div class="toast" id="toastSlim" hidden role="status" aria-live="polite">
        <div class="stage2-row">
          <input type="text" id="slimInput" class="stage2-input" autocomplete="off" spellcheck="false"
                 placeholder="why? didn't know… / not sure about…">
          <div class="btns">
            <button type="button" class="btn" id="slimSilly"><span class="lbl">silly mistake</span></button>
            <button type="button" class="btn" id="slimSave">save</button>
          </div>
          <button type="button" class="details-link" id="slimDetails">details</button>
        </div>
        <button type="button" class="x" id="slimX" title="Close — anything already recorded stays">×</button>
      </div>
      <div class="pill" id="pill" hidden role="status" aria-live="polite">
        <span id="pillText"></span>
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

    // v0.20.0 — pre-submit gate toast wiring
    for (const btn of shadow.querySelectorAll('#gateBtns .btn')) {
      btn.addEventListener('click', () => chooseGateMechanism(btn.dataset.val));
    }
    for (const btn of shadow.querySelectorAll('#gateScale .scale-btn')) {
      btn.addEventListener('click', () => selectGateConfNum(Number(btn.dataset.n)));
    }
    shadow.getElementById('gateContinue').addEventListener('click', () => {
      if (!gateFp || !gateMechanism) return;
      gateConfNum = null;
      finishGate();
    });
    shadow.getElementById('gateX').addEventListener('click', skipGate);

    // v0.20.0 — slim post-outcome toast wiring (incorrect outcome, a
    // pre-submit rating already exists for this fp)
    shadow.getElementById('slimSilly').addEventListener('click', toggleSlimSilly);
    shadow.getElementById('slimSave').addEventListener('click', finishSlimSave);
    shadow.getElementById('slimX').addEventListener('click', dismissSlimToast);
    shadow.getElementById('slimDetails').addEventListener('click', () => {
      window.dispatchEvent(new CustomEvent('certbuddy:open-panel'));
    });
    const slimInput = shadow.getElementById('slimInput');
    slimInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        finishSlimSave();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        dismissSlimToast();
      }
    });

    // v0.21.0 — QUICK mode's pill. Only the CAPTURED state (see
    // showCapturedPill) is meant to react to a click — openPillNote()
    // itself no-ops when the pill isn't currently in that state, so this
    // one listener covers both variants without needing to be
    // added/removed as the pill's content changes.
    shadow.getElementById('pill').addEventListener('click', openPillNote);

    return shadow;
  }

  function ensureToast() {
    if (!toastShadow) {
      toastShadow = buildToastHost();
      toastEl = toastShadow.getElementById('toast');
    }
    return toastShadow;
  }

  /** Only one of {#toast, #toastGate, #toastSlim} is ever meant to be
   *  visible at once — called defensively at the top of every show*Toast
   *  function below so an edge-case race can't leave two stacked. */
  function hideAllToastVariants() {
    clearTimeout(toastTimer);
    if (!toastShadow) return;
    const t = toastShadow.getElementById('toast');
    if (t) t.hidden = true;
    const g = toastShadow.getElementById('toastGate');
    if (g) g.hidden = true;
    const s = toastShadow.getElementById('toastSlim');
    if (s) s.hidden = true;
  }

  /** True when none of {#toast, #toastGate, #toastSlim} is visible — the
   *  v0.21.0 pill deliberately does NOT count here (see its own doc
   *  comment: it coexists with "no toast up" by design). Used by the
   *  QUICK-mode digit-key handler below to avoid stealing a digit that's
   *  meant for a currently-open toast's own stage/scale/gate keys. */
  function noToastVariantVisible() {
    if (!toastShadow) return true;
    const t = toastShadow.getElementById('toast');
    const g = toastShadow.getElementById('toastGate');
    const s = toastShadow.getElementById('toastSlim');
    return (!t || t.hidden) && (!g || g.hidden) && (!s || s.hidden);
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
    hideAllToastVariants();
    hidePill(); // v0.21.0 — a full toast replaces the pill's job; see its own doc comment
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
    const setConfidenceDone = Store.setConfidence(fp, value, { force: toastRepicked, confAt: 'post' }).catch((e) =>
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
          confAt: 'post',
          qnum: (data && data.qnum) ?? null,
          qtotal: (data && data.qtotal) ?? null,
          // This toast only ever runs in deep mode (quick mode never shows
          // it — see handleCandidate's mode branch), so `mode` here is
          // always 'deep' in practice; stamped from the module-level var
          // rather than hardcoded so it stays correct if that ever changes.
          mode
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

  /* ------------------------------------------------------------------ *
   * Feature 4 (v0.20.0) — pre-submit confidence gate                    *
   *                                                                      *
   * Intercepts a click on the SITE's own submit/check button, BEFORE    *
   * the page reveals right/wrong, and offers a compact "how sure?"      *
   * pre-toast. Completing (or explicitly skipping via ×) releases the   *
   * original click via a programmatic re-click, so the site's own       *
   * handler still runs exactly as it would have. A pre-rating is joined *
   * onto the outcome/miss the moment the real outcome fires — see       *
   * handleCandidate/autoCaptureMiss above.                              *
   * ------------------------------------------------------------------ */

  // Default submit-button selectors the gate watches for; overridable via
  // globalThis.__certBuddyPreSubmitSelectors, read at ENGAGE time (inside
  // onDocumentClickCapture below), NOT once at load — so a test fixture can
  // set/replace it either before or after this script has already loaded.
  // The wpProQuiz pair is high-confidence for Tutorials Dojo's live "Check"
  // button; the data-purpose pair is a best-guess for Udemy. A page that
  // matches none of these never engages the gate — today's post-outcome-
  // only behavior, unchanged.
  const DEFAULT_PRE_SUBMIT_SELECTORS = [
    'input.wpProQuiz_button[name="check"]',
    '.wpProQuiz_button[name="check"]',
    'button[data-purpose*="check-answer"]',
    'button[data-purpose*="submit-answer"]'
  ];

  function getPreSubmitSelectors() {
    const override = globalThis.__certBuddyPreSubmitSelectors;
    return Array.isArray(override) && override.length ? override : DEFAULT_PRE_SUBMIT_SELECTORS;
  }

  // True while a click re-dispatched by this module's own gate
  // (releaseGateClick) is in flight, so onDocumentClickCapture ignores it
  // instead of trying to gate its own re-click.
  let passingThrough = false;

  // fps that have already been through the gate once — rated (see
  // pendingPre) or explicitly skipped (×). Checked at engage time so a
  // later click on the same question's submit control passes straight
  // through. Never cleared — same accepted per-session-only limitation as
  // firstSeen above (a fresh page load resets everything).
  const preHandledFps = new Set();

  // fp -> { confidence, confNum, secondsAtSubmit, ts } for a completed
  // (rated, not skipped) pre-submit toast, consumed the moment the
  // matching outcome fires — see handleCandidate's outcome join above.
  const pendingPre = new Map();

  // fp -> seconds-since-first-sighted, snapshotted at the INSTANT the
  // site's own submit control was clicked — v0.21.0, both modes. Deep
  // mode's gate used to compute this itself (see showGateToast); now it's
  // taken once in onDocumentClickCapture regardless of mode, so quick
  // mode's un-gated click still gets an accurate seconds-at-submit
  // reading for handleCandidate to prefer over a live re-measurement.
  // Consumed (deleted) the moment the matching outcome resolves.
  const submitSnapshots = new Map();

  // Fixed order/keys, per spec — unlike the outcome toast's dialects, the
  // gate always shows the SAME 6 buttons in the SAME order every time, so
  // no per-instance reshuffling (applyDialect-style) is needed here.
  const GATE_MECHANISMS = [
    { val: 'memorized', key: '1', label: 'memorized' },
    { val: 'knew', key: '2', label: 'know it' },
    { val: 'intuition', key: '3', label: 'intuition' },
    { val: 'narrowed', key: '4', label: 'between two' },
    { val: 'guessed', key: '5', label: 'guessed' },
    { val: 'didnt-know', key: '6', label: "didn't know" }
  ];

  let gateFp = null;
  let gateEl = null; // the submit control clicked — re-clicked once the gate resolves
  let gateSecondsAtSubmit = null;
  let gateMechanism = null;
  let gateConfNum = null;

  /**
   * Re-dispatches a click on `el` with passingThrough set, so
   * onDocumentClickCapture ignores this synthetic click instead of gating
   * it again — this is what lets the page's OWN click handler (Udemy's
   * check-answer XHR, wpProQuiz's reveal toggle, ...) finally run once the
   * gate has recorded (or skipped) a pre-rating.
   */
  function releaseGateClick(el) {
    if (!el) return;
    passingThrough = true;
    try {
      el.click();
    } catch (e) {
      console.debug('[Cert Buddy] gate re-click failed', e);
    } finally {
      passingThrough = false;
    }
  }

  function showGateToast(fp, el, secondsAtSubmit) {
    ensureToast();
    hideAllToastVariants();
    hidePill(); // v0.21.0 — see showToast's own comment
    gateFp = fp;
    gateEl = el;
    gateSecondsAtSubmit = secondsAtSubmit;
    gateMechanism = null;
    gateConfNum = null;
    for (const b of toastShadow.querySelectorAll('#gateBtns .btn')) b.classList.remove('flash');
    toastShadow.getElementById('gateScaleWrap').hidden = true;
    // No delayed reveal here (unlike showToast's 400ms change-blindness
    // delay) — this toast is a DIRECT response to the user's own click
    // (already preventDefault()-ed), not a passively-arriving banner, so
    // there's no masking render to wait out; an instant appearance is what
    // explains why their click didn't visibly do anything yet.
    toastShadow.getElementById('toastGate').hidden = false;
  }

  function hideGateToast() {
    const el = toastShadow && toastShadow.getElementById('toastGate');
    if (el) el.hidden = true;
    gateFp = null;
    gateEl = null;
    gateSecondsAtSubmit = null;
    gateMechanism = null;
    gateConfNum = null;
  }

  function chooseGateMechanism(value) {
    if (!gateFp) return;
    gateMechanism = value;
    for (const b of toastShadow.querySelectorAll('#gateBtns .btn')) {
      b.classList.toggle('flash', b.dataset.val === value);
    }
    toastShadow.getElementById('gateScaleWrap').hidden = false;
    toastShadow.getElementById('gateScale').focus();
  }

  /** Tapping a scale number completes the gate IMMEDIATELY (mechanism +
   *  scale = done) — no morph delay, unlike the outcome toast's stage1. */
  function selectGateConfNum(n) {
    if (!gateFp || !gateMechanism) return;
    gateConfNum = n;
    finishGate();
  }

  /** [continue →] (or Enter): completes with mechanism only, confNum stays
   *  null — only reachable once a mechanism is already chosen. */
  function finishGate() {
    if (!gateFp || !gateMechanism) return;
    pendingPre.set(gateFp, {
      confidence: gateMechanism,
      confNum: gateConfNum,
      secondsAtSubmit: gateSecondsAtSubmit,
      ts: Date.now()
    });
    preHandledFps.add(gateFp);
    const el = gateEl;
    hideGateToast();
    releaseGateClick(el);
  }

  /** × — skip entirely: no rating recorded, but the fp is still marked
   *  handled so the gate never re-engages on a later click for the same
   *  question. The post-outcome toast then runs exactly as it does today
   *  (confAt:'post'), once the real outcome fires. */
  function skipGate() {
    if (!gateFp) return;
    preHandledFps.add(gateFp);
    const el = gateEl;
    hideGateToast();
    releaseGateClick(el);
  }

  /**
   * Document-level CAPTURE-phase click gate. `engaged` is only set true
   * once preventDefault()/stopImmediatePropagation() have actually been
   * called — so if anything throws AFTER that point (inside
   * showGateToast, say), the catch block re-dispatches the original click
   * to release it, rather than leaving the page silently stuck with a
   * blocked click and no toast. If something throws BEFORE that point,
   * the native click was never prevented in the first place, so it just
   * proceeds normally — a broken gate must never block the user's exam.
   */
  function onDocumentClickCapture(e) {
    if (passingThrough) return;
    let matchedEl = null;
    let engaged = false;
    try {
      const target = e.target;
      if (!target || typeof target.closest !== 'function') return;
      const selectors = getPreSubmitSelectors();
      if (!Array.isArray(selectors) || !selectors.length) return;
      for (const sel of selectors) {
        matchedEl = target.closest(sel);
        if (matchedEl) break;
      }
      if (!matchedEl) return;

      const { fp } = extractCurrentQuestionFp();
      if (!fp) return;

      // v0.21.0 — snapshot seconds-at-submit for BOTH modes, the instant
      // the site's own submit control is clicked, regardless of whether
      // the gate itself goes on to engage. handleCandidate prefers this
      // over its own live re-measurement — see its own comment.
      submitSnapshots.set(fp, computeSecondsSince(fp));

      // QUICK mode: zero mandatory interaction — let the click proceed to
      // the site's own handler untouched. No preventDefault, no gate.
      if (mode !== 'deep') return;

      if (preHandledFps.has(fp)) return;

      e.preventDefault();
      e.stopImmediatePropagation();
      engaged = true;
      showGateToast(fp, matchedEl, submitSnapshots.get(fp));
    } catch (err) {
      console.debug('[Cert Buddy] submit gate error', err);
      if (engaged && matchedEl) releaseGateClick(matchedEl);
    }
  }
  document.addEventListener('click', onDocumentClickCapture, true);

  /* ------------------------------------------------------------------ *
   * Feature 4 (v0.20.0) — slim post-outcome toast                       *
   * (incorrect outcome, a pre-submit rating already exists for this fp) *
   * ------------------------------------------------------------------ */

  let slimFp = null;
  let slimSillyOn = false; // whether THIS toast's own setReasonIfEmpty('misread') call is currently standing

  function showSlimToast(fp, { immediate = false } = {}) {
    ensureToast();
    hideAllToastVariants();
    hidePill(); // v0.21.0 — see showToast's own comment
    slimFp = fp;
    slimSillyOn = false;
    const input = toastShadow.getElementById('slimInput');
    input.value = '';
    toastShadow.getElementById('slimSilly').classList.remove('flash');
    const el = toastShadow.getElementById('toastSlim');
    el.hidden = true;
    clearTimeout(toastTimer);
    // Same 400ms change-blindness delay as the full post-outcome toast
    // (showToast) when triggered by a passively-arriving banner — but the
    // quick-mode note pill (openPillNote) is a DIRECT click/keypress, and
    // a delayed response to a click reads as "nothing happened".
    if (immediate) {
      el.hidden = false;
      input.focus();
      return;
    }
    toastTimer = setTimeout(() => {
      el.hidden = false;
    }, 400);
  }

  function hideSlimToast() {
    clearTimeout(toastTimer);
    const el = toastShadow && toastShadow.getElementById('toastSlim');
    if (el) el.hidden = true;
    slimFp = null;
    slimSillyOn = false;
  }

  /**
   * Toggle button: sets/clears reason 'misread' via the SAME
   * setReasonIfEmpty/clearAutoReason machinery the main toast's
   * AUTO_REASON_BY_CONFIDENCE path uses — but this is a manual toggle,
   * never tied to (and never touching) the stored confidence, which must
   * stay exactly what the pre-submit gate predicted.
   */
  function toggleSlimSilly() {
    if (!slimFp || !toastShadow) return;
    const fp = slimFp;
    const btn = toastShadow.getElementById('slimSilly');
    if (!slimSillyOn) {
      slimSillyOn = true;
      btn.classList.add('flash');
      Store.setReasonIfEmpty(fp, 'misread')
        .then((m) => {
          // Only-if-empty guard declined (a reason from elsewhere already
          // stood) — this toggle isn't the one wearing it, revert visually.
          if (!m && slimFp === fp) {
            slimSillyOn = false;
            btn.classList.remove('flash');
          }
        })
        .catch((e) => console.debug('[Cert Buddy] slim setReasonIfEmpty failed', e));
    } else {
      slimSillyOn = false;
      btn.classList.remove('flash');
      Store.clearAutoReason(fp).catch((e) => console.debug('[Cert Buddy] slim clearAutoReason failed', e));
    }
  }

  /** [save] — commits typed text via the SAME setNotesByFp path stage2Save
   *  uses ("same gold-data input... same commit path" per spec). */
  function finishSlimSave() {
    if (!slimFp) return;
    const fp = slimFp;
    const text = (toastShadow.getElementById('slimInput').value || '').trim();
    if (text) {
      Store.setNotesByFp(fp, text).catch((e) => console.debug('[Cert Buddy] setNotesByFp failed', e));
    }
    hideSlimToast();
  }

  /** × — closes without saving any UNCOMMITTED input text; the silly-
   *  mistake toggle (if used) already committed the instant it was
   *  tapped, same "close is not undo" rule as the main toast's
   *  dismissToast. */
  function dismissSlimToast() {
    hideSlimToast();
  }

  /* ------------------------------------------------------------------ *
   * Feature 5 (v0.21.0) — QUICK-mode pill                               *
   *                                                                      *
   * The two OPTIONAL touchpoints quick mode offers in place of the       *
   * gate/toast: (a) a digit pressed before Check briefly flashes the     *
   * number back (see the keydown handler below, which builds this via   *
   * showFlashPill); (b) once an incorrect outcome auto-captures a miss,  *
   * a small "captured" pill appears — clicking it, or pressing N while   *
   * it's up, opens the SAME slim toast deep mode's pre-rated wrong       *
   * answers already use, so a note stays entirely opt-in, never          *
   * prompted. A new captured pill replaces any pending flash/captured    *
   * timer (see showCapturedPill/showFlashPill both starting with         *
   * clearTimeout(pillTimer)). Coexists with the toast variants —         *
   * hideAllToastVariants deliberately does NOT touch it (see its own     *
   * doc comment) — the toast-showing functions call hidePill()           *
   * themselves instead, since a full toast taking over is the only time  *
   * the two would otherwise overlap.                                     *
   * ------------------------------------------------------------------ */

  let pillTimer = null;
  // Set ONLY while the CAPTURED (interactive) pill is up — null the rest
  // of the time, including while the FLASH pill is up. openPillNote()
  // gates on this, so a click/N-press on a flash pill (or on no pill at
  // all) is a clean no-op rather than opening a slim toast for the wrong
  // (or no) fp.
  let pillFp = null;

  function hidePill() {
    clearTimeout(pillTimer);
    pillFp = null;
    if (!toastShadow) return;
    const p = toastShadow.getElementById('pill');
    if (p) {
      p.hidden = true;
      p.classList.remove('captured');
    }
  }

  /** Digit pressed before Check, quick mode only (see the keydown handler
   *  below) — a passive echo of what was just recorded, no click
   *  behavior, hides itself. */
  function showFlashPill(text) {
    ensureToast();
    pillFp = null;
    clearTimeout(pillTimer);
    const p = toastShadow.getElementById('pill');
    p.classList.remove('captured');
    toastShadow.getElementById('pillText').textContent = text;
    p.hidden = false;
    pillTimer = setTimeout(() => {
      p.hidden = true;
    }, 300);
  }

  /** A miss was just auto-captured (quick mode, incorrect outcome) —
   *  offers an on-demand note via click or the N key for 4s, then hides
   *  on its own. Never a prompt: the user drives this entirely. */
  function showCapturedPill(fp, qnum) {
    ensureToast();
    pillFp = fp;
    clearTimeout(pillTimer);
    const p = toastShadow.getElementById('pill');
    p.classList.add('captured');
    toastShadow.getElementById('pillText').textContent = Number.isFinite(qnum) ? `captured · #${qnum}` : 'captured';
    p.hidden = false;
    pillTimer = setTimeout(hidePill, 4000);
  }

  /** Click on the captured pill, or the N key while it's visible (see the
   *  window keydown handler below) — opens the same slim toast deep
   *  mode's pre-rated wrong answers use, so notes stay on-demand. No-op
   *  when pillFp isn't set (the flash pill, or no pill at all). */
  function openPillNote() {
    if (!pillFp) return;
    const fp = pillFp;
    hidePill();
    showSlimToast(fp, { immediate: true });
  }

  window.addEventListener(
    'keydown',
    (e) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return; // plain keys only
      // isTypingTarget is the REAL guard against stealing digits from the
      // stage-2 input (not stopPropagation on the input's own listener
      // below — this is a capture-phase listener on window, so it sees the
      // event before that handler runs). Checked once, up front, for every
      // branch below (gate included).
      if (isTypingTarget(e)) return;

      // v0.21.0 — captured-pill note shortcut, checked before everything
      // else: N (either case) opens the slim toast for the miss the pill
      // is currently showing. pillFp is only ever non-null while the
      // CAPTURED (interactive) pill variant is actually visible — see
      // showCapturedPill/hidePill — so this is naturally a no-op the rest
      // of the time, no extra visibility check needed.
      if (pillFp && (e.key === 'n' || e.key === 'N')) {
        e.preventDefault();
        openPillNote();
        return;
      }

      // v0.21.0 — QUICK-mode optional digit pre-rating: a bare digit
      // pressed before Check, with no toast variant currently up (the
      // pill doesn't count — see noToastVariantVisible), pre-rates the
      // CURRENT on-screen question's confidence number ahead of time.
      // Overwritable — last key wins, same as re-picking on the deep-mode
      // gate — so a fat-finger is correctable right up until the outcome
      // consumes it in handleCandidate. Deliberately NOT added to
      // preHandledFps: quick mode never gates on that set, it's deep-mode-
      // only bookkeeping.
      if (mode === 'quick' && noToastVariantVisible()) {
        const n = SCALE_KEYS[e.key];
        if (n) {
          const { fp } = extractCurrentQuestionFp();
          if (!fp) return;
          pendingPre.set(fp, { confidence: null, confNum: n, secondsAtSubmit: null, ts: Date.now() });
          e.preventDefault();
          showFlashPill(String(n));
          return;
        }
      }

      // v0.20.0 — pre-submit gate toast keys, checked first: it's a
      // distinct modal from the outcome toast below, and the two are
      // mutually exclusive (see hideAllToastVariants). Per spec: digits
      // 1-6 select mechanism, Enter = continue, Escape = skip (× twin) —
      // no keyboard shortcut for the scale on this toast (click-only).
      if (gateFp && toastShadow) {
        const gateToastEl = toastShadow.getElementById('toastGate');
        if (gateToastEl && !gateToastEl.hidden) {
          if (e.key === 'Escape') {
            e.preventDefault();
            skipGate();
            return;
          }
          if (e.key === 'Enter') {
            if (gateMechanism) {
              e.preventDefault();
              gateConfNum = null;
              finishGate();
            }
            return;
          }
          const mech = GATE_MECHANISMS.find((m) => m.key === e.key);
          if (mech) {
            e.preventDefault();
            chooseGateMechanism(mech.val);
          }
          return;
        }
      }

      if (!toastFp || !toastEl || toastEl.hidden) return;

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
