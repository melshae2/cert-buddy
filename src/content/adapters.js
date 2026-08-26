/**
 * Page adapters: best-effort extraction of question / your answer / correct
 * answer from whatever practice-exam page you're on.
 *
 * Everything an adapter returns is only a PREFILL — the tagger panel is fully
 * editable, so a wrong guess costs you an edit, not a bad record.
 *
 * Adding a site adapter:
 *   1. Open the results page for a question you got wrong.
 *   2. Inspect the question block, your selected option, and the correct one.
 *   3. Copy the TEMPLATE below, fill in the selectors, drop it in ADAPTERS
 *      above `generic` (first match wins).
 */
(function (root) {
  const MAX_Q = 1200;

  const clean = (s) =>
    String(s || '')
      .replace(/\s+/g, ' ')
      .trim();

  const truncate = (s, n = MAX_Q) => (s.length > n ? s.slice(0, n) + '…' : s);

  // Question numbers ("Question 33:", "Question 14 of 65 —", "Q7.") change on
  // every retake, so a raw copy of the stem poisons the fingerprint dedupe in
  // store.js — the same question looks new each time. Only the marker itself
  // is stripped; "(Select two)" and everything else in the stem stays.
  const STEM_MARKER_RE = /^\s*(question|q)\s*\d+(\s*(of|\/)\s*\d+)?\s*[:.\-–—]*\s*/i;

  // Same "question/q FIRST" shape as STEM_MARKER_RE above, but with the
  // number (and optional "of M") CAPTURED instead of merely matched, so
  // parseQuestionNumber (below) can report {qnum, qtotal} rather than just
  // stripping the text. Keep this in lockstep with STEM_MARKER_RE's own
  // shape — the two are meant to recognize the exact same marker prefixes.
  const QNUM_MARKER_RE = /^\s*(?:question|q)\s*(\d+)(?:\s*(?:of|\/)\s*(\d+))?\s*[:.\-–—]*\s*/i;

  // A second, unrelated marker shape some Tutorials Dojo (wpProQuiz) stems
  // use: the DOM's own list index prepended ahead of the literal word
  // "QUESTION" ("1. QUESTION: which service…") — NUMBER first this time, the
  // mirror image of "Question N". STEM_MARKER_RE never covered this shape
  // (it only strips a leading "question"/"q"), so it's never stripped from
  // the stored question text — only parseQuestionNumber reads it, purely for
  // the qnum metadata.
  const QNUM_TD_MARKER_RE = /^\s*(\d+)\.\s*question\b/i;

  // Fallback source when the stem itself carries no marker at all — e.g. a
  // Udemy question-content block with a clean stem, while the PAGE's own
  // heading spells out "Question 7 of 75" above it. Matched against whatever
  // pageText the caller hands in (document.title + the first h1/h2's text).
  const QNUM_HEADING_RE = /question\s+(\d+)\s+of\s+(\d+)/i;

  /**
   * Pure: which question number (and, when stated, how many total) a raw
   * (pre-strip) stem, a sibling qnumText snippet, or a page heading names.
   * qnum/qtotal are METADATA ONLY — never part of the fingerprint (see
   * STEM_MARKER_RE's own comment: the same question's number changes on
   * every randomized retake, so it must never leak into what gets hashed).
   * Priority:
   *   1. the stem's own leading marker, "question/q FIRST" shape
   *      (QNUM_MARKER_RE — same shapes STEM_MARKER_RE strips: "Question
   *      33:", "Question 14 of 65 —", "Q7.")
   *   2. the stem's own leading marker, "number FIRST" TD shape
   *      (QNUM_TD_MARKER_RE — "1. QUESTION: …")
   *   3. `qnumText` — a sibling snippet an adapter hands in when the number
   *      is rendered OUTSIDE the stem entirely (Tutorials Dojo's
   *      .wpProQuiz_question_page div, a sibling of the stem element, not a
   *      descendant of it — see tutorialsDojoAdapter.extract()'s own
   *      out.qnumText). Tried against the same two stem-marker shapes, TD's
   *      "number FIRST" one first, then the "question N of M" heading shape.
   *   4. `pageText` matching "question N of M" anywhere in it — the Udemy
   *      exam-title case, where the stem itself carries no marker at all but
   *      the page chrome above it does.
   * Returns {qnum:null, qtotal:null} when nothing matches any of the above.
   * Pure — no DOM access in here, callers hand in plain strings (see
   * extract()'s own document.title/h1/h2 read below, and
   * tutorialsDojoAdapter.extract()'s out.qnumText). qnumText is metadata
   * input only, same rule as qnum/qtotal themselves — it must never be
   * merged into a stored `question` and never reaches fingerprint().
   */
  function parseQuestionNumber(rawStem, pageText, qnumText) {
    const stem = String(rawStem || '');
    let m = stem.match(QNUM_MARKER_RE);
    if (m) return { qnum: Number(m[1]), qtotal: m[2] ? Number(m[2]) : null };
    m = stem.match(QNUM_TD_MARKER_RE);
    if (m) return { qnum: Number(m[1]), qtotal: null };
    const qt = String(qnumText || '');
    m = qt.match(QNUM_TD_MARKER_RE);
    if (m) return { qnum: Number(m[1]), qtotal: null };
    m = qt.match(QNUM_HEADING_RE);
    if (m) return { qnum: Number(m[1]), qtotal: Number(m[2]) };
    m = String(pageText || '').match(QNUM_HEADING_RE);
    if (m) return { qnum: Number(m[1]), qtotal: Number(m[2]) };
    return { qnum: null, qtotal: null };
  }

  const text = (el) => (el ? clean(el.innerText || el.textContent) : '');

  function labelTextFor(input) {
    if (!input) return '';
    if (input.labels && input.labels.length) return text(input.labels[0]);
    const wrapping = input.closest('label');
    if (wrapping) return text(wrapping);
    // Fall back to the smallest ancestor that carries some text.
    let node = input.parentElement;
    for (let i = 0; i < 3 && node; i++, node = node.parentElement) {
      const t = text(node);
      if (t.length > 2) return t;
    }
    return '';
  }

  /** Course titles rarely carry the exam code, so fall back to the cert name. */
  const EXAM_NAMES = [
    [/solutions?\s+architect\s*[–—-]?\s*professional/i, 'SAP-C02'],
    [/solutions?\s+architect\s*[–—-]?\s*associate/i, 'SAA-C03'],
    [/advanced\s+networking/i, 'ANS-C01'],
    [/devops\s+engineer/i, 'DOP-C02'],
    [/security\s*[–—-]?\s*specialty/i, 'SCS-C02'],
    [/developer\s*[–—-]?\s*associate/i, 'DVA-C02'],
    [/sysops\s+administrator/i, 'SOA-C02'],
    [/cloud\s+practitioner/i, 'CLF-C02']
  ];

  function detectExam(pageText) {
    const s = String(pageText);
    const m = s.match(
      /\b(SAP-C0\d|SAA-C0\d|ANS-C0\d|SCS-C0\d|DVA-C0\d|SOA-C0\d|DOP-C0\d|DEA-C0\d|MLA-C0\d|CLF-C0\d|AZ-\d{3}|SC-\d{3}|CKA|CKAD|CISSP|Security\+)\b/i
    );
    if (m) return m[1].toUpperCase();
    for (const [re, code] of EXAM_NAMES) if (re.test(s)) return code;
    return '';
  }

  /**
   * Which stem discriminator the question turns on — the phrase that picks
   * out the correct answer among several plausible services/approaches.
   * Ordered list, first match wins; ids match src/lib/taxonomy.js DISCRIMINATORS.
   */
  const DISC_PATTERNS = [
    ['cost', /most cost-effective|least expensive|lowest cost|minimi[sz]e\s+cost|most economical/i],
    [
      'ops',
      /least operational overhead|minimal (operational|management|administrative)|least (management|administrative|maintenance) overhead|operationally (efficient|simplest)/i
    ],
    ['rto-rpo', /\bRTO\b|\bRPO\b|recovery (time|point) objective/i],
    ['perf', /lowest latency|highest (performance|throughput)|fastest|best performance|single-digit millisecond/i],
    ['security', /most secure|maximum security|least privilege/i],
    ['migration', /minimal downtime|least downtime|minimal (code )?changes|minimal disruption|migrate .{0,30}(quickly|fastest)/i]
  ];

  function detectDiscriminator(stemText) {
    const s = String(stemText || '');
    for (const [id, re] of DISC_PATTERNS) {
      if (re.test(s)) return id;
    }
    return '';
  }

  /**
   * How many options a question wants picked. Parses "select/choose/pick
   * two/three/four" (or the numeral) out of the stem; falls back to how many
   * correct answers were actually found (a real multi-select signal even
   * with no explicit "select N" wording); defaults to 1 (plain
   * single-select).
   *
   * `inputType` (optional, 'checkbox' | 'radio' | null/undefined — see
   * tutorialsDojoAdapter.extract()'s out.inputType) is consulted ONLY when
   * the stem regex above missed AND correctAnswers.length <= 1: a real
   * checkbox input on the page is itself a multi-select signal even before
   * the correct answer is revealed (Tutorials Dojo review pages sometimes
   * show a checkbox question with only one correct option checked so far).
   * 2 is the floor, not a guess at the true count — the true count is
   * unknown until reveal, but a floor of 2 beats a false 1. Omitted/absent
   * inputType reproduces the pre-existing behavior exactly.
   */
  function computeSelectCount(stem, correctAnswers, inputType) {
    const m = String(stem || '').match(/(?:select|choose|pick)\s+(two|three|four|2|3|4)/i);
    if (m) {
      const WORD_TO_N = { two: 2, three: 3, four: 4 };
      const raw = m[1].toLowerCase();
      return WORD_TO_N[raw] || Number(raw);
    }
    const corrects = Array.isArray(correctAnswers) ? correctAnswers : [];
    if (corrects.length > 1) return corrects.length;
    if (inputType === 'checkbox') return 2;
    return 1;
  }

  /** First selector in the list that matches anything. */
  function pick(selectors, root = document) {
    for (const s of selectors) {
      const el = safe(() => root.querySelector(s), null);
      if (el && text(el)) return el;
    }
    return null;
  }

  function pickAll(selectors, root = document) {
    for (const s of selectors) {
      const els = safe(() => [...root.querySelectorAll(s)], []);
      if (els.length >= 2) return els; // a real option list, not one stray node
    }
    return [];
  }

  const BADGE_RE = /^(correct answer|your answer|correct|incorrect|your selection)$/i;

  /**
   * Question-list sidebars are the great trap of review pages: Udemy's carries a
   * Correct/Incorrect label for EVERY question in the test, so an unscoped probe
   * scrapes 60 questions at once instead of the one on screen.
   */
  const NAV_SEL =
    '[data-purpose="questions-list"],[data-purpose="question-navigation-item"],' +
    '[class*="question-navigation"],[class*="sidenav"],[class*="sidebar"],' +
    '[class*="footer"],[data-purpose*="footer"],nav,aside,footer,header,' +
    // Tutorials Dojo (wpProQuiz): the review grid / results list is the same
    // trap as Udemy's question-navigation sidebar — every question in the
    // test gets a "Correct answer" style marker in there, so an unscoped
    // scan would happily attribute question 40's result to question 3.
    '.wpProQuiz_reviewDiv,.wpProQuiz_results,.wpProQuiz_resultsList,[class*="wpProQuiz_review"]';

  /**
   * True nav/sidebar/footer — but a matched "nav" that CONTAINS the answer
   * options is really the page-layout wrapper picking up a stray modifier
   * class (Udemy: `quiz-page-layout--with-sidebar--yKlnV` wraps the whole
   * quiz). Treating that as nav discards the entire question and leaves only
   * the footer to scrape.
   */
  function isRealNav(candidate) {
    if (safe(() => candidate.querySelector('[data-purpose="answer"]'), null)) return false;
    if (safe(() => candidate.querySelectorAll('input[type=radio]').length, 0) >= 2) return false;
    return true;
  }

  function inNav(el) {
    let n = el;
    while (n && n.matches) {
      if (safe(() => n.matches(NAV_SEL), false) && isRealNav(n)) return true;
      n = n.parentElement;
    }
    return false;
  }

  /**
   * SPA exam players keep PREVIOUS questions in the DOM, display:none'd, when
   * you advance — an extraction that anchors on the first match in document
   * order reads the stale question and mis-attributes the fingerprint (which
   * silently corrupts outcome logging). Only visible elements may anchor.
   */
  const isVisible = (el) => !!(el && el.getClientRects && el.getClientRects().length);

  /** Drop elements that are contained by another element in the same list. */
  function outermost(els) {
    return els.filter((el) => !els.some((other) => other !== el && other.contains(el)));
  }

  /** Every class token on an element and its descendants. */
  function classTokens(el) {
    const nodes = [el, ...safe(() => [...el.querySelectorAll('*')], [])];
    const out = [];
    for (const n of nodes) {
      const c = typeof n.className === 'string' ? n.className : '';
      if (c) out.push(...c.split(/\s+/));
    }
    return out;
  }

  /**
   * Hashed CSS-module names keep the semantic part intact
   * (`answer-result-pane--correct--9zQrT`), so match the word between
   * separators. "incorrect" must not read as "correct" — the leading `-|^`
   * guard is what stops that.
   */
  function marks(el) {
    const t = classTokens(el);
    return {
      correct: t.some((x) => /(?:^|-)correct(?:-|$)/i.test(x)),
      incorrect: t.some((x) => /(?:^|-)incorrect(?:-|$)/i.test(x))
    };
  }

  // Udemy's badge is a whole sentence ("Your selection is incorrect"), so strip
  // the phrase before the bare words or you're left with orphans like
  // "selection Use Amazon Route 53…".
  const stripBadges = (s) =>
    clean(
      String(s)
        .replace(/\byour (answer|selection) is (in)?correct\b/gi, '')
        .replace(/\b(correct answer|your answer|your selection)\b/gi, '')
        .replace(/\b(incorrect|correct)\b/gi, '')
    );

  /**
   * Locate option rows with no reliance on class names at all: find the leaf
   * elements whose entire text is a review badge, and take their containers.
   */
  function answersByBadge() {
    const rows = new Set();
    for (const el of document.querySelectorAll('span,div,p,em,strong,b')) {
      if (el.children.length === 0 && BADGE_RE.test(text(el)) && el.parentElement && !inNav(el)) {
        rows.add(el.parentElement);
      }
    }
    return outermost([...rows]);
  }

  /* ------------------------------------------------------------------ *
   * UDEMY practice tests (review mode).                                  *
   *                                                                      *
   * Udemy ships hashed CSS-module class names (`…--correct--9zQrT`) that   *
   * change between releases, so this never matches an exact class. Hooks   *
   * confirmed against a live SAP-C02 practice test:                        *
   *   [data-purpose="answer"]                        one option row        *
   *   [data-purpose="answer-body"]                   the option's text     *
   *   [data-purpose="answer-result-header-user-label"]  marks YOUR pick    *
   *   class token `--correct--` / `--incorrect--`    marks the right one   *
   * Options are NOT radio inputs, and the only checked inputs on the page  *
   * are sidebar filters — so input state is ignored entirely here.         *
   * ------------------------------------------------------------------ */
  const udemyAdapter = {
    name: 'udemy',
    enabled: true,
    match: (loc) => /(^|\.)udemy\.com$/i.test(loc.hostname),
    extract() {
      const out = { question: '', yourAnswer: '', correctAnswer: '', yourAnswers: [], correctAnswers: [] };

      // Layer 1: the real hook. Layer 2: class substrings. Layer 3: badges.
      let rows = [...document.querySelectorAll('[data-purpose="answer"]')];
      if (!rows.length) {
        rows = pickAll([
          '[class*="answer-result-pane"]',
          '[class*="quiz-answer"]',
          'label[class*="answer"]'
        ]);
      }
      rows = outermost(rows.filter((r) => !inNav(r) && isVisible(r)));
      if (!rows.length) rows = answersByBadge().filter(isVisible);
      if (!rows.length) return out;

      const yours = [];
      const right = [];
      for (const row of rows) {
        const body =
          text(row.querySelector('[data-purpose="answer-body"]')) || stripBadges(text(row));
        if (!body) continue;

        const m = marks(row);
        const t = text(row);
        const mine =
          !!row.querySelector('[data-purpose*="user-label"]') ||
          /\b(your answer|your selection)\b/i.test(t);
        // Correctness is marked by class token in some views and only by the
        // visible "Correct answer" badge text in others (Practice mode).
        const isRight =
          (m.correct && !m.incorrect) ||
          /^correct answer\b/i.test(t) ||
          /\byour (answer|selection) is correct\b/i.test(t);

        if (mine) yours.push(body);
        if (isRight) right.push(body);
      }

      // "Choose two" questions legitimately have several of each.
      const uniq = (a) => [...new Set(a)];
      const uniqYours = uniq(yours);
      const uniqRight = uniq(right);
      out.yourAnswer = uniqYours.join(' | ');
      out.correctAnswer = uniqRight.join(' | ');
      out.yourAnswers = uniqYours;
      out.correctAnswers = uniqRight;

      // No prompt hook exists on this page, so read the blocks above the
      // options — same idea as the generic stem, anchored on the option list
      // and with the sidebar excluded.
      out.question = truncate(stemAbove(rows[0]));

      return out;
    }
  };

  /* ------------------------------------------------------------------ *
   * TUTORIALS DOJO — wpProQuiz (the WordPress/LearnDash-family quiz     *
   * engine portal.tutorialsdojo.com runs practice exams on).            *
   *                                                                     *
   * Review-mode pages keep EVERY question in the test in the DOM at     *
   * once as sibling .wpProQuiz_listItem blocks, with only the current   *
   * one visible via a display toggle — the identical stale-DOM trap as  *
   * Udemy's SPA player (see `isVisible` above), so every lookup here is *
   * scoped to the one visible block, never document-wide. Options are   *
   * real radio/checkbox inputs. The correct option's <li> carries       *
   * `wpProQuiz_answerCorrect`; a wrong SELECTED option's <li> carries    *
   * `wpProQuiz_answerIncorrect`. A "Category: …" line sits above the    *
   * stem but is a SIBLING of .wpProQuiz_question_text, not a child of   *
   * it, so scoping the question read to that element alone already      *
   * excludes it.                                                        *
   * ------------------------------------------------------------------ */

  /** The one visible question block, or its nearest ancestor if the
   *  .wpProQuiz_listItem wrapper isn't present in some markup variant. */
  function tdVisibleBlock() {
    const items = [...document.querySelectorAll('.wpProQuiz_listItem')].filter(isVisible);
    if (items.length) return items[0];
    const texts = [...document.querySelectorAll('.wpProQuiz_question_text')].filter(isVisible);
    if (!texts.length) return null;
    return (
      texts[0].closest('.wpProQuiz_listItem') ||
      texts[0].closest('.wpProQuiz_question') ||
      texts[0].parentElement
    );
  }

  const tutorialsDojoAdapter = {
    name: 'tutorials-dojo',
    enabled: true,
    // wpProQuiz's stale hidden siblings make the generic document-wide
    // heuristics actively dangerous here (they'd happily scrape question 12
    // while question 34 is on screen) — safer to return partial data for a
    // field this adapter couldn't resolve than to have extract() backfill it
    // from the wrong question. See extract()'s use of this flag below.
    noGenericBackfill: true,
    // The force-flag half mirrors outcomes.js's IS_TUTORIALS_DOJO gate: only
    // the td.html fixture ever sets it, so the harness exercises this adapter
    // through the central extract() path instead of falling to genericAdapter
    // (which is what harness runs silently did before v0.19.0).
    match: (loc) =>
      loc.hostname === 'portal.tutorialsdojo.com' ||
      loc.hostname.endsWith('.tutorialsdojo.com') ||
      !!globalThis.__certBuddyForceTutorialsDojo,
    extract() {
      const out = { question: '', yourAnswer: '', correctAnswer: '', yourAnswers: [], correctAnswers: [] };
      const block = tdVisibleBlock();
      if (!block) return out;

      const stemEl = block.querySelector('.wpProQuiz_question_text');
      if (stemEl) {
        // Defensive clone-and-strip: the Category line is normally a
        // sibling, not a descendant, of .wpProQuiz_question_text — but if
        // some template variant ever nests it inside, don't trust structure
        // alone to keep it out of the stem.
        const clone = stemEl.cloneNode(true);
        for (const cat of clone.querySelectorAll('.wpProQuiz_category')) cat.remove();
        out.question = truncate(text(clone));
      }

      const options = [...block.querySelectorAll('li.wpProQuiz_questionListItem')].filter(isVisible);
      const yours = [];
      const right = [];
      const inputs = [];
      for (const li of options) {
        const input = li.querySelector('.wpProQuiz_questionInput');
        const label = labelTextFor(input) || text(li);
        if (input) inputs.push(input);
        if (!label) continue;
        if (input && input.checked) yours.push(label);
        if (li.classList.contains('wpProQuiz_answerCorrect')) right.push(label);
      }
      // Multi-select ("Select TWO") questions legitimately have several of
      // each; single-select questions just get one-element arrays.
      out.yourAnswer = yours.join(' | ');
      out.yourAnswers = yours;
      // Stays '' until the review UI actually marks a correct <li> — never
      // guessed at from elsewhere on the page.
      out.correctAnswer = right.join(' | ');
      out.correctAnswers = right;

      // Real radio/checkbox inputs (see this adapter's own file-header
      // comment) — a checkbox input is itself a multi-select signal even
      // before any option is marked correct, consulted by
      // computeSelectCount's own inputType fallback at the central
      // extract() call site below. Computation input only — never stored on
      // a record. Other adapters (Udemy's options aren't form inputs at all)
      // leave this unset.
      out.inputType = inputs.some((i) => i.type === 'checkbox' && isVisible(i))
        ? 'checkbox'
        : inputs.some((i) => i.type === 'radio' && isVisible(i))
        ? 'radio'
        : null;

      // The question number, when TD renders it OUTSIDE the stem entirely —
      // a SIBLING of .wpProQuiz_question_text, not a descendant (same
      // sibling relationship as the Category line above), so the stem read
      // above never sees it. Two known wpProQuiz markup variants: a
      // .wpProQuiz_question_page div ("Question 19 of 65" / "19. Question"),
      // or, failing that, a heading inside the block. First non-empty
      // candidate wins; '' when neither is present. Metadata input only —
      // see parseQuestionNumber's own doc comment: never merged into
      // out.question, never reaches fingerprint().
      const qPage = text(block.querySelector('.wpProQuiz_question_page'));
      out.qnumText = qPage || text(block.querySelector('h1,h2,h3,h4,h5,h6'));

      return out;
    }
  };

  /* ------------------------------------------------------------------ *
   * TEMPLATE — copy me, don't ship me. Kept disabled so it never fires. *
   * ------------------------------------------------------------------ */
  const templateAdapter = {
    name: 'template-site',
    enabled: false,
    match: (loc) => loc.hostname.endsWith('example-exam-site.com'),
    extract() {
      const q = document.querySelector('.question-body');
      const yours = document.querySelector('.answer.selected');
      const right = document.querySelector('.answer.correct');
      return {
        question: truncate(text(q)),
        yourAnswer: text(yours),
        correctAnswer: text(right)
      };
    }
  };

  /* ------------------------------------------------------------------ *
   * GENERIC — DOM heuristics. Works on a surprising number of quiz UIs,  *
   * gets it partly wrong on the rest. That's fine; you edit before save. *
   * ------------------------------------------------------------------ */
  const genericAdapter = {
    name: 'generic',
    enabled: true,
    match: () => true,
    extract() {
      const result = { question: '', yourAnswer: '', correctAnswer: '', yourAnswers: [], correctAnswers: [] };

      // 1. An explicit text selection always wins — you highlighted it on purpose.
      const sel = clean(window.getSelection ? String(window.getSelection()) : '');

      // 2. Your answer: whatever is checked, or whatever is styled "selected".
      //    Nav is excluded — a results sidebar's filter checkboxes are checked
      //    inputs too, and would otherwise be recorded as your answer.
      const checked = [...document.querySelectorAll('input:checked')].filter(
        (el) => !inNav(el) && isVisible(el.closest('label') || el.parentElement || el)
      );
      const yourEls = checked.length
        ? checked.map(labelTextFor)
        : [...document.querySelectorAll('[class*="selected" i],[aria-checked="true"]')]
            .filter((el) => !inNav(el))
            .slice(0, 4)
            .map(text);
      result.yourAnswer = yourEls.filter(Boolean).slice(0, 4).join(' | ');
      result.yourAnswers = yourEls.filter(Boolean).slice(0, 4);

      // 3. Correct answer: common markup conventions, then a text pattern.
      const correctEls = [
        ...document.querySelectorAll(
          '[class*="correct" i]:not([class*="incorrect" i]),[data-correct="true"]'
        )
      ]
        .filter((el) => !inNav(el)) // sidebars label every question in the test
        .map(text)
        .filter((t) => t && t.length < 400);
      if (correctEls.length) {
        result.correctAnswer = correctEls.slice(0, 4).join(' | ');
        result.correctAnswers = correctEls.slice(0, 4);
      } else {
        const m = document.body.innerText.match(
          /correct answer(?:\s*is)?\s*[:\-–]\s*([^\n]{2,300})/i
        );
        if (m) {
          result.correctAnswer = clean(m[1]);
          result.correctAnswers = [result.correctAnswer];
        }
      }

      // 4. Question: the text immediately preceding the option list.
      result.question = truncate(sel.length > 20 ? sel : questionStem());

      return result;
    }
  };

  /**
   * The stem sits above the options and the explanation sits below them, so we
   * find the first option block and read backwards through its siblings.
   */
  function questionStem() {
    const inputs = [...document.querySelectorAll('input[type=radio],input[type=checkbox]')].filter(
      (el) => !inNav(el) && isVisible(el.closest('label') || el.parentElement || el)
    );
    const first = inputs.length ? inputs[0].closest('label') || inputs[0].parentElement : null;
    return (first && stemAbove(first)) || longestBlock();
  }

  /** Read backwards from the option list to collect the question stem. */
  function stemAbove(first) {
    let node = first;
    for (let depth = 0; depth < 6 && node.parentElement && node !== document.body; depth++) {
      const parent = node.parentElement;
      const siblings = [...parent.children];
      const before = siblings
        .slice(0, siblings.indexOf(node))
        .filter((e) => !inNav(e))
        .map(text)
        .filter((t) => t.length > 25); // 25 clears UI chrome ("Practice mode (Beta)")

      if (before.length) {
        // Take the closest blocks above the options, newest-first, up to ~600 chars.
        const picked = [];
        let total = 0;
        for (let i = before.length - 1; i >= 0 && total < 600 && picked.length < 4; i--) {
          picked.unshift(before[i]);
          total += before[i].length;
        }
        return picked.join('\n\n'); // parts are already cleaned; keep the break
      }
      node = parent;
    }
    return '';
  }

  /**
   * Last-resort stem: the longest prose block on the page.
   *
   * The nav filter is load-bearing, not defensive. Udemy's question sidebar
   * holds the FULL text of every question in the test and clamps it to one
   * visible line with CSS — so an unfiltered scan happily returns question 57
   * while you're looking at question 34. Page footers are excluded for the same
   * reason ("Do Not Sell or Share My Personal Information" is a long block too).
   */
  function longestBlock() {
    const blocks = [...document.querySelectorAll('p,article,section,div')]
      .filter((el) => !inNav(el) && isVisible(el))
      .map(text)
      .filter((t) => t.length > 80 && t.length < MAX_Q);
    return blocks.sort((a, b) => b.length - a.length)[0] || '';
  }

  const ADAPTERS = [udemyAdapter, tutorialsDojoAdapter, templateAdapter, genericAdapter];

  root.CertBuddyAdapters = {
    detectExam,
    detectDiscriminator,
    computeSelectCount,
    parseQuestionNumber,
    truncate,
    inNav, // exported so outcomes.js can reuse the same nav/sidebar/footer check
    adapters: ADAPTERS, // exposed so you can test one from the console
    /**
     * Runs the first matching adapter, then backfills any field it couldn't
     * resolve from the generic heuristics. A site adapter that only nails one
     * of the three fields is still a win. Never throws.
     */
    extract() {
      const adapter =
        ADAPTERS.find((a) => a.enabled && safe(() => a.match(window.location), false)) ||
        genericAdapter;

      const data = safe(() => adapter.extract(), {}) || {};
      // Some adapters (tutorialsDojoAdapter — see its noGenericBackfill
      // comment) opt out of the generic backfill entirely: on pages where
      // stale hidden siblings are the norm, a document-wide heuristic
      // filling in a field the real adapter left blank is more likely to
      // silently substitute the WRONG question's text than to help.
      const fallback =
        adapter === genericAdapter || adapter.noGenericBackfill
          ? {}
          : safe(() => genericAdapter.extract(), {}) || {};

      const merged = { question: '', yourAnswer: '', correctAnswer: '', yourAnswers: [], correctAnswers: [] };
      const usedFallback = [];
      for (const k of Object.keys(merged)) {
        const isArr = Array.isArray(merged[k]);
        const dataHas = isArr ? Array.isArray(data[k]) && data[k].length : !!data[k];
        const fallbackHas = isArr ? Array.isArray(fallback[k]) && fallback[k].length : !!fallback[k];
        if (dataHas) merged[k] = data[k];
        else if (fallbackHas) {
          merged[k] = fallback[k];
          usedFallback.push(k);
        }
      }

      // Highlighting text on the page is an explicit instruction and beats every
      // adapter — it's the manual override for when detection picks the wrong
      // question, which on a page holding several questions it sometimes will.
      const sel = clean(window.getSelection ? String(window.getSelection()) : '');
      const selected = sel.length > 20;
      if (selected) {
        merged.question = truncate(sel);
        const i = usedFallback.indexOf('question');
        if (i > -1) usedFallback.splice(i, 1);
      }

      // qnum/qtotal capture happens on the PRE-strip merged text (plus, as a
      // fallback, the page's own heading) — same "before the strip" moment
      // STEM_MARKER_RE always ran at, just reading instead of discarding.
      // The stored `question` field below still gets stripped exactly as
      // before; qnum/qtotal never affect what's stripped or hashed.
      const pageHeadingText = safe(
        () => document.title + ' ' + text(document.querySelector('h1,h2')),
        ''
      );
      // qnumText: a sibling snippet the matched adapter hands in via its own
      // out.qnumText (currently only tutorialsDojoAdapter — see its own
      // extract()) when the question number lives OUTSIDE the stem entirely.
      // Read straight off `data` (never `fallback` — the generic adapter
      // never sets it), tolerating adapters that never set it at all
      // (undefined -> ''). Passed to parseQuestionNumber as metadata input
      // only: it's never merged into merged.question above, never folded
      // into `merged` itself, and never appears on the object this function
      // returns below — so it can never reach fingerprint() or land on a
      // stored record. See parseQuestionNumber's own doc comment for the
      // full priority order this participates in.
      const qnumText = data.qnumText || '';
      const { qnum, qtotal } = parseQuestionNumber(merged.question, pageHeadingText, qnumText);

      merged.question = merged.question.replace(STEM_MARKER_RE, '');

      return {
        ...merged,
        qnum,
        qtotal,
        disc: detectDiscriminator(merged.question),
        adapter:
          adapter.name +
          (selected ? ' +selection(question)' : '') +
          (usedFallback.length ? ` +generic(${usedFallback.join(',')})` : ''),
        exam: detectExam(document.title + ' ' + document.body.innerText.slice(0, 4000)),
        // inputType: same "read straight off data, tolerate adapters that
        // never set it" rule as qnumText above (currently only TD — see its
        // out.inputType) — computeSelectCount only consults it as a
        // last-resort floor when the stem has no "select N" wording AND
        // correctAnswers.length <= 1. Also never appears on this returned
        // object — computation input only, not stored on any record.
        selectCount: computeSelectCount(merged.question, merged.correctAnswers, data.inputType || null)
      };
    }
  };

  function safe(fn, fallback) {
    try {
      return fn();
    } catch (e) {
      console.debug('[Cert Buddy] adapter error', e);
      return fallback;
    }
  }
})(globalThis);
