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
      display: flex; align-items: center; gap: 6px;
      padding: 8px 16px; border: 0; border-radius: 999px;
      background: var(--accent); color: var(--accent-ink); font-size: 13px; font-weight: 600;
      box-shadow: 0 6px 16px rgba(0,0,0,.18); cursor: pointer; opacity: .85;
      transition: opacity .15s, box-shadow .15s;
    }
    .launcher:hover { opacity: 1; box-shadow: 0 8px 20px rgba(0,0,0,.24); }
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
    <button class="launcher" id="launcher" title="Log a missed question (⌥M / Alt+M)">⚑ Log miss</button>
    <div class="toast" id="toast" hidden></div>
    <section class="panel compact" id="panel" hidden role="dialog" aria-label="Log a missed question">
      <header>
        <div>
          <h1><span class="flag" aria-hidden="true">⚑</span>Log a miss</h1>
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
  let outcomeSaysCorrect = false; // passive signal: the outcomes log already has this fp as correct
  let isCorrectCapture = false; // shakyOn || outcomeSaysCorrect — gates the reason UI
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
    isCorrectCapture = shakyOn || outcomeSaysCorrect;
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
      // The shaky chip IS a guessed declaration — say so explicitly. Any
      // other capture leaves confidence absent so addMiss's own join can
      // pull it from the matching outcome record instead.
      if (shakyOn) payload.confidence = 'guessed';
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
  $('shakyChip').addEventListener('click', () => {
    shakyOn = !shakyOn;
    renderShakyChip();
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
