/**
 * Cert Buddy storage layer.
 *
 * Single-key blob in chrome.storage.local. No backend, no login, no sync.
 * Loaded as a classic script by both the content script and the popup, so it
 * hangs off globalThis instead of using ES module exports.
 */
(function (root) {
  const KEY = 'certbuddy.v1';

  const emptyDb = () => ({
    version: 2,
    misses: [],
    // Passive outcome log (Correct/Incorrect banner detections) — one record
    // per question fingerprint, independent of the miss log. See
    // Store.logOutcome / Store.setConfidence.
    outcomes: [],
    // Periodic in-storage copies of `misses` (and, from v2, `outcomes`),
    // written by snapshotIfDue(). These guard against a corrupted write
    // clobbering the live data — they do NOT survive a profile wipe or
    // extension removal, same as everything else in chrome.storage.local.
    // Export JSON is still the only real backup.
    backups: [],
    settings: {
      autoTag: true,
      hiddenHosts: [],
      lastExportAt: 0
    }
  });

  function newId() {
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  /**
   * Stable key for "is this the same question I've seen before?".
   * Normalises away option letters, whitespace and punctuation, then hashes
   * the first 300 characters. Empty questions get no fingerprint.
   */
  function fingerprint(question) {
    const norm = String(question || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '')
      .slice(0, 300);
    if (norm.length < 25) return ''; // too short to match on confidently
    let h = 5381;
    for (let i = 0; i < norm.length; i++) h = ((h << 5) + h + norm.charCodeAt(i)) | 0;
    return 'fp' + (h >>> 0).toString(36) + norm.length.toString(36);
  }

  /**
   * Reasons collapsed from 7 buckets to 3 (see taxonomy.js REASONS) after
   * reviewing real capture data. Old records keep their legacy id in
   * storage; this maps it to the new taxonomy on the way OUT of storage so
   * the UI never has to know the old ids existed. Unrecognised/empty values
   * fall through to ''.
   */
  const LEGACY_REASON_MAP = {
    'didnt-know': 'never-learned',
    'confused-two': 'never-learned',
    'fact-recall': 'no-recall',
    'narrowed-wrong': 'no-recall',
    'misread': 'misread',
    'missed-constraint': 'misread',
    'careless': 'misread'
  };
  const REASON_IDS = new Set(['never-learned', 'no-recall', 'misread']);
  function migrateReason(reason) {
    if (!reason) return '';
    if (REASON_IDS.has(reason)) return reason;
    return LEGACY_REASON_MAP[reason] || '';
  }

  /**
   * Older records predate `attempts` / `fp` / `shaky`, and older reasons
   * predate the 3-bucket taxonomy; fill/migrate them in on the way out.
   */
  function normalizeMiss(m) {
    const attempts = Array.isArray(m.attempts) && m.attempts.length ? m.attempts : [m.ts];
    return {
      ...m,
      attempts,
      fp: m.fp || fingerprint(m.question),
      fact: m.fact || '',
      disc: m.disc || '',
      reason: migrateReason(m.reason),
      shaky: !!m.shaky,
      rights: Array.isArray(m.rights) ? m.rights : [],
      // Legacy records predate `triaged` entirely — infer it from whether the
      // capture already carried a classification (a reason and/or a fact).
      // Records that already have the field (including explicit `false` from
      // a quick-save) pass through untouched.
      triaged: m.triaged !== undefined ? !!m.triaged : !!(m.reason || m.fact),
      // 'knew' | 'narrowed' | 'guessed' | 'memorized' | null. Backfilled from
      // the outcome toast (see addMiss) — records that predate confidence
      // just get null. Migration: the toast's second button used to be
      // labeled/valued 'unsure' — old records on disk still carry that
      // literal string, so it's mapped to the current 'narrowed' here on
      // every read instead of being rewritten in storage.
      confidence: m.confidence === 'unsure' ? 'narrowed' : (m.confidence ?? null)
    };
  }

  /**
   * Same 'unsure' -> 'narrowed' confidence migration as normalizeMiss, for
   * outcome records. Deliberately minimal — outcomes otherwise predate no
   * other fields the way old misses do, so nothing else here is touched or
   * backfilled.
   */
  function normalizeOutcome(o) {
    if (!o || o.confidence !== 'unsure') return o;
    return { ...o, confidence: 'narrowed' };
  }

  /**
   * Fill `record.confidence` from the outcome log entry with a matching fp,
   * but ONLY if the record doesn't already have one — this is the "join at
   * capture time" the miss/outcome logs share. Mutates `record` in place;
   * `db` must already be loaded (not re-read here, callers are mid-write).
   */
  function joinConfidenceFromOutcome(record, db) {
    if (record.confidence !== null && record.confidence !== undefined) return;
    if (!record.fp) return;
    const outcome = db.outcomes.find((o) => o.fp === record.fp);
    if (outcome && outcome.confidence !== null && outcome.confidence !== undefined) {
      record.confidence = outcome.confidence;
    }
  }

  async function read() {
    const bag = await chrome.storage.local.get(KEY);
    const db = bag[KEY];
    if (!db || typeof db !== 'object') return emptyDb();
    // Fill in anything an older/partial blob is missing.
    const merged = Object.assign(emptyDb(), db, {
      misses: (db.misses || []).map(normalizeMiss),
      outcomes: (db.outcomes || []).map(normalizeOutcome),
      backups: db.backups || [],
      settings: Object.assign(emptyDb().settings, db.settings || {})
    });
    // Retired seam: `notes` used to be a reserved-but-unused top-level array
    // (nothing ever wrote to it). Object.assign above copies it straight
    // through from `db` if an old blob still carries the key — drop it here
    // so it never survives a write. Tolerating the key on READ, dropping it
    // on WRITE, is the whole migration; there's no data to preserve.
    delete merged.notes;
    // v1 -> v2 added `outcomes` (backfilled above) — nothing to transform on
    // the miss records themselves, so the migration is just the version bump.
    if (!merged.version || merged.version === 1) merged.version = 2;
    return merged;
  }

  /**
   * Writes `db` to chrome.storage.local. A write failure here is silent data
   * loss unless we surface it — chrome.storage.local.set can fail two ways:
   * the promise it returns rejects (the normal MV3 path), or it resolves but
   * leaves chrome.runtime.lastError set (the older callback-API failure
   * signal, kept here defensively in case any environment still uses it).
   * Both are checked.
   *
   * The only failure we can recover from automatically is quota exhaustion
   * (chrome.storage.local's ~10MB cap): `backups` is the biggest single
   * thing under our control, so dropping the OLDEST entry (backups[0] is
   * newest, see snapshotIfDue) and retrying once is a reasonable
   * self-repair. If that retry still fails — quota exhaustion from `misses`
   * itself, or any non-quota error — the error is re-thrown so every caller
   * (they all already `await write(db)`) sees a rejected promise instead of
   * data quietly not being saved.
   */
  async function write(db) {
    const attempt = async (payload) => {
      await chrome.storage.local.set({ [KEY]: payload });
      const err = globalThis.chrome && chrome.runtime && chrome.runtime.lastError;
      if (err) throw new Error(err.message || 'chrome.storage.local.set failed');
    };

    try {
      await attempt(db);
      return db;
    } catch (err) {
      if (!Array.isArray(db.backups) || !db.backups.length) throw err;
      const shrunk = { ...db, backups: db.backups.slice(0, -1) };
      await attempt(shrunk); // let this one throw uncaught if it still fails
      db.backups = shrunk.backups; // keep the caller's in-memory db in sync with what actually landed
      return db;
    }
  }

  /**
   * A miss record.
   * @typedef {Object} Miss
   * @property {string} id
   * @property {number} ts          epoch ms
   * @property {string} host        where it was logged
   * @property {string} url
   * @property {string} exam        e.g. "SAP-C02"
   * @property {string} question    truncated question text
   * @property {string} yourAnswer
   * @property {string} correctAnswer
   * @property {string[]} topics    taxonomy ids
   * @property {string} reason      why-missed bucket id
   * @property {string} notes
   * @property {string} fact        specific memorizable fact/limit the question hinged on
   * @property {number[]} attempts  every time you missed THIS question
   * @property {string} fp          fingerprint used to match repeats
   * @property {string} disc        which stem discriminator the question turned on (taxonomy id)
   * @property {number[]} rights    timestamps of "got it right" events
   * @property {boolean} triaged    whether this capture has been classified (reason/fact picked,
   *                                 or reviewed later in the debrief)
   * @property {boolean} shaky      logged as "got it right" but only by guessing — counts like a
   *                                 miss for weak-area weighting
   * @property {?('knew'|'narrowed'|'guessed'|'memorized')} confidence  self-rated confidence, joined
   *                                 in from the matching Outcome by fp at capture time if not set
   *                                 explicitly. 'memorized' = high certainty, zero reasoning (pure
   *                                 answer-recognition on a reused question) — see focusTopics and
   *                                 isStubborn-style graduation logic for how this discounts a right.
   *
   * NOTE on 'memorized' as a single-value field: once a fp is flagged
   * memorized (via an Outcome or an explicit tagger save), that flag doesn't
   * expire on its own even if you later genuinely learn the question — v1
   * has no "un-memorize" signal. Accepted limitation; the reset path is a
   * fresh miss (a new attempt re-triggers normal handling) or a manual edit
   * of the record's confidence.
   */

  /**
   * A passive outcome record — one per question fingerprint, written by the
   * outcomes.js content module when it sees a "Correct answer." / "Incorrect
   * answer." banner. Independent of the miss log: an outcome can exist with
   * no matching miss (you got it right, or never opened the tagger).
   * @typedef {Object} Outcome
   * @property {string} id
   * @property {string} fp             fingerprint used to match repeats (same function as Miss.fp)
   * @property {string} questionSnippet  first 200 chars of the question text
   * @property {'correct'|'incorrect'} outcome
   * @property {?('knew'|'narrowed'|'guessed'|'memorized')} confidence  set once via the toast, first
   *                                 tap wins
   * @property {string} exam
   * @property {number} ts             epoch ms of the first detection
   * @property {number[]} attempts     every time this outcome was (re-)detected
   * @property {string} url
   */

  const Store = {
    KEY,
    newId,

    async getAll() {
      return read();
    },

    async getMisses() {
      return (await read()).misses;
    },

    fingerprint,
    // Exposed alongside fingerprint so the pure-function test harness
    // (tests/test.html) can exercise the legacy-reason migration table
    // directly instead of round-tripping through storage. Not called
    // anywhere else in the extension outside normalizeMiss.
    migrateReason,
    // Same reasoning as migrateReason: lets tests/test.html exercise the
    // 'unsure' -> 'narrowed' confidence migration (see normalizeMiss /
    // normalizeOutcome above) directly, without a chrome.storage round trip.
    normalizeMiss,
    normalizeOutcome,

    /** The existing record for this question, if you've missed it before. */
    async findRepeat(question) {
      const fp = fingerprint(question);
      if (!fp) return null;
      return (await read()).misses.find((m) => m.fp === fp) || null;
    },

    /**
     * The passive outcome record for a fingerprint, if one exists. Lets
     * callers (the tagger) check "was this already answered correctly?"
     * without reaching into raw db state themselves.
     */
    async getOutcomeByFp(fp) {
      if (!fp) return null;
      return (await read()).outcomes.find((o) => o.fp === fp) || null;
    },

    /**
     * The existing MISS record for a fingerprint, if one exists. Distinct
     * from findRepeat, which takes raw question text and computes the
     * fingerprint itself — this takes an fp directly. Used by the outcomes
     * toast to show a "seen before" honesty marker: a MISS already on file
     * for this fp means the question is a repeat, exactly where a "correct"
     * now is more likely recognition than reasoning.
     */
    async getMissByFp(fp) {
      if (!fp) return null;
      return (await read()).misses.find((m) => m.fp === fp) || null;
    },

    /**
     * Sets the "why" sentence from the outcome toast's stage 2 onto the MISS
     * record sharing this fp — the auto-capture on an incorrect outcome
     * always creates one first, so this is normally filling it in seconds
     * later. Only fills `notes` if it's currently empty; a non-empty notes
     * field (e.g. a manual tagger edit that landed first) gets the new text
     * APPENDED with ' · ' rather than overwritten, so neither source of notes
     * can silently clobber the other. No-op (returns null) if no miss with
     * this fp exists yet, or the text is empty.
     */
    async setNotesByFp(fp, text) {
      const trimmed = String(text || '').trim();
      if (!fp || !trimmed) return null;
      const db = await read();
      const m = db.misses.find((x) => x.fp === fp);
      if (!m) return null;
      m.notes = m.notes ? m.notes + ' · ' + trimmed : trimmed;
      await write(db);
      return m;
    },

    /**
     * Log a miss. If the same question is already on file, this records another
     * ATTEMPT on that record rather than creating a duplicate — repeat misses
     * are signal, but they shouldn't clutter the list or look like two
     * different questions on the same topic.
     */
    async addMiss(partial) {
      const db = await read();
      const now = Date.now();
      const fp = fingerprint(partial.question);

      const existing = fp ? db.misses.find((m) => m.fp === fp) : null;
      if (existing) {
        existing.attempts = [...(existing.attempts || [existing.ts]), now];
        existing.ts = now;
        // Later attempts overwrite earlier ones only where you filled something in.
        // `rights` is deliberately excluded — repeat-merge logs another MISS, so
        // it must never erase evidence you'd previously gotten this one right.
        for (const k of ['yourAnswer', 'correctAnswer', 'reason', 'notes', 'fact', 'exam', 'url', 'disc']) {
          if (partial[k]) existing[k] = partial[k];
        }
        if (partial.topics && partial.topics.length) existing.topics = partial.topics;
        // `shaky` describes the ORIGINAL capture, not every subsequent
        // attempt — a shaky log matching an existing record just adds an
        // attempt and leaves shaky as-is. A later attempt that's NOT shaky
        // (a real miss) proves it's for real, so it clears the flag.
        if (partial.shaky === false) existing.shaky = false;
        // This attempt counts as triaged if it explicitly says so, or if a
        // reason came with it — same rule as a fresh capture, applied to the
        // record as a whole (a triaged repeat re-flags it for the debrief).
        existing.triaged = partial.triaged !== undefined ? !!partial.triaged : !!(existing.triaged || partial.reason);
        // Confidence: first-fill-wins, same rule as setConfidence. An
        // explicit value on this attempt fills it; otherwise fall back to
        // whatever the passive-outcome toast already recorded for this fp.
        // Never overwrites a confidence this record already has.
        if (existing.confidence === null || existing.confidence === undefined) {
          if (partial.confidence !== null && partial.confidence !== undefined) {
            existing.confidence = partial.confidence;
          } else {
            joinConfidenceFromOutcome(existing, db);
          }
        }
        db.misses.sort((a, b) => b.ts - a.ts);
        await write(db);
        return { miss: existing, repeat: true, attempt: existing.attempts.length };
      }

      const miss = {
        id: newId(),
        ts: now,
        host: '',
        url: '',
        exam: '',
        question: '',
        yourAnswer: '',
        correctAnswer: '',
        topics: [],
        reason: '',
        notes: '',
        fact: '',
        disc: '',
        rights: [],
        triaged: false,
        shaky: false,
        confidence: null,
        ...partial,
        fp,
        attempts: [now]
      };
      // A quick-capture is only "triaged" if a reason was actually picked at
      // save time — don't let a caller-omitted flag silently mark it done.
      if (partial.triaged === undefined) miss.triaged = !!miss.reason;
      // Join confidence in from the passive-outcome log at capture time, if
      // this capture didn't already bring its own and one exists for the fp.
      if (miss.confidence === null || miss.confidence === undefined) {
        joinConfidenceFromOutcome(miss, db);
      }
      db.misses.unshift(miss);
      await write(db);
      return { miss, repeat: false, attempt: 1 };
    },

    async updateMiss(id, patch) {
      const db = await read();
      const i = db.misses.findIndex((m) => m.id === id);
      if (i === -1) return null;
      const next = { ...db.misses[i], ...patch, id };
      if (patch.question !== undefined) next.fp = fingerprint(next.question);
      db.misses[i] = next;
      await write(db);
      return next;
    },

    /**
     * Record a "got it right" event on a miss — the flip side of a repeat
     * attempt. Doesn't touch `attempts`; rights and misses are counted
     * separately so focusTopics can net them against each other.
     */
    async markRight(id) {
      const db = await read();
      const m = db.misses.find((x) => x.id === id);
      if (!m) return null;
      m.rights = [...(m.rights || []), Date.now()];
      await write(db);
      return m;
    },

    async deleteMiss(id) {
      const db = await read();
      const before = db.misses.length;
      db.misses = db.misses.filter((m) => m.id !== id);
      if (db.misses.length !== before) await write(db);
      return before - db.misses.length;
    },

    /**
     * Undo for deleteMiss: pushes a previously-deleted record back in and
     * re-sorts, same ordering rule as everywhere else (newest ts first).
     */
    async restoreMiss(record) {
      const db = await read();
      db.misses = db.misses.filter((m) => m.id !== record.id);
      db.misses.push(record);
      db.misses.sort((a, b) => b.ts - a.ts);
      await write(db);
      return record;
    },

    /**
     * Log a passive outcome detection (the "Correct answer" / "Incorrect
     * answer" banner) for a question, keyed by fingerprint — independent of
     * the miss log. If this fp already has an outcome on file, this is a
     * RE-DETECTION (a re-render, or you revisiting the question later): it
     * adds an attempt but keeps the ORIGINAL outcome and confidence, since a
     * later view is a re-read, not a new attempt at the question.
     */
    async logOutcome({ fp, questionSnippet, outcome, confidence = null, exam, url } = {}) {
      if (!fp) return { record: null, deduped: false }; // never log unattributable outcomes
      const db = await read();
      const now = Date.now();

      const existing = db.outcomes.find((o) => o.fp === fp);
      if (existing) {
        existing.attempts = [...(existing.attempts || [existing.ts]), now];
        await write(db);
        return { record: existing, deduped: true };
      }

      const record = {
        id: newId(),
        fp,
        questionSnippet: String(questionSnippet || '').slice(0, 200),
        outcome,
        confidence,
        exam: exam || '',
        ts: now,
        attempts: [now],
        url: url || ''
      };
      db.outcomes.unshift(record);
      await write(db);
      return { record, deduped: false };
    },

    /**
     * First tap wins: sets confidence on the outcome record for this fp only
     * if it's currently null, and does the same for any miss record sharing
     * the fp (covers the case where the miss was logged before the toast was
     * answered). Never overwrites an existing confidence either side.
     */
    async setConfidence(fp, confidence) {
      if (!fp) return { outcome: null, missesUpdated: 0 };
      const db = await read();

      const outcome = db.outcomes.find((o) => o.fp === fp) || null;
      if (outcome && (outcome.confidence === null || outcome.confidence === undefined)) {
        outcome.confidence = confidence;
      }

      let missesUpdated = 0;
      for (const m of db.misses) {
        if (m.fp === fp && (m.confidence === null || m.confidence === undefined)) {
          m.confidence = confidence;
          missesUpdated++;
        }
      }

      if (outcome || missesUpdated) await write(db);
      return { outcome, missesUpdated };
    },

    /**
     * Snapshot `misses` (and, from v2, `outcomes`) into `backups` if the
     * newest one is more than a day old (or there isn't one yet). This is
     * corruption insurance, not a real backup — it lives in the same storage
     * blob it's protecting, so it's useless against a profile wipe or the
     * extension being removed. Export JSON (Data tab) is the only copy that
     * survives those.
     */
    async snapshotIfDue() {
      const db = await read();
      const newest = db.backups[0];
      if (newest && Date.now() - newest.ts < 86400000) return false;

      // chrome.storage.local's cap is ~10MB (QUOTA_BYTES). `backups` holds up
      // to 3 full copies of misses+outcomes, so it's what pushes a blob
      // toward that ceiling fastest. QUOTA_WARN_BYTES is ~70% of the quota —
      // crossing it prunes down to just the newest backup *before* adding
      // another, so normal growth never has to fall back on write()'s
      // drop-oldest-and-retry recovery in the first place.
      const QUOTA_WARN_BYTES = 7_000_000; // ~70% of chrome.storage.local's ~10MB cap
      const size = JSON.stringify(db).length;
      if (size > QUOTA_WARN_BYTES) {
        console.warn(`[Cert Buddy] storage blob is ${size} bytes (over the ${QUOTA_WARN_BYTES}-byte warn threshold) — pruning backups to 1`);
        db.backups = db.backups.slice(0, 1);
      }

      // structuredClone-ish: no shared refs with live data
      const misses = JSON.parse(JSON.stringify(db.misses));
      const outcomes = JSON.parse(JSON.stringify(db.outcomes));
      db.backups = [{ ts: Date.now(), misses, outcomes }, ...db.backups].slice(0, 3);
      await write(db);
      return true;
    },

    async getSettings() {
      return (await read()).settings;
    },

    async setSettings(patch) {
      const db = await read();
      db.settings = { ...db.settings, ...patch };
      await write(db);
      return db.settings;
    },

    /**
     * Topics ranked by how much they've cost you. Weighted by attempts, so a
     * question you've now missed three times outranks three one-off misses.
     * Pure — pass in the misses you already have.
     */
    weakAreas(misses) {
      const counts = new Map();
      for (const m of misses) {
        const weight = (m.attempts || [m.ts]).length;
        for (const t of m.topics || []) {
          const prev = counts.get(t) || { weight: 0, questions: 0 };
          counts.set(t, { weight: prev.weight + weight, questions: prev.questions + 1 });
        }
      }
      return [...counts.entries()]
        .map(([topic, v]) => ({ topic, ...v }))
        .sort((a, b) => b.weight - a.weight || a.topic.localeCompare(b.topic));
    },

    /**
     * Topics ranked by recency-weighted attempts, 14-day half-life — a topic
     * you just missed outranks one you used to miss a lot but haven't lately.
     * A "got it right" event decays the same way and is subtracted, so a
     * topic you've since nailed a few times fades out even if you missed it
     * hard a week ago. Net contribution per question is floored at 0 — a
     * question can cancel its own weight out, but it can't push a topic's
     * total negative. Pure — pass in the misses (and `now`, for testability)
     * you already have.
     *
     * `outcomes` (optional, default []) is the passive outcome log — used
     * only to find fps flagged confidence:'memorized'. A memorized right is
     * pure answer-recognition, not evidence you've learned the material, so
     * it must not fake progress the way a genuine right does: for those fps
     * the rights-decay subtraction is skipped entirely (miss attempts still
     * count in full, same as if no right had ever happened). Omitted/empty
     * `outcomes` reproduces the pre-existing behavior exactly — purely
     * additive.
     */
    focusTopics(misses, now = Date.now(), outcomes = []) {
      const HALF_LIFE_DAYS = 14;
      const decay = (ts) => Math.pow(0.5, (now - ts) / 86400000 / HALF_LIFE_DAYS);
      const memorizedFps = new Set(
        (outcomes || [])
          .filter((o) => o && o.fp && o.confidence === 'memorized')
          .map((o) => o.fp)
      );
      const counts = new Map();
      for (const m of misses) {
        const missWeight = (m.attempts || [m.ts]).reduce((sum, ts) => sum + decay(ts), 0);
        const rightWeight = memorizedFps.has(m.fp)
          ? 0
          : (m.rights || []).reduce((sum, ts) => sum + decay(ts), 0);
        const contribution = Math.max(0, missWeight - rightWeight);
        for (const t of m.topics || []) {
          const prev = counts.get(t) || { weight: 0, questions: new Set() };
          prev.weight += contribution;
          prev.questions.add(m.id);
          counts.set(t, prev);
        }
      }
      return [...counts.entries()]
        .map(([topic, v]) => ({ topic, weight: v.weight, questions: v.questions.size }))
        .sort((a, b) => b.weight - a.weight || a.topic.localeCompare(b.topic));
    },

    /**
     * Groups misses into study sessions by each miss's LATEST attempt
     * timestamp: sort those descending, and a gap of more than 90 minutes
     * between consecutive latest-attempts starts a new session. This is what
     * powers the debrief — "what did I just study" rather than "what have I
     * ever missed". Pure — pass in the misses you already have.
     * @returns {{start:number,end:number,misses:object[]}[]} newest session first.
     */
    sessionize(misses) {
      const GAP_MS = 90 * 60 * 1000;
      const items = misses
        .map((m) => ({ m, latest: Math.max(...(m.attempts && m.attempts.length ? m.attempts : [m.ts])) }))
        .sort((a, b) => b.latest - a.latest);

      const sessions = [];
      for (const { m, latest } of items) {
        const cur = sessions[sessions.length - 1];
        if (cur && cur.end - latest <= GAP_MS) {
          cur.misses.push(m);
          cur.start = latest; // items arrive newest-first, so this only ever shrinks
        } else {
          sessions.push({ start: latest, end: latest, misses: [m] });
        }
      }
      return sessions;
    },

    async exportJson() {
      const db = await read();
      const json = JSON.stringify({ ...db, exportedAt: new Date().toISOString() }, null, 2);
      db.settings.lastExportAt = Date.now();
      await write(db);
      return json;
    },

    /**
     * Merge an exported blob back in. Misses with an id already present are
     * skipped, so re-importing the same file is a no-op. Outcomes merge the
     * same way but keyed by fp (they have no stable id-before-import
     * concept the way misses do) — exports from before outcomes existed
     * just have no `outcomes` array, which is tolerated.
     */
    async importJson(text) {
      const incoming = JSON.parse(text);
      if (!incoming || !Array.isArray(incoming.misses)) {
        throw new Error('Not a Cert Buddy export (no "misses" array).');
      }
      const db = await read();
      const seen = new Set(db.misses.map((m) => m.id));
      let added = 0;
      for (const m of incoming.misses) {
        if (!m || seen.has(m.id)) continue;
        db.misses.push({ ...m, id: m.id || newId() });
        added++;
      }
      db.misses.sort((a, b) => (b.ts || 0) - (a.ts || 0));

      const incomingOutcomes = Array.isArray(incoming.outcomes) ? incoming.outcomes : [];
      const seenFp = new Set(db.outcomes.map((o) => o.fp));
      let outcomesAdded = 0;
      for (const o of incomingOutcomes) {
        if (!o || !o.fp || seenFp.has(o.fp)) continue;
        db.outcomes.push({ ...o, id: o.id || newId() });
        seenFp.add(o.fp);
        outcomesAdded++;
      }

      await write(db);
      return {
        added,
        skipped: incoming.misses.length - added,
        outcomesAdded,
        outcomesSkipped: incomingOutcomes.length - outcomesAdded
      };
    },

    async clearAll() {
      await chrome.storage.local.remove(KEY);
    }
  };

  root.CertBuddyStore = Store;
})(globalThis);
