/**
 * Cert Buddy in-page tagger.
 *
 * Renders a launcher badge and a tagging panel inside a shadow root so the
 * study site's CSS can't reach it and ours can't leak out.
 *
 * Open with: the badge, or Alt+M.
 */
(function () {
  if (window.__certBuddyLoaded) return;
  window.__certBuddyLoaded = true;

  // Some exam players render the question inside an iframe, so we run in all
  // frames — but only mount UI in a frame big enough to be the actual player.
  // Keeps ad/tracking iframes from each sprouting their own badge.
  const isSubframe = window.top !== window.self;
  if (isSubframe && (window.innerWidth < 480 || window.innerHeight < 360)) return;

  const Store = globalThis.CertBuddyStore;
  const Tax = globalThis.CertBuddyTaxonomy;
  const Adapters = globalThis.CertBuddyAdapters;

  const CSS = `
    :host {
      all: initial;
      --bg: #fafbf9;
      --raised: #ffffff;
      --line: #e2e7e3;
      --fg: #14171a;
      --muted: #6b7480;
      --accent: #149463;
      --accent-ink: #ffffff;
      --danger: #c73f52;
      --warn: #b07a1e;
      --warn-ink: #ffffff;
      --mono: ui-monospace, "SF Mono", Menlo, monospace;
      --radius: 8px;
    }
    @media (prefers-color-scheme: dark) {
      :host {
        --bg: #0e1210;
        --raised: #161b18;
        --line: #242b27;
        --fg: #e6e9ee;
        --muted: #98a1ad;
        --accent: #3ddc97;
        --accent-ink: #062018;
        --danger: #ff7b8a;
        --warn: #e8c37a;
        --warn-ink: #2b2210;
      }
    }
    * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }

    .launcher {
      position: fixed; right: 16px; bottom: 16px; z-index: 2147483646;
      display: flex; align-items: center; justify-content: center;
      width: 46px; height: 46px; padding: 0; border: 0; border-radius: 50%;
      background: var(--accent);
      box-shadow: 0 6px 16px rgba(0,0,0,.18); cursor: pointer; opacity: .85;
      transition: opacity .15s, box-shadow .15s, transform .12s;
    }
    .launcher:active { transform: scale(.94); }
    .launcher:hover { opacity: 1; box-shadow: 0 8px 20px rgba(0,0,0,.24); }
    .buddy {
      width: 38px; height: 38px; border-radius: 50%; background: #fff;
      object-fit: cover; flex-shrink: 0;
    }
    .buddy-h { width: 18px; height: 18px; vertical-align: -4px; margin-right: 6px; }
    .launcher[hidden] { display: none; }

    .panel {
      position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;
      width: 380px; max-height: min(78vh, 700px); overflow-y: auto;
      background: var(--raised); color: var(--fg);
      border: 1px solid var(--line); border-radius: var(--radius);
      box-shadow: 0 12px 28px rgba(20,23,26,.14), 0 2px 8px rgba(20,23,26,.06);
      padding: 16px; font-size: 13px; line-height: 1.45;
    }
    .panel[hidden] { display: none; }

    header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
    header h1 { margin: 0; font-size: 14px; font-weight: 700; letter-spacing: -0.02em; }
    header h1 .flag { color: var(--accent); margin-right: 4px; }
    header .sub { font-size: 11px; color: var(--muted); font-weight: 400; font-family: var(--mono); }
    .x { border: 0; background: transparent; font-size: 18px; line-height: 1; cursor: pointer;
         color: var(--muted); padding: 4px; border-radius: 8px; }
    .x:hover { background: var(--bg); }

    label.f { display: block; margin: 12px 0 4px; font-size: 11px; font-weight: 700;
              text-transform: uppercase; letter-spacing: .04em; color: var(--muted); font-family: var(--mono); }
    textarea, input[type=text], select {
      width: 100%; padding: 8px 10px; border: 1px solid var(--line); border-radius: var(--radius);
      font-size: 13px; background: var(--bg); color: var(--fg); resize: vertical;
      transition: border-color .12s, box-shadow .12s;
    }
    textarea:focus, input:focus, select:focus {
      outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 22%, transparent);
    }
    textarea.autogrow { resize: none; overflow-y: auto; max-height: 120px; }
    #fact, #exam { font-family: var(--mono); }
    .row { display: flex; gap: 8px; }
    .row > * { flex: 1; min-width: 0; }

    .chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
    .chip {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 4px 10px; border-radius: 999px; font-size: 12px; cursor: pointer;
      border: 1px solid var(--line); background: var(--bg); color: var(--fg);
      transition: background .12s, border-color .12s;
    }
    .chip.on { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
    .chip .rm { font-weight: 700; opacity: .7; }
    .chip.ghost {
      border-style: dashed; background: transparent; color: var(--muted);
    }
    .chip.ghost:hover { border-color: var(--accent); color: var(--fg); }
    .chip.shaky {
      border-style: dashed; background: transparent; color: var(--muted); margin-top: 8px;
    }
    .chip.shaky.on { background: var(--warn); border-color: var(--warn); color: var(--warn-ink); }
    /* Memorized chip: same outline-chip/warn family as shaky — both flag a
       "right" that isn't solid evidence of learning, just for different
       reasons (guessed vs. pure answer-recognition). Mutually exclusive with
       shaky in JS, so only one is ever "on" at a time. */
    .chip.memorized {
      border-style: dashed; background: transparent; color: var(--muted); margin-top: 8px; margin-left: 6px;
    }
    .chip.memorized.on { background: var(--warn); border-color: var(--warn); color: var(--warn-ink); }
    .hint { font-size: 11px; color: var(--muted); margin-top: 6px; }

    .banner {
      margin: 8px 0 0; padding: 8px 10px; border-radius: var(--radius); font-size: 12px;
      background: #fff5e0; border: 1px solid #e8c37a; color: #6b4a05;
    }
    .banner[hidden] { display: none; }
    /* Regression overrides the amber "seen before" tone — a right that's since
       gone stale is worse news than a plain repeat. */
    .banner.danger {
      background: color-mix(in srgb, var(--danger) 16%, var(--raised));
      border-color: color-mix(in srgb, var(--danger) 45%, transparent);
      color: var(--danger);
      font-weight: 600;
    }

    /* --- compact-mode capture summary --- */
    .capture-q {
      margin: 0 0 8px; font-size: 12.5px; color: var(--muted); line-height: 1.5;
    }
    .disc-row { margin-top: 8px; display: flex; align-items: center; }
    .chip.mono {
      font-family: var(--mono); font-size: 10.5px; text-transform: uppercase; letter-spacing: .03em;
      background: var(--bg); border: 1px dashed var(--line); color: var(--muted); cursor: pointer;
      padding: 4px 10px; border-radius: 6px;
    }
    .chip.mono:hover { border-color: var(--accent); color: var(--fg); }
    select.disc-select { width: auto; font-family: var(--mono); font-size: 11px; padding: 5px 8px; }

    .reason-row { display: flex; gap: 6px; margin-top: 4px; }
    .reason-btn {
      flex: 1; padding: 7px 6px; border-radius: var(--radius); border: 1px solid var(--line);
      background: var(--bg); color: var(--fg); font-family: var(--mono); font-size: 11px; font-weight: 600;
      cursor: pointer; text-align: center; transition: border-color .12s, background .12s, color .12s;
    }
    .reason-btn:hover { border-color: var(--accent); }
    .reason-btn.on { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
    .reason-row.flash { outline: 2px solid var(--danger); outline-offset: 3px; border-radius: var(--radius); }

    /* Correct captures (shaky chip on, or a passive outcome already says
       this fp went correct) have nothing to classify — the reason UI hides
       in both layouts and a hint takes the compact row's place. */
    .panel.correct-capture .reason-only { display: none; }
    .correct-hint { font-family: var(--mono); }

    /* Panel starts collapsed to the essentials; Expand reveals the rest. */
    .panel.compact .full-only { display: none; }
    .kbd { font-family: var(--mono); font-weight: 400; opacity: .8; font-size: 11px; margin-left: 3px; }

    .linky {
      border: 0; background: transparent; color: var(--muted); padding: 0;
      font-size: 11px; text-decoration: underline; cursor: pointer; margin-top: 12px;
    }

    .sugg { position: relative; }
    .sugg-list {
      position: absolute; left: 0; right: 0; top: 100%; z-index: 5;
      background: var(--raised); border: 1px solid var(--line); border-radius: var(--radius); margin-top: 4px;
      max-height: 190px; overflow-y: auto; box-shadow: 0 8px 20px rgba(20,23,26,.12);
    }
    .sugg-list[hidden] { display: none; }
    .sugg-list button {
      display: block; width: 100%; text-align: left; border: 0; background: transparent;
      padding: 7px 10px; font-size: 12px; cursor: pointer; color: var(--fg);
    }
    .sugg-list button:hover, .sugg-list button.active {
      background: color-mix(in srgb, var(--accent) 14%, transparent);
    }

    /* Sticky so Save is reachable without scrolling a long question. */
    footer {
      display: flex; gap: 8px; margin-top: 16px;
      position: sticky; bottom: -16px; background: var(--raised);
      padding: 12px 0 0; border-top: 1px solid var(--line);
    }
    .btn { flex: 1; padding: 9px 10px; border-radius: var(--radius); border: 1px solid var(--line);
           background: var(--bg); color: var(--fg); font-size: 13px; font-weight: 600; cursor: pointer;
           transition: border-color .12s, box-shadow .12s; }
    .btn:hover { border-color: var(--accent); }
    .btn.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
    .btn.primary:hover { box-shadow: 0 4px 12px color-mix(in srgb, var(--accent) 32%, transparent); }
    .btn:disabled { opacity: .5; cursor: default; box-shadow: none; }

    /* Keyboard-only rings — mouse clicks on the launcher/chips/x stay quiet. */
    .btn:focus-visible, .chip:focus-visible, .x:focus-visible, .linky:focus-visible, .reason-btn:focus-visible {
      outline: 2px solid var(--accent); outline-offset: 2px;
    }

    .toast {
      position: fixed; right: 16px; bottom: 70px; z-index: 2147483647;
      padding: 8px 14px; border-radius: var(--radius); font-size: 12px; font-weight: 600;
      border: 1px solid transparent;
    }
    .toast[hidden] { display: none; }
    .toast.success {
      background: color-mix(in srgb, var(--accent) 16%, var(--raised));
      color: var(--accent);
      border-color: color-mix(in srgb, var(--accent) 40%, transparent);
    }
    .toast.error {
      background: color-mix(in srgb, var(--danger) 16%, var(--raised));
      color: var(--danger);
      border-color: color-mix(in srgb, var(--danger) 40%, transparent);
    }

    @media (prefers-color-scheme: dark) {
      .banner { background: #2b2210; border-color: #6b5320; color: #f0d79a; }
    }
  `;

  const host = document.createElement('div');
  host.id = 'cert-buddy-root';
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = CSS;
  shadow.appendChild(style);

  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <button class="launcher" id="launcher" title="Log a miss (⌥M / Alt+M)" aria-label="Log a miss"><img class="buddy" src="data:image/png;base64,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" alt=""></button>
    <div class="toast" id="toast" hidden></div>
    <section class="panel compact" id="panel" hidden role="dialog" aria-label="Log a missed question">
      <header>
        <div>
          <h1><img class="buddy buddy-h" src="data:image/png;base64,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" alt="">Log a miss</h1>
          <div class="sub" id="sub"></div>
        </div>
        <button class="x" id="close" title="Close (Esc)">×</button>
      </header>

      <div class="banner" id="dupBanner" hidden></div>

      <p class="capture-q" id="captureQ"></p>
      <div class="chips" id="chips"></div>
      <div class="chips ghost-chips" id="suggestChips"></div>
      <div class="disc-row" id="discRow">
        <button type="button" class="chip mono" id="discChip"></button>
        <select id="discSelect" class="disc-select" hidden></select>
      </div>

      <label class="f reason-only" id="reasonRowLabel">Why you missed it (⌥1–3)</label>
      <div class="reason-row reason-only" id="reasonRow" role="group" aria-labelledby="reasonRowLabel"></div>
      <p class="hint correct-hint" id="correctHint" hidden>answered correctly — no reason needed</p>

      <label class="f" for="notes" id="notesLabel">Why did you get this wrong?</label>
      <textarea id="notes" rows="2" placeholder="one honest sentence…"></textarea>

      <button type="button" class="chip shaky" id="shakyChip">guessed it (got it right)</button>
      <button type="button" class="chip memorized" id="memorizedChip">memorized it (got it right)</button>

      <div class="full-only">
        <label class="f" for="question">Question</label>
        <textarea id="question" rows="4" placeholder="Paste or edit the question stem…"></textarea>

        <div class="row">
          <div>
            <label class="f" for="yourAnswer">You picked</label>
            <textarea class="autogrow" id="yourAnswer" rows="1" placeholder="e.g. B"></textarea>
          </div>
          <div>
            <label class="f" for="correctAnswer">Correct</label>
            <textarea class="autogrow" id="correctAnswer" rows="1" placeholder="e.g. D"></textarea>
          </div>
        </div>

        <label class="f">Topics</label>
        <div class="sugg">
          <input type="text" id="topicSearch" placeholder="Search services / concepts…" autocomplete="off">
          <div class="sugg-list" id="suggList" hidden></div>
        </div>
        <div class="hint" id="autoHint"></div>

        <label class="f reason-only" for="reason">Why you missed it (⌥1–3)</label>
        <select id="reason" class="reason-only"></select>

        <label class="f" for="fact">Fact to memorize</label>
        <textarea class="autogrow" id="fact" rows="1" placeholder="The exact limit/number this hinged on…"></textarea>
      </div>

      <div class="full-only">
        <div class="row" style="margin-top:10px">
          <div>
            <label class="f" for="exam">Exam</label>
            <input type="text" id="exam" placeholder="SAP-C02">
          </div>
        </div>

        <button class="linky" id="hideHere">Hide the badge on this site (Alt+M still works)</button>
      </div>

      <footer>
        <button class="btn primary" id="save">Save <span class="kbd">⌘⏎</span></button>
        <button class="btn" id="expand">Expand</button>
        <button class="btn" id="cancel">Cancel</button>
      </footer>
      <button type="button" class="linky" id="saveWithoutReason">save without reason</button>
    </section>
  `;
  shadow.appendChild(wrap);

  const $ = (id) => shadow.getElementById(id);
  const panel = $('panel');
  const launcher = $('launcher');
  const toast = $('toast');

  let topics = new Set();
  let autoTopics = [];
  let suggestedTopics = []; // score===1, non-concept — shown as ghost chips, not applied
  let shakyOn = false; // "guessed it (got it right)" toggle state
  let memorizedOn = false; // "memorized it (got it right)" toggle state — mutually exclusive with shakyOn
  let outcomeSaysCorrect = false; // passive signal: the outcomes log already has this fp as correct
  let isCorrectCapture = false; // shakyOn || memorizedOn || outcomeSaysCorrect — gates the reason UI
  let lastExam = ''; // remembered across opens so you type the exam code once
  let badgeHidden = false; // this host is on the hidden list
  let suggIndex = -1;
  let suggItems = [];
  let currentDisc = ''; // the discriminator chip's current value, auto or corrected
  let mode = 'compact'; // 'compact' | 'full' — which layout is showing

  const truncate = (s, n) => {
    s = String(s || '');
    return s.length > n ? s.slice(0, n).trimEnd() + '…' : s;
  };

  /** Shared auto-grow sizing for the textareas that replaced single-line
   *  inputs (yourAnswer, correctAnswer, fact). Call on 'input' and once
   *  after setting .value programmatically. */
  function autogrow(el) {
    el.style.height = 'auto';
    el.style.height = el.scrollHeight + 'px';
  }
  for (const id of ['yourAnswer', 'correctAnswer', 'fact']) {
    $(id).addEventListener('input', () => autogrow($(id)));
  }

  // ---- topic chips ----------------------------------------------------
  function renderChips() {
    const c = $('chips');
    c.innerHTML = '';
    if (!topics.size) {
      c.innerHTML = '<span class="hint">No topics yet — pick from the search below.</span>';
    }
    for (const id of topics) {
      const b = document.createElement('button');
      b.className = 'chip on';
      b.innerHTML = `${escapeHtml(Tax.label(id))} <span class="rm">×</span>`;
      b.addEventListener('click', () => {
        topics.delete(id);
        renderChips();
      });
      c.appendChild(b);
    }
  }

  // ---- discriminator chip -----------------------------------------------
  // Shows what the question turned on ("[turns on: OPERATIONAL OVERHEAD]").
  // Click it to swap in a select and correct or clear the guess.
  function renderDiscChip() {
    const chip = $('discChip');
    chip.textContent = `turns on: ${currentDisc ? Tax.discLabel(currentDisc).toUpperCase() : '—'}`;
    chip.hidden = false;
    $('discSelect').hidden = true;
  }

  function openDiscSelect() {
    const sel = $('discSelect');
    sel.innerHTML =
      '<option value="">—</option>' +
      Tax.DISCRIMINATORS.map((d) => `<option value="${d.id}">${escapeHtml(d.label)}</option>`).join('');
    sel.value = currentDisc;
    $('discChip').hidden = true;
    sel.hidden = false;
    sel.focus();
  }

  function commitDiscSelect() {
    currentDisc = $('discSelect').value;
    renderDiscChip();
  }

  // ---- compact / full mode -----------------------------------------------
  function setMode(next) {
    mode = next;
    panel.classList.toggle('compact', mode === 'compact');
    $('expand').hidden = mode !== 'compact';
  }

  function renderSuggestions(query) {
    const list = $('suggList');
    const matches = Tax.search(query).filter((t) => !topics.has(t.id));
    suggItems = matches;
    suggIndex = matches.length ? 0 : -1;
    if (!matches.length) {
      list.hidden = true;
      return;
    }
    list.innerHTML = '';
    matches.forEach((t, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = t.label;
      if (i === 0) b.className = 'active';
      b.addEventListener('click', () => addTopic(t.id));
      list.appendChild(b);
    });
    list.hidden = false;
  }

  function addTopic(id) {
    topics.add(id);
    $('topicSearch').value = '';
    $('suggList').hidden = true;
    renderChips();
    $('topicSearch').focus();
  }

  function highlightSugg() {
    [...$('suggList').children].forEach((el, i) =>
      el.classList.toggle('active', i === suggIndex)
    );
  }

  // ---- open / close ---------------------------------------------------
  function open() {
    setMode('compact');
    const data = Adapters.extract();
    $('question').value = data.question || '';
    $('yourAnswer').value = data.yourAnswer || '';
    $('correctAnswer').value = data.correctAnswer || '';
    $('exam').value = data.exam || lastExam || '';
    currentDisc = data.disc || '';
    renderDiscChip();

    const detected = Tax.detectWeighted({
      question: data.question,
      yourAnswer: data.yourAnswer,
      correctAnswer: data.correctAnswer
    });
    autoTopics = detected.apply;
    suggestedTopics = detected.suggest;
    topics = new Set(autoTopics);
    renderChips();
    renderSuggestChips();
    $('captureQ').textContent = data.question
      ? truncate(data.question, 140)
      : 'No question text detected — hit Expand to paste it in.';
    $('autoHint').textContent = autoTopics.length || suggestedTopics.length
      ? `Auto-tagged ${autoTopics.length} · ${suggestedTopics.length} suggested`
      : 'No topics detected automatically.';
    $('sub').textContent =
      `${location.hostname} · via ${data.adapter} adapter` + versionSuffix();
    $('notes').value = '';
    reasonSel.value = '';
    syncReasonButtons();
    shakyOn = false;
    renderShakyChip();
    memorizedOn = false;
    renderMemorizedChip();
    // Reset the passive signal before its lookup resolves, so a lingering
    // "correct" state from the previous question can't bleed into this one.
    outcomeSaysCorrect = false;
    renderCorrectCapture();
    $('fact').value = '';
    for (const id of ['yourAnswer', 'correctAnswer', 'fact']) autogrow($(id));

    panel.hidden = false;
    launcher.hidden = true;
    panel.scrollTop = 0;
    // Reason is required to save, so start focus there — Tab/⌥1-3 reach it immediately.
    reasonButtons[0].focus();

    showRepeatBanner(data.question);
    checkOutcomeCorrect(data.question);
  }

  /**
   * Passive half of isCorrectCapture: does the outcomes log already have
   * this question's fingerprint logged 'correct' (via the Check-answer
   * banner + confidence toast, no tagger interaction required)? Async like
   * showRepeatBanner — resolves after the panel is already open.
   */
  async function checkOutcomeCorrect(question) {
    const fp = Store.fingerprint(question);
    const outcome = fp ? await Store.getOutcomeByFp(fp) : null;
    outcomeSaysCorrect = !!(outcome && outcome.outcome === 'correct');
    renderCorrectCapture();
  }

  /**
   * Recomputes isCorrectCapture from its two signals and syncs the UI: the
   * reason row/select hide (via .correct-capture on the panel, see CSS),
   * the hint line takes their place, and the "save without reason" escape
   * hatch hides since there's nothing left to escape from requiring.
   */
  function renderCorrectCapture() {
    isCorrectCapture = shakyOn || memorizedOn || outcomeSaysCorrect;
    panel.classList.toggle('correct-capture', isCorrectCapture);
    $('correctHint').hidden = !isCorrectCapture;
    $('saveWithoutReason').hidden = isCorrectCapture;
  }

  /**
   * Tell you up front if this is a question you've already missed — or, if
   * the prior record shows a right that's newer than its last miss, that
   * you're about to regress on something you'd already fixed.
   */
  async function showRepeatBanner(question) {
    const banner = $('dupBanner');
    banner.hidden = true;
    banner.classList.remove('danger');
    const prior = await Store.findRepeat(question);
    if (!prior) return;
    const attempts = prior.attempts || [prior.ts];
    const n = attempts.length;
    const last = attempts[attempts.length - 1];
    const rights = prior.rights || [];
    const lastRight = rights.length ? rights[rights.length - 1] : 0;

    if (lastRight > last) {
      banner.classList.add('danger');
      banner.textContent = `REGRESSION — you had this one right on ${new Date(lastRight).toLocaleDateString()}.`;
    } else {
      banner.textContent =
        `You've missed this one ${n}× before (last ${relTime(last)}). ` +
        `Saving logs attempt ${n + 1} on the same record instead of a duplicate.`;
      if (prior.notes) {
        banner.textContent += ` Your note: “${prior.notes}”`;
      }
    }
    banner.hidden = false;
  }

  // chrome.runtime.getManifest() isn't implemented by every test harness mock,
  // so a missing version just means the suffix is silently omitted.
  function versionSuffix() {
    try {
      return ` · v${chrome.runtime.getManifest().version}`;
    } catch (e) {
      return '';
    }
  }

  function relTime(ts) {
    const days = Math.floor((Date.now() - ts) / 86400000);
    if (days <= 0) return 'today';
    if (days === 1) return 'yesterday';
    if (days < 30) return `${days}d ago`;
    return new Date(ts).toLocaleDateString();
  }

  function close() {
    panel.hidden = true;
    launcher.hidden = badgeHidden;
    $('suggList').hidden = true;
  }

  async function save({ requireReason = true } = {}) {
    const question = $('question').value.trim();
    const yourAnswer = $('yourAnswer').value.trim();
    if (!question && !yourAnswer && !topics.size) {
      showToast('Nothing to save — add a question or a topic.', true);
      return;
    }
    // A correct capture has nothing to classify — reason is forced empty
    // and never required, regardless of what's left over in the select from
    // before the panel recognized this as a correct capture.
    const reason = isCorrectCapture ? '' : reasonSel.value;
    if (requireReason && !isCorrectCapture && !reason) {
      flashReasonRow();
      return;
    }
    $('save').disabled = true;
    lastExam = $('exam').value.trim();
    try {
      const payload = {
        host: location.hostname,
        url: location.href.slice(0, 500),
        exam: lastExam,
        question: Adapters.truncate(question),
        yourAnswer,
        correctAnswer: $('correctAnswer').value.trim(),
        topics: [...topics],
        reason,
        notes: $('notes').value.trim(),
        fact: $('fact').value.trim(),
        disc: currentDisc,
        shaky: shakyOn,
        // Picking a reason is what "triaging" a capture means here — except
        // a correct capture, which is triaged by definition (nothing to
        // classify). The escape hatch can still land here with no reason on
        // an incorrect capture -> stays untriaged.
        triaged: isCorrectCapture || !!reason
      };
      // The shaky/memorized chips ARE explicit confidence declarations — say
      // so directly. Mutually exclusive in the UI, so at most one of these
      // fires. Any other capture leaves confidence absent so addMiss's own
      // join can pull it from the matching outcome record instead.
      if (shakyOn) payload.confidence = 'guessed';
      else if (memorizedOn) payload.confidence = 'memorized';
      const { repeat, attempt } = await Store.addMiss(payload);
      close();
      showToast(repeat ? `Attempt ${attempt} logged on a repeat ✓` : 'Miss logged ✓');
    } catch (e) {
      console.error('[Cert Buddy] save failed', e);
      showToast('Save failed — see console.', true);
    } finally {
      $('save').disabled = false;
    }
  }

  let toastTimer;
  function showToast(msg, isError) {
    toast.textContent = msg;
    toast.className = 'toast ' + (isError ? 'error' : 'success');
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toast.hidden = true), 2400);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
    );
  }

  // ---- wiring ---------------------------------------------------------
  const reasonSel = $('reason');
  reasonSel.innerHTML =
    '<option value="">—</option>' +
    Tax.REASONS.map((r) => `<option value="${r.id}">${escapeHtml(r.label)}</option>`).join('');

  const reasonRow = $('reasonRow');
  const reasonButtons = Tax.REASONS.map((r) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'reason-btn';
    b.textContent = r.label;
    b.dataset.reasonId = r.id;
    b.addEventListener('click', () => pickReason(r.id));
    reasonRow.appendChild(b);
    return b;
  });

  function syncReasonButtons() {
    const val = reasonSel.value;
    for (const b of reasonButtons) b.classList.toggle('on', b.dataset.reasonId === val);
  }

  /** Selecting a reason — by click or hotkey — sets the shared value and
   *  moves focus into the sentence field, since that's what you fill in next. */
  function pickReason(id) {
    reasonSel.value = id;
    syncReasonButtons();
    $('notes').focus();
  }

  reasonSel.addEventListener('change', syncReasonButtons);

  function flashReasonRow() {
    reasonRow.classList.add('flash');
    setTimeout(() => reasonRow.classList.remove('flash'), 500);
  }

  function renderShakyChip() {
    $('shakyChip').classList.toggle('on', shakyOn);
    $('shakyChip').setAttribute('aria-pressed', String(shakyOn));
  }
  function renderMemorizedChip() {
    $('memorizedChip').classList.toggle('on', memorizedOn);
    $('memorizedChip').setAttribute('aria-pressed', String(memorizedOn));
  }
  // Mutually exclusive: turning one on turns the other off, both directions.
  $('shakyChip').addEventListener('click', () => {
    shakyOn = !shakyOn;
    if (shakyOn && memorizedOn) {
      memorizedOn = false;
      renderMemorizedChip();
    }
    renderShakyChip();
    renderCorrectCapture();
  });
  $('memorizedChip').addEventListener('click', () => {
    memorizedOn = !memorizedOn;
    if (memorizedOn && shakyOn) {
      shakyOn = false;
      renderShakyChip();
    }
    renderMemorizedChip();
    renderCorrectCapture();
  });

  function renderSuggestChips() {
    const c = $('suggestChips');
    c.innerHTML = '';
    for (const id of suggestedTopics) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip ghost';
      b.textContent = `+ ${Tax.label(id)}`;
      b.title = 'Tap to apply this suggested topic';
      b.addEventListener('click', () => {
        topics.add(id);
        suggestedTopics = suggestedTopics.filter((x) => x !== id);
        renderChips();
        renderSuggestChips();
      });
      c.appendChild(b);
    }
  }

  launcher.addEventListener('click', open);
  $('close').addEventListener('click', close);
  $('cancel').addEventListener('click', close);
  $('save').addEventListener('click', () => save());
  $('saveWithoutReason').addEventListener('click', () => save({ requireReason: false }));

  $('expand').addEventListener('click', () => {
    setMode('full');
    const q = $('question');
    q.focus();
    q.setSelectionRange(0, 0);
    q.scrollTop = 0;
  });

  $('discChip').addEventListener('click', openDiscSelect);
  $('discSelect').addEventListener('change', commitDiscSelect);
  $('discSelect').addEventListener('blur', () => {
    if (!$('discSelect').hidden) commitDiscSelect();
  });

  $('hideHere').addEventListener('click', async () => {
    const s = await Store.getSettings();
    const hosts = new Set(s.hiddenHosts || []);
    hosts.add(location.hostname);
    await Store.setSettings({ hiddenHosts: [...hosts] });
    badgeHidden = true;
    panel.hidden = true;
    launcher.hidden = true;
    showToast('Badge hidden here — Alt+M still opens this.');
  });

  const search = $('topicSearch');
  search.addEventListener('input', () => renderSuggestions(search.value));
  search.addEventListener('focus', () => renderSuggestions(search.value));

  // Close the suggestion list on any click/tap that isn't the search box or the
  // list itself. pointerdown is composed, so this hears clicks both inside the
  // shadow root and out on the page.
  window.addEventListener(
    'pointerdown',
    (e) => {
      const path = e.composedPath();
      if (!path.includes(search) && !path.includes($('suggList'))) {
        $('suggList').hidden = true;
      }
    },
    true
  );
  search.addEventListener('keydown', (e) => {
    const list = $('suggList');
    if (list.hidden) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      suggIndex = Math.max(0, Math.min(suggItems.length - 1, suggIndex + (e.key === 'ArrowDown' ? 1 : -1)));
      highlightSugg();
    } else if (e.key === 'Enter' && suggIndex >= 0) {
      e.preventDefault();
      addTopic(suggItems[suggIndex].id);
    }
  });

  // Keep the study site's own keyboard shortcuts from firing while we type.
  shadow.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      close();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      save();
      e.stopPropagation();
      return;
    }
    // Alt+1..Alt+3 picks the Nth reason, from any field in the panel. e.code
    // is the physical key, same reasoning as the Alt+M guard below — Option
    // turns the top-row digits into symbols on macOS, e.code doesn't care.
    if (e.altKey && !e.ctrlKey && !e.metaKey) {
      const m = /^Digit([1-3])$/.exec(e.code);
      const reason = m && Tax.REASONS[Number(m[1]) - 1];
      if (reason) {
        e.preventDefault();
        // Row's hidden on a correct capture — nothing to pick.
        if (!isCorrectCapture) pickReason(reason.id);
        e.stopPropagation();
        return;
      }
    }
    e.stopPropagation();
  });

  window.addEventListener(
    'keydown',
    (e) => {
      // e.code is the physical key, so this survives macOS turning Option+M
      // into "µ" and any non-US keyboard layout. e.key is the fallback.
      const isM = e.code === 'KeyM' || e.key === 'm' || e.key === 'M' || e.key === 'µ';
      if (e.altKey && !e.ctrlKey && !e.metaKey && isM) {
        e.preventDefault();
        panel.hidden ? open() : close();
      }
    },
    true
  );

  // Respect per-site "hide the badge" without disabling the hotkey.
  Store.getSettings().then((s) => {
    if ((s.hiddenHosts || []).includes(location.hostname)) {
      badgeHidden = true;
      launcher.hidden = true;
    }
  });

  /**
   * When the question lives in an embedded player, both the shell and the
   * iframe mount — and two badges is confusing. The frame holding the question
   * wins, so a top frame that contains a player-sized iframe drops its badge.
   * The panel still mounts there; Alt+M reaches it.
   */
  function dropBadgeIfPlayerIframe() {
    if (isSubframe || badgeHidden) return;
    const hasPlayer = [...document.querySelectorAll('iframe')].some(
      (f) => f.clientWidth >= 480 && f.clientHeight >= 360
    );
    if (hasPlayer) launcher.hidden = true;
  }
  dropBadgeIfPlayerIframe();
  setTimeout(dropBadgeIfPlayerIframe, 1500); // players often mount late

  // Mount into the fullscreen element if the page is already fullscreened at
  // inject time (on-demand injection mid-exam) — outside it we'd be invisible.
  (document.fullscreenElement || document.documentElement).appendChild(host);

  // Element-fullscreen (Udemy's expand control) renders ONLY the fullscreened
  // subtree — UI mounted outside it silently disappears. Ride along by
  // re-parenting into the fullscreen element, and move back out on exit.
  document.addEventListener('fullscreenchange', () => {
    const fs = document.fullscreenElement;
    if (fs && !fs.contains(host)) fs.appendChild(host);
    else if (!fs && host.parentElement !== document.documentElement) {
      document.documentElement.appendChild(host);
    }
  });
})();
