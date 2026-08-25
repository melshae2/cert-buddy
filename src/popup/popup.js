/**
 * Cert Buddy dashboard. Runs both as the toolbar popup and, via ?view=full,
 * as a normal tab.
 */
(function () {
  const Store = globalThis.CertBuddyStore;
  const Tax = globalThis.CertBuddyTaxonomy;
  const $ = (id) => document.getElementById(id);

  const isFull = new URLSearchParams(location.search).get('view') === 'full';
  if (isFull) {
    document.body.classList.add('expanded');
    $('expand').hidden = true;
  }

  let misses = [];
  let outcomes = [];
  // fps whose outcome record is confidence:'memorized' — a pure
  // answer-recognition right that must not fake progress. Recomputed once
  // per load() and reused by every render function that needs the honesty
  // rules (focusTopics decay skip, stubborn graduation block) instead of
  // each one re-deriving it from `outcomes`.
  let memorizedFps = new Set();
  let topicFilter = null;

  // Undo-delete: the most recently deleted record, kept only in memory. If
  // the popup closes before Undo is clicked, this is simply lost and the
  // delete (already written to storage) stands.
  let undoRecord = null;
  let undoTimer = null;

  let activeTabId = null; // set by checkActiveTab(), used by the inject button

  const fmtDate = (ts) => {
    const d = new Date(ts);
    const days = Math.floor((Date.now() - ts) / 86400000);
    if (days === 0) return 'today';
    if (days === 1) return 'yesterday';
    if (days < 7) return `${days}d ago`;
    return d.toLocaleDateString();
  };

  const esc = (s) =>
    String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
    );

  /**
   * URL scheme allowlist for anything rendered as an href. `m.url` is
   * page-supplied (captured from `location.href` at tag time, or imported
   * from someone else's export JSON) — HTML-escaping it is not enough on its
   * own, since `javascript:`/`data:` survive escaping unchanged and still
   * execute on click. Only http:/https: parse through; everything else,
   * including anything `new URL` can't parse at all, returns '' so the
   * caller omits the anchor entirely instead of rendering a dead/dangerous
   * href="".
   */
  const safeUrl = (u) => {
    try {
      const parsed = new URL(String(u || ''));
      return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? u : '';
    } catch (e) {
      return '';
    }
  };

  const truncate = (s, n) => {
    s = String(s || '');
    return s.length > n ? s.slice(0, n).trimEnd() + '…' : s;
  };

  /** "#7" or "#7/75" (when qtotal's known) — '' when qnum wasn't captured. */
  const qnumPillHtml = (m) =>
    m.qnum === null || m.qnum === undefined
      ? ''
      : `<span class="qnum-pill">#${esc(m.qnum)}${m.qtotal ? `/${esc(m.qtotal)}` : ''}</span>`;

  /** Shared auto-grow sizing for textareas that replace what used to be
   *  single-line inputs. Call on 'input' and once after setting .value
   *  programmatically. */
  function autogrow(el) {
    el.style.height = 'auto';
    el.style.height = el.scrollHeight + 'px';
  }

  async function load() {
    const db = await Store.getAll();
    misses = db.misses;
    outcomes = db.outcomes || [];
    memorizedFps = new Set(
      outcomes.filter((o) => o && o.fp && o.confidence === 'memorized').map((o) => o.fp)
    );

    // First-run empty state: nothing to rank or search yet, so swap the
    // whole dashboard for a short "how to log your first miss" hero.
    const empty = misses.length === 0;
    $('hero').hidden = !empty;
    $('stats').hidden = empty;
    $('tabsNav').hidden = empty;
    $('mainPanes').hidden = empty;
    if (empty) {
      $('focusCard').hidden = true;
      $('debriefCard').hidden = true;
    }

    renderStats();
    renderDebriefCard();
    renderFocusCard();
    renderWeak();
    renderReasons();
    renderDiscList();
    renderRecent();
    renderInsights();

    // Corruption insurance doesn't affect what's on screen, so it can run
    // after the render without the UI waiting on it.
    await Store.snapshotIfDue();
  }

  /** Shared by the manual Export button and the auto-backup below. */
  async function exportNow() {
    const json = await Store.exportJson();
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `cert-buddy-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    return json;
  }

  /** Undo toast for card delete. ~8s to click Undo before the delete stands for good. */
  function showUndoToast(record) {
    undoRecord = record;
    clearTimeout(undoTimer);
    $('toastMsg').textContent = 'Miss deleted —';
    $('toast').hidden = false;
    undoTimer = setTimeout(() => {
      $('toast').hidden = true;
      undoRecord = null;
    }, 8000);
  }

  const attemptsOf = (m) => m.attempts || [m.ts];
  const rightsOf = (m) => m.rights || [];

  /** Missed 3+ times with no right since the last miss — change how you
   *  study these, not how often. Graduates the moment a right postdates
   *  the latest attempt — UNLESS the fp is flagged memorized, in which case
   *  no right graduates it: a memorized "right" is answer-recognition, not
   *  proof the question is fixed, so it stays stubborn until a real miss or
   *  a manual edit resets it (see the confidence typedef note in store.js). */
  function isStubborn(m, memorized = memorizedFps) {
    const attempts = attemptsOf(m);
    if (attempts.length < 3) return false;
    if (memorized.has(m.fp)) return true;
    const latestAttempt = Math.max(...attempts);
    const rights = rightsOf(m);
    const latestRight = rights.length ? Math.max(...rights) : 0;
    return latestAttempt > latestRight;
  }

  /**
   * If a discriminator has racked up 3+ misses in the last 14 days, that's
   * worth a callout at the top of the focus card. Picks the worst offender
   * when more than one qualifies.
   */
  function discCallout() {
    const WINDOW_MS = 14 * 86400000;
    const now = Date.now();
    const counts = new Map();
    for (const m of misses) {
      if (!m.disc) continue;
      const latest = Math.max(...attemptsOf(m));
      if (now - latest > WINDOW_MS) continue;
      counts.set(m.disc, (counts.get(m.disc) || 0) + 1);
    }
    let best = null;
    for (const [disc, n] of counts) {
      if (n >= 3 && (!best || n > best.n)) best = { disc, n };
    }
    return best;
  }

  function renderStats() {
    const weekAgo = Date.now() - 7 * 86400000;
    const topics = new Set(misses.flatMap((m) => m.topics || []));
    const totalAttempts = misses.reduce((n, m) => n + attemptsOf(m).length, 0);
    const repeats = misses.filter((m) => attemptsOf(m).length > 1).length;

    $('statTotal').textContent = misses.length;
    $('stat7').textContent = misses.reduce(
      (n, m) => n + attemptsOf(m).filter((t) => t >= weekAgo).length,
      0
    );
    $('statTopics').textContent = topics.size;

    const exams = [...new Set(misses.map((m) => m.exam).filter(Boolean))];
    $('subline').textContent = misses.length
      ? `${exams.join(', ') || 'Untagged exam'} · ${totalAttempts} total misses` +
        (repeats ? ` · ${repeats} repeat${repeats > 1 ? 's' : ''}` : '') +
        ` · last ${fmtDate(misses[0].ts)}`
      : 'No misses logged yet — hit Alt+M on a practice question.';

    renderExportNudge(totalAttempts);
  }

  /**
   * Local storage dies with the browser profile. Nag proportionally — but
   * never download anything on our own: an unrequested Save dialog reads as
   * the extension acting on you. One click, your click.
   */
  async function renderExportNudge(totalAttempts) {
    const el = $('nudge');
    const s = await Store.getSettings();
    const days = s.lastExportAt ? Math.floor((Date.now() - s.lastExportAt) / 86400000) : null;
    const stale = days === null ? misses.length >= 10 : days >= 14 && misses.length > 0;
    if (!stale) {
      el.hidden = true;
      return;
    }
    const msg =
      days === null
        ? `${totalAttempts} misses logged and never exported.`
        : `Last export was ${days} days ago.`;
    el.innerHTML = `${esc(msg)} <button class="link" id="nudgeExport">Export now</button>`;
    el.querySelector('#nudgeExport').addEventListener('click', async () => {
      await exportNow();
      await load();
    });
    el.hidden = false;
  }

  const WEAK_VISIBLE = 6;

  function renderWeak() {
    const el = $('weakList');
    const ranked = Store.weakAreas(misses);

    if (!ranked.length) {
      el.innerHTML = `<div class="empty">Log a few misses and your weak areas rank themselves here.</div>`;
      return;
    }
    const max = ranked[0].weight;
    el.innerHTML = '';
    el.classList.remove('expanded');
    ranked.forEach(({ topic, weight, questions }, i) => {
      const meta = Tax.get(topic);
      const catId = meta?.category || 'concept';
      const repeats = weight > questions;
      const btn = document.createElement('button');
      btn.className = 'bar' + (i >= WEAK_VISIBLE ? ' bar-overflow' : '');
      btn.innerHTML = `
        <div class="fill" style="width:${Math.round((weight / max) * 100)}%"></div>
        <div class="row">
          <span class="name"><span class="dot" style="background:var(--cat-${catId})"></span>${esc(Tax.label(topic))}</span>
          <span class="count">${weight}</span>
        </div>
        <div class="cat">${esc(Tax.CATEGORY_LABELS[catId] || '')}${
          repeats ? ` · ${questions} question${questions > 1 ? 's' : ''}, ${weight} misses` : ''
        }</div>`;
      btn.addEventListener('click', () => {
        topicFilter = topic;
        switchTab('recent');
        renderRecent();
      });
      el.appendChild(btn);
    });

    if (ranked.length > WEAK_VISIBLE) {
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'show-more';
      const moreLabel = `show all ${ranked.length} topics`;
      more.textContent = moreLabel;
      more.addEventListener('click', () => {
        const expanded = el.classList.toggle('expanded');
        more.textContent = expanded ? 'show less' : moreLabel;
      });
      el.appendChild(more);
    }
  }

  function renderReasons() {
    const el = $('reasonList');
    const counts = new Map();
    for (const m of misses) {
      if (m.reason) counts.set(m.reason, (counts.get(m.reason) || 0) + 1);
    }
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    $('reasonCount').textContent = ranked.length ? ` · ${ranked.length}` : '';
    if (!ranked.length) {
      el.innerHTML = `<div class="empty">Pick a "why you missed it" reason when logging to see this.</div>`;
      return;
    }
    const max = ranked[0][1];
    el.innerHTML = ranked
      .map(
        ([id, count]) => `
      <div class="bar" style="cursor:default">
        <div class="fill" style="width:${Math.round((count / max) * 100)}%"></div>
        <div class="row">
          <span class="name">${esc(Tax.reasonLabel(id))}</span>
          <span class="count">${count}</span>
        </div>
      </div>`
      )
      .join('');
  }

  /** Ranked counts of which stem discriminator each miss turned on. */
  function renderDiscList() {
    const el = $('discList');
    const counts = new Map();
    for (const m of misses) {
      if (m.disc) counts.set(m.disc, (counts.get(m.disc) || 0) + 1);
    }
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    $('discCount').textContent = ranked.length ? ` · ${ranked.length}` : '';
    if (!ranked.length) {
      el.innerHTML = `<div class="empty">Nothing detected yet — the tagger flags this from the question wording.</div>`;
      return;
    }
    const max = ranked[0][1];
    el.innerHTML = ranked
      .map(
        ([id, count]) => `
      <div class="bar" style="cursor:default">
        <div class="fill" style="width:${Math.round((count / max) * 100)}%"></div>
        <div class="row">
          <span class="name">${esc(Tax.discLabel(id))}</span>
          <span class="count">${count}</span>
        </div>
      </div>`
      )
      .join('');
  }

  // ---- Insights (full-tab dashboard only) ------------------------------
  // Three cards computed from `misses` + `outcomes`. Every one of them
  // renders nothing (not even its own DOM nodes) unless isFull — the
  // container element that hosts them (#insights) stays empty and hidden
  // in the 400px popup, so those elements simply don't exist there.

  const MIN_INSIGHT_N = 5;
  // 'narrowed' (formerly 'unsure') — the toast's second button, picked when
  // you've cut the options down but aren't certain. Old outcome/miss records
  // still on disk with the literal 'unsure' are migrated to 'narrowed' on
  // every read (see store.js's normalizeMiss/normalizeOutcome), so nothing
  // downstream of Store.getAll() ever sees the old value.
  // 'intuition' (correct-only) and 'didnt-know'/'slip' (wrong-only) are the
  // newest picks — see the toast's CORRECT_DIALECT/WRONG_DIALECT in
  // outcomes.js. All pass through Store.getAll() with no migration (they
  // were never spelled anything else), so they need no special handling
  // here beyond being listed like every other level. 'slip' ("silly
  // mistake" — knew it, execution/attention failed) follows 'didnt-know's
  // own pattern exactly: wrong-only, same expected/labeling treatment.
  const CONFIDENCE_ORDER = ['knew', 'narrowed', 'guessed', 'memorized', 'intuition', 'didnt-know', 'slip'];
  const CONFIDENCE_LABELS = {
    knew: 'Knew it',
    narrowed: 'Between two',
    guessed: 'Guessed',
    memorized: 'Memorized',
    intuition: 'Intuition',
    'didnt-know': "Didn't know",
    slip: 'Silly mistake'
  };
  // Anchor accuracy each confidence level SHOULD land near — used only to
  // pick which level's actual accuracy is furthest off for the one-line
  // takeaway, never drawn on the chart itself. knew/memorized are near-
  // certain claims, so ~95%+ is the bar the spec itself names; narrowed is
  // partial knowledge; guessed is close to chance on 4-option MC. intuition
  // is a genuine-competence claim like knew/memorized, just recognition-
  // primed rather than reasoned, so it gets its own (slightly lower) bar
  // rather than sharing knew/memorized's 95. didnt-know and slip are both
  // wrong-only by construction (see outcomes.js) — their actual accuracy
  // will always read 0%, same band as guessed's near-chance expectation.
  const CONFIDENCE_EXPECTED = {
    knew: 95,
    memorized: 95,
    narrowed: 60,
    guessed: 30,
    intuition: 85,
    'didnt-know': 25,
    slip: 25
  };

  const insightEmptyHtml = () => `<div class="empty">not enough data yet — keep logging</div>`;
  const insightCardShell = (title, bodyHtml) =>
    `<section class="insight-card"><div class="minihead"><span class="label">${esc(title)}</span></div>${bodyHtml}</section>`;

  /**
   * Card 1 — for each confidence level with outcomes on file, % of those
   * outcomes that were actually correct, plus n. The point: "knew it"
   * should be ~95%+ correct; a lower number means self-assessment (not
   * knowledge) is the thing that's broken.
   */
  function renderCalibrationCard() {
    const withConfidence = outcomes.filter((o) => o && CONFIDENCE_ORDER.includes(o.confidence));
    if (withConfidence.length < MIN_INSIGHT_N) {
      return insightCardShell('Confidence calibration', insightEmptyHtml());
    }

    const rows = CONFIDENCE_ORDER.map((level) => {
      const items = withConfidence.filter((o) => o.confidence === level);
      if (!items.length) return null;
      const correct = items.filter((o) => o.outcome === 'correct').length;
      return { level, n: items.length, correct, pct: Math.round((correct / items.length) * 100) };
    }).filter(Boolean);

    let worst = rows[0];
    for (const r of rows) {
      const gap = Math.abs(r.pct - CONFIDENCE_EXPECTED[r.level]);
      const worstGap = Math.abs(worst.pct - CONFIDENCE_EXPECTED[worst.level]);
      if (gap > worstGap) worst = r;
    }
    const takeaway = `Biggest gap: "${CONFIDENCE_LABELS[worst.level]}" — expected ~${CONFIDENCE_EXPECTED[worst.level]}%+ correct, actual ${worst.pct}% (n=${worst.n}).`;

    const bars = rows
      .map(
        (r) => `
      <div class="calib-row">
        <span class="calib-label">${esc(CONFIDENCE_LABELS[r.level])}</span>
        <div class="calib-bar"><div class="calib-fill" style="width:${r.pct}%"></div></div>
        <span class="calib-pct">${r.pct}%</span>
        <span class="calib-n">n=${r.n}</span>
      </div>`
      )
      .join('');

    return insightCardShell(
      'Confidence calibration',
      `<div class="calib-chart">${bars}</div><p class="insight-takeaway">${esc(takeaway)}</p>`
    );
  }

  /**
   * Card 2 — per-topic correct/incorrect split across outcomes. Topic comes
   * from the MISS record sharing the outcome's fp (the same question,
   * logged and tagged at some point) when one exists; otherwise falls back
   * to weighted keyword detection on the outcome's own question snippet.
   * Top 12 topics by outcome count. A topic whose correct outcomes are
   * mostly 'memorized' confidence gets an extra "hollow" tag — those are
   * answer-recognition rights, not evidence the material's actually known.
   */
  function renderTopicAccuracyCard() {
    if (outcomes.length < MIN_INSIGHT_N) {
      return insightCardShell('Accuracy by topic', insightEmptyHtml());
    }

    const missByFp = new Map();
    for (const m of misses) if (m.fp) missByFp.set(m.fp, m);

    const tally = new Map(); // topic -> { correct, incorrect, memorizedCorrect }
    for (const o of outcomes) {
      if (!o) continue;
      const linked = o.fp ? missByFp.get(o.fp) : null;
      const topics =
        linked && linked.topics && linked.topics.length
          ? linked.topics
          : Tax.detectWeighted({ question: o.questionSnippet }).apply;
      if (!topics || !topics.length) continue;
      const isCorrect = o.outcome === 'correct';
      for (const t of topics) {
        const prev = tally.get(t) || { correct: 0, incorrect: 0, memorizedCorrect: 0 };
        if (isCorrect) {
          prev.correct++;
          if (o.confidence === 'memorized') prev.memorizedCorrect++;
        } else {
          prev.incorrect++;
        }
        tally.set(t, prev);
      }
    }

    const ranked = [...tally.entries()]
      .map(([topic, v]) => ({ topic, ...v, total: v.correct + v.incorrect }))
      .sort((a, b) => b.total - a.total || a.topic.localeCompare(b.topic))
      .slice(0, 12);

    if (!ranked.length) {
      return insightCardShell('Accuracy by topic', insightEmptyHtml());
    }

    const max = Math.max(...ranked.map((r) => r.total));
    const rows = ranked
      .map((r) => {
        const catId = Tax.get(r.topic)?.category || 'concept';
        const hollow = r.correct > 0 && r.memorizedCorrect / r.correct >= 0.4;
        const correctPct = (r.correct / max) * 100;
        const incorrectPct = (r.incorrect / max) * 100;
        return `
      <div class="topic-row">
        <span class="topic-name">
          <span class="dot" style="background:var(--cat-${catId})"></span>${esc(Tax.label(r.topic))}${
          hollow ? ' <span class="hollow-tag">hollow</span>' : ''
        }
        </span>
        <div class="topic-bar">
          <div class="topic-correct" style="width:${correctPct}%"></div>
          <div class="topic-incorrect" style="width:${incorrectPct}%"></div>
        </div>
        <span class="topic-n">n=${r.total}</span>
      </div>`;
      })
      .join('');

    return insightCardShell('Accuracy by topic', `<div class="topic-chart">${rows}</div>`);
  }

  const fmtMonthDay = (ts) => {
    const d = new Date(ts);
    return String(d.getMonth() + 1).padStart(2, '0') + '/' + String(d.getDate()).padStart(2, '0');
  };

  /**
   * Card 3 — last 10 study sessions (Store.sessionize), oldest to newest, one
   * column per session sized by miss count. Shaky "rights" are already
   * counted as misses inside `misses`/sessionize, nothing extra to do here.
   */
  function renderSessionsCard() {
    const sessions = Store.sessionize(misses);
    if (sessions.length < MIN_INSIGHT_N) {
      return insightCardShell('Sessions timeline', insightEmptyHtml());
    }

    const shown = sessions.slice(0, 10).slice().reverse(); // most recent 10, oldest -> newest
    const max = Math.max(...shown.map((s) => s.misses.length), 1);
    const cols = shown
      .map((s) => {
        const n = s.misses.length;
        const h = Math.max(Math.round((n / max) * 100), 6);
        return `
      <div class="session-col">
        <div class="session-track">
          <span class="session-n">${n}</span>
          <div class="session-bar" style="height:${h}%"></div>
        </div>
        <span class="session-date">${esc(fmtMonthDay(s.end))}</span>
      </div>`;
      })
      .join('');

    return insightCardShell('Sessions timeline', `<div class="sessions-chart">${cols}</div>`);
  }

  function renderInsights() {
    const el = $('insights');
    if (!isFull) {
      el.hidden = true;
      el.innerHTML = '';
      return;
    }
    el.innerHTML = renderCalibrationCard() + renderTopicAccuracyCard() + renderSessionsCard();
    el.hidden = false;
  }

  /**
   * Debrief card: the newest study session (Store.sessionize), clustered by
   * topic, shown only while it still has untriaged misses in it. Capture and
   * learning are separate moments — this is where the learning moment
   * happens, once, after the session instead of question-by-question.
   */
  function renderDebriefCard() {
    const el = $('debriefCard');
    const sessions = Store.sessionize(misses);
    const newest = sessions[0];
    if (!newest) {
      el.hidden = true;
      el.innerHTML = '';
      return;
    }
    const untriaged = newest.misses.filter((m) => !m.triaged);
    if (!untriaged.length) {
      el.hidden = true;
      el.innerHTML = '';
      return;
    }

    // Rank topics by how often they occur in this session, then give each
    // miss to its single highest-ranked topic so clusters partition the
    // session instead of overlapping.
    const topicCounts = new Map();
    for (const m of newest.misses) {
      for (const t of m.topics || []) topicCounts.set(t, (topicCounts.get(t) || 0) + 1);
    }
    const rankedTopics = [...topicCounts.entries()].sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0])
    );
    const topicRank = new Map(rankedTopics.map(([t], i) => [t, i]));

    const clusters = new Map(); // topic id -> misses[]
    const untopicked = [];
    for (const m of newest.misses) {
      const ts = m.topics || [];
      if (!ts.length) {
        untopicked.push(m);
        continue;
      }
      let best = ts[0];
      for (const t of ts) {
        if ((topicRank.get(t) ?? Infinity) < (topicRank.get(best) ?? Infinity)) best = t;
      }
      if (!clusters.has(best)) clusters.set(best, []);
      clusters.get(best).push(m);
    }

    const clusterTopics = rankedTopics.map(([t]) => t).filter((t) => clusters.has(t));
    const kTopics = clusterTopics.length + (untopicked.length ? 1 : 0);
    const n = newest.misses.length;

    const header = `LAST SESSION · ${fmtDate(newest.end)} · ${n} miss${n === 1 ? '' : 'es'} → ${kTopics} topic${
      kTopics === 1 ? '' : 's'
    }`;

    const body =
      clusterTopics.map((topic) => renderDebriefCluster(topic, clusters.get(topic))).join('') +
      (untopicked.length ? renderDebriefCluster(null, untopicked) : '');

    el.innerHTML = `<div class="debrief-head">${esc(header)}</div>${body}`;
    el.hidden = false;
    wireDebriefCard(el);
  }

  function renderDebriefCluster(topic, clusterMisses) {
    const catId = topic ? Tax.get(topic)?.category || 'concept' : 'concept';
    const label = topic ? Tax.label(topic) : 'Untagged';
    const untriagedCount = clusterMisses.filter((m) => !m.triaged).length;

    const rows = clusterMisses
      .map(
        (m) => `
        <div class="debrief-row" data-id="${esc(m.id)}">
          <span class="debrief-q">${
            !m.triaged ? '<span class="dot-untriaged">•</span>' : ''
          }${m.shaky ? '<span class="guessed-pill">guessed</span> ' : ''}${
            m.confidence === 'memorized' ? '<span class="memorized-pill">memorized</span> ' : ''
          }${
            m.partial ? `<span class="partial-pill${m.partial.got === m.partial.of ? ' full' : ''}">${m.partial.got}/${m.partial.of}</span> ` : ''
          }${m.qnum !== null && m.qnum !== undefined ? `${qnumPillHtml(m)} ` : ''}${esc(truncate(m.question, 70))}</span>
          ${m.notes ? `<div class="debrief-note">“${esc(truncate(m.notes, 90))}”</div>` : ''}
          <div class="debrief-actions">
            <button class="link" data-act="triage" data-id="${esc(m.id)}">triage</button>
            <button class="link" data-act="right" data-id="${esc(m.id)}">✓ got it right</button>
          </div>
        </div>`
      )
      .join('');

    return `
      <details class="debrief-cluster">
        <summary class="minihead debrief-summary">
          <span class="label"><span class="dot" style="background:var(--cat-${catId})"></span>${esc(
      label
    )}<span class="count"> · ${clusterMisses.length}${
      untriagedCount ? ` · ${untriagedCount} untriaged` : ''
    }</span></span>
        </summary>
        ${rows}
        <button class="link cluster-review" data-act="cluster-review">mark cluster reviewed</button>
      </details>`;
  }

  function wireDebriefCard(el) {
    for (const btn of el.querySelectorAll('[data-act="right"]')) {
      btn.addEventListener('click', async () => {
        await Store.markRight(btn.dataset.id);
        await load();
      });
    }
    for (const btn of el.querySelectorAll('[data-act="triage"]')) {
      btn.addEventListener('click', () => openInlineEditorFor(btn.dataset.id));
    }
    for (const btn of el.querySelectorAll('[data-act="cluster-review"]')) {
      btn.addEventListener('click', async () => {
        const cluster = btn.closest('.debrief-cluster');
        const ids = [...cluster.querySelectorAll('.debrief-row')].map((r) => r.dataset.id);
        for (const id of ids) await Store.updateMiss(id, { triaged: true });
        await load();
      });
    }
  }

  /** Jump to a card in the Recent tab and open its inline editor — the
   *  debrief's [triage] action. */
  function openInlineEditorFor(id) {
    switchTab('recent');
    topicFilter = null;
    $('search').value = '';
    renderRecent();
    const card = [...document.querySelectorAll('#recentList .card')].find((c) => c.dataset.id === id);
    if (!card) return;
    card.scrollIntoView({ block: 'center' });
    const editBtn = card.querySelector('[data-act="edit"]');
    if (editBtn) editBtn.click();
  }

  /** The "what to actually do next" card: recency-ranked topics, memorized facts, stubborn questions. */
  function renderFocusCard() {
    const el = $('focusCard');
    const focus = Store.focusTopics(misses, Date.now(), outcomes).slice(0, 3);
    const facts = misses.filter((m) => m.fact).slice(0, 5);
    // Array.filter passes (element, index, array) — call isStubborn through
    // an arrow so the numeric index can't clobber its `memorized` default.
    const stubborn = misses.filter((m) => isStubborn(m)).slice(0, 3);
    const callout = discCallout();

    if (!focus.length && !facts.length && !stubborn.length && !callout) {
      el.hidden = true;
      el.innerHTML = '';
      return;
    }

    const sections = [];
    if (callout) {
      sections.push(
        `<div class="focus-callout">⚠ ${callout.n} recent misses turned on ${esc(
          Tax.discLabel(callout.disc).toUpperCase()
        )}</div>`
      );
    }

    if (focus.length) {
      sections.push(`
        <details class="focus-section" open>
          <summary class="minihead"><span class="label">Study next</span></summary>
          ${focus
            .map((f) => {
              const catId = Tax.get(f.topic)?.category || 'concept';
              const notes = misses
                .filter((m) => (m.topics || []).includes(f.topic) && m.notes)
                .sort((a, b) => b.ts - a.ts)
                .slice(0, 2);
              return `
                <button class="focus-topic" data-topic="${esc(f.topic)}">
                  <span class="name"><span class="dot" style="background:var(--cat-${catId})"></span>${esc(Tax.label(f.topic))}</span>
                  ${notes.map((n) => `<div class="focus-note">“${esc(truncate(n.notes, 90))}”</div>`).join('')}
                </button>`;
            })
            .join('')}
        </details>`);
    }

    if (facts.length) {
      sections.push(`
        <details class="focus-section">
          <summary class="minihead"><span class="label">Memorize <span class="count">· ${facts.length}</span></span></summary>
          <ul class="focus-facts">
            ${facts
              .map((m) => `<li>${attemptsOf(m).length >= 2 ? '⚠ ' : ''}${esc(m.fact)}</li>`)
              .join('')}
          </ul>
        </details>`);
    }

    if (stubborn.length) {
      sections.push(`
        <details class="focus-section">
          <summary class="minihead"><span class="label">Stubborn questions <span class="count">· ${stubborn.length}</span></span></summary>
          <p class="focus-sub">Missed 3+ times — change how you study these, not how often.</p>
          ${stubborn
            .map((m) => {
              const url = safeUrl(m.url);
              return `
                <div class="focus-stubborn">
                  <span class="q">${esc(truncate(m.question, 70))}</span>
                  <span class="repeat-pill">missed ${attemptsOf(m).length}×</span>
                  <button class="link" data-act="right" data-id="${esc(m.id)}">✓ got it right</button>
                  ${url ? `<a class="link" href="${esc(url)}" target="_blank" rel="noreferrer">retake ↗</a>` : ''}
                </div>`;
            })
            .join('')}
        </details>`);
    }

    el.innerHTML = sections.join('');
    el.hidden = false;

    for (const btn of el.querySelectorAll('.focus-topic')) {
      btn.addEventListener('click', () => {
        topicFilter = btn.dataset.topic;
        switchTab('recent');
        renderRecent();
      });
    }
    for (const btn of el.querySelectorAll('[data-act="right"]')) {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await Store.markRight(btn.dataset.id);
        await load();
      });
    }
  }

  function renderRecent() {
    const el = $('recentList');
    const q = $('search').value.trim().toLowerCase();

    $('filterbar').hidden = !topicFilter;
    if (topicFilter) $('filterLabel').textContent = Tax.label(topicFilter);

    let rows = misses;
    if (topicFilter) rows = rows.filter((m) => (m.topics || []).includes(topicFilter));
    if (q) {
      rows = rows.filter((m) =>
        [m.question, m.yourAnswer, m.correctAnswer, m.notes, m.exam]
          .join(' ')
          .toLowerCase()
          .includes(q)
      );
    }

    if (!rows.length) {
      el.innerHTML = `<div class="empty">${
        misses.length ? 'Nothing matches that filter.' : 'No misses logged yet.'
      }</div>`;
      return;
    }

    el.innerHTML = '';
    for (const m of rows.slice(0, 200)) el.appendChild(renderCard(m));
  }

  function renderCard(m) {
    const card = document.createElement('div');
    card.className = 'card';
    card.dataset.id = m.id;
    const n = attemptsOf(m).length;
    const rights = rightsOf(m).length;
    const url = safeUrl(m.url);
    card.innerHTML = `
      <div class="meta">
        <span>${esc(m.exam || 'untagged')} · ${esc(m.host || '')}</span>
        <span>${rights ? `<span class="rights-pill">✓${rights}</span> · ` : ''}${
      n > 1 ? `<span class="repeat-pill">missed ${n}×</span> · ` : ''
    }${m.shaky ? `<span class="guessed-pill">guessed</span> · ` : ''}${
      m.confidence === 'memorized' ? `<span class="memorized-pill">memorized</span> · ` : ''
    }${
      m.partial ? `<span class="partial-pill${m.partial.got === m.partial.of ? ' full' : ''}">${m.partial.got}/${m.partial.of}</span> · ` : ''
    }${m.qnum !== null && m.qnum !== undefined ? `${qnumPillHtml(m)} · ` : ''}${fmtDate(m.ts)}</span>
      </div>
      <div class="q clamp">${esc(m.question) || '<i>no question text</i>'}</div>
      <div class="ans">
        <span class="wrong">You: ${esc(m.yourAnswer) || '—'}</span>
        &nbsp;·&nbsp;
        <span class="right">Correct: ${esc(m.correctAnswer) || '—'}</span>
      </div>
      ${m.reason ? `<div class="note">${esc(Tax.reasonLabel(m.reason))}</div>` : ''}
      ${m.fact ? `<div class="fact-line"><span class="fact-tag">MEMORIZE</span>${esc(m.fact)}</div>` : ''}
      ${m.notes ? `<div class="note">“${esc(m.notes)}”</div>` : ''}
      <div class="tags">
        ${m.disc ? `<span class="tagchip disc-tag">turns on: ${esc(Tax.discLabel(m.disc))}</span>` : ''}
        ${(m.topics || []).map((t) => `<span class="tagchip">${esc(Tax.label(t))}</span>`).join('')}
      </div>
      <div class="actions">
        <button class="link" data-act="expand">Show full</button>
        <button class="link" data-act="edit">Edit</button>
        <button class="link" data-act="right">✓ got it right</button>
        ${url ? `<a class="link" href="${esc(url)}" target="_blank" rel="noreferrer">Open source</a>` : ''}
        <button class="link danger" data-act="delete">Delete</button>
      </div>`;

    card.querySelector('[data-act="expand"]').addEventListener('click', (e) => {
      const body = card.querySelector('.q');
      body.classList.toggle('clamp');
      e.target.textContent = body.classList.contains('clamp') ? 'Show full' : 'Collapse';
    });

    card.querySelector('[data-act="edit"]').addEventListener('click', () => {
      card.replaceWith(renderEditor(m));
    });

    card.querySelector('[data-act="right"]').addEventListener('click', async () => {
      await Store.markRight(m.id);
      await load();
    });

    card.querySelector('[data-act="delete"]').addEventListener('click', async () => {
      await Store.deleteMiss(m.id);
      showUndoToast(m);
      await load();
    });

    return card;
  }

  /** Inline edit form — replaces the card in place. */
  function renderEditor(m) {
    const form = document.createElement('div');
    form.className = 'card editing';
    let topics = new Set(m.topics || []);

    form.innerHTML = `
      <label class="f">Question</label>
      <textarea class="ed" data-k="question" rows="4"></textarea>
      <div class="pair">
        <div>
          <label class="f">You picked</label>
          <textarea class="ed autogrow" data-k="yourAnswer" rows="1"></textarea>
        </div>
        <div>
          <label class="f">Correct</label>
          <textarea class="ed autogrow" data-k="correctAnswer" rows="1"></textarea>
        </div>
      </div>
      <label class="f">Topics</label>
      <div class="tags" data-role="chips"></div>
      <input type="text" list="cb-topics" placeholder="Add a topic…" data-role="addTopic">
      <label class="f">Why you missed it</label>
      <select class="ed" data-k="reason">
        <option value="">—</option>
        ${Tax.REASONS.map((r) => `<option value="${r.id}">${esc(r.label)}</option>`).join('')}
      </select>
      <label class="f">Turns on</label>
      <select class="ed" data-k="disc">
        <option value="">—</option>
        ${Tax.DISCRIMINATORS.map((d) => `<option value="${d.id}">${esc(d.label)}</option>`).join('')}
      </select>
      <label class="f">Fact to memorize</label>
      <textarea class="ed autogrow mono" data-k="fact" rows="1" placeholder="The exact limit/number this hinged on…"></textarea>
      <label class="f">Note</label>
      <textarea class="ed" data-k="notes" rows="2"></textarea>
      <div class="actions">
        <button class="btn small primary" data-act="save">Save</button>
        <button class="btn small" data-act="cancel">Cancel</button>
      </div>`;

    // Values go in via .value, never innerHTML — no escaping games.
    for (const f of form.querySelectorAll('.ed')) {
      f.value = m[f.dataset.k] || '';
      if (f.classList.contains('autogrow')) autogrow(f);
    }
    for (const f of form.querySelectorAll('textarea.autogrow')) {
      f.addEventListener('input', () => autogrow(f));
    }

    const chips = form.querySelector('[data-role="chips"]');
    function drawChips() {
      chips.innerHTML = '';
      if (!topics.size) chips.innerHTML = '<span class="note">No topics</span>';
      for (const id of topics) {
        const b = document.createElement('button');
        b.className = 'tagchip removable';
        b.textContent = Tax.label(id) + ' ×';
        b.title = 'Remove';
        b.addEventListener('click', () => {
          topics.delete(id);
          drawChips();
        });
        chips.appendChild(b);
      }
    }
    drawChips();

    const add = form.querySelector('[data-role="addTopic"]');
    add.addEventListener('change', () => {
      const hit = Tax.TOPICS.find(
        (t) => t.label.toLowerCase() === add.value.trim().toLowerCase()
      );
      if (hit) {
        topics.add(hit.id);
        drawChips();
      }
      add.value = '';
    });

    form.querySelector('[data-act="cancel"]').addEventListener('click', () => {
      form.replaceWith(renderCard(m));
    });

    form.querySelector('[data-act="save"]').addEventListener('click', async () => {
      // Saving the inline editor IS the triage step — the debrief's [triage]
      // action lands here, and this is what should clear the untriaged marker.
      const patch = { topics: [...topics], triaged: true };
      for (const f of form.querySelectorAll('.ed')) patch[f.dataset.k] = f.value.trim();
      await Store.updateMiss(m.id, patch);
      await load();
    });

    return form;
  }

  function switchTab(name) {
    for (const t of document.querySelectorAll('.tab')) {
      t.classList.toggle('active', t.dataset.tab === name);
    }
    for (const p of document.querySelectorAll('.pane')) {
      p.hidden = p.id !== 'tab-' + name;
    }
  }

  // ---- events ---------------------------------------------------------
  $('cb-topics').innerHTML = Tax.TOPICS.map(
    (t) => `<option value="${esc(t.label)}"></option>`
  ).join('');

  document.querySelectorAll('.tab').forEach((t) =>
    t.addEventListener('click', () => switchTab(t.dataset.tab))
  );

  $('search').addEventListener('input', renderRecent);

  $('clearFilter').addEventListener('click', () => {
    topicFilter = null;
    renderRecent();
  });

  $('expand').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/popup/popup.html?view=full') });
    window.close();
  });

  $('export').addEventListener('click', async () => {
    await exportNow();
    $('dataMsg').textContent = `Exported ${misses.length} questions.`;
    await load(); // clears the export nudge
  });

  $('toastUndo').addEventListener('click', async () => {
    if (!undoRecord) return;
    clearTimeout(undoTimer);
    const record = undoRecord;
    undoRecord = null;
    $('toast').hidden = true;
    await Store.restoreMiss(record);
    await load();
  });

  $('importFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const { added, skipped } = await Store.importJson(await file.text());
      $('dataMsg').textContent = `Imported ${added} miss${added === 1 ? '' : 'es'}${
        skipped ? `, skipped ${skipped} already present` : ''
      }.`;
      await load();
    } catch (err) {
      $('dataMsg').textContent = `Import failed: ${err.message}`;
    } finally {
      e.target.value = '';
    }
  });

  $('clear').addEventListener('click', async () => {
    if (!confirm('Delete every logged miss? This cannot be undone — export first.')) return;
    await Store.clearAll();
    $('dataMsg').textContent = 'All data deleted.';
    await load();
  });

  // Pages other than Udemy don't get the content script anymore (narrower
  // host permissions), so offer a one-click, one-tab injection instead. Not
  // every restricted URL can be told apart in advance (chrome://, the Web
  // Store, PDF viewer…) — chrome.scripting.executeScript just fails on those,
  // caught below.
  const RESTRICTED_URL_RE = /^(chrome|chrome-extension|edge|about|devtools):/i;

  // Sites the content script already runs on natively (see manifest.json's
  // content_scripts.matches) — the "enable logging here" bar exists only to
  // cover everything ELSE, so it must recognize every host that's already
  // covered, not just Udemy.
  const SUPPORTED_HOSTS = [
    (h) => /(^|\.)udemy\.com$/i.test(h),
    (h) => /(^|\.)tutorialsdojo\.com$/i.test(h)
  ];

  async function checkActiveTab() {
    const bar = $('notUdemyBar');
    bar.hidden = true;
    $('notUdemyMsg').textContent = '';
    // The mock harness's chrome object has no tabs.query — feature-detect so
    // the popup still loads clean under it, bar just never appears.
    if (!(globalThis.chrome && chrome.tabs && chrome.tabs.query)) return;
    let tab;
    try {
      [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    } catch (e) {
      return;
    }
    if (!tab || !tab.url || RESTRICTED_URL_RE.test(tab.url)) return;
    let host = '';
    try {
      host = new URL(tab.url).hostname;
    } catch (e) {
      return;
    }
    if (SUPPORTED_HOSTS.some((test) => test(host))) return;

    activeTabId = tab.id;
    bar.hidden = false;
  }

  $('enableHere').addEventListener('click', async () => {
    $('notUdemyMsg').textContent = '';
    try {
      await chrome.scripting.executeScript({
        target: { tabId: activeTabId, allFrames: true },
        files: [
          'src/lib/store.js',
          'src/lib/taxonomy.js',
          'src/lib/theme.js',
          'src/content/adapters.js',
          'src/content/outcomes.js',
          'src/content/tagger.js'
        ]
      });
      $('notUdemyBar').hidden = true;
    } catch (e) {
      $('notUdemyMsg').textContent = "Couldn't enable here — try a regular webpage tab.";
    }
  });

  load();
  checkActiveTab();
})();
