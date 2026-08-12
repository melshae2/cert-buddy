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
    '[class*="footer"],[data-purpose*="footer"],nav,aside,footer,header';

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
      const out = { question: '', yourAnswer: '', correctAnswer: '' };

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
      out.yourAnswer = uniq(yours).join(' | ');
      out.correctAnswer = uniq(right).join(' | ');

      // No prompt hook exists on this page, so read the blocks above the
      // options — same idea as the generic stem, anchored on the option list
      // and with the sidebar excluded.
      out.question = truncate(stemAbove(rows[0]));

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
      const result = { question: '', yourAnswer: '', correctAnswer: '' };

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
      } else {
        const m = document.body.innerText.match(
          /correct answer(?:\s*is)?\s*[:\-–]\s*([^\n]{2,300})/i
        );
        if (m) result.correctAnswer = clean(m[1]);
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

  const ADAPTERS = [udemyAdapter, templateAdapter, genericAdapter];

  root.CertBuddyAdapters = {
    detectExam,
    detectDiscriminator,
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
      const fallback =
        adapter === genericAdapter ? {} : safe(() => genericAdapter.extract(), {}) || {};

      const merged = { question: '', yourAnswer: '', correctAnswer: '' };
      const usedFallback = [];
      for (const k of Object.keys(merged)) {
        if (data[k]) merged[k] = data[k];
        else if (fallback[k]) {
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

      merged.question = merged.question.replace(STEM_MARKER_RE, '');

      return {
        ...merged,
        disc: detectDiscriminator(merged.question),
        adapter:
          adapter.name +
          (selected ? ' +selection(question)' : '') +
          (usedFallback.length ? ` +generic(${usedFallback.join(',')})` : ''),
        exam: detectExam(document.title + ' ' + document.body.innerText.slice(0, 4000))
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
