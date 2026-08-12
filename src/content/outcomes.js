/**
 * Cert Buddy passive outcome logger.
 *
 * Zero-interaction: watches for the "Correct answer." / "Incorrect answer."
 * result banner Udemy practice questions render after you answer, and logs
 * the outcome against the on-screen question — no click, no tagger panel.
 *
 * Also owns the one-tap confidence toast (Feature 2): the moment a *new*
 * outcome is logged, a tiny non-blocking toast offers "knew it / unsure /
 * guessed / memorized" so weak-area weighting can tell a lucky guess (or a
 * pure answer-recognition right on a repeat question) from a solid, reasoned
 * one.
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
  if (!Store || !Adapters) return; // load-order guard, mirrors tagger.js

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

  function handleCandidate(el) {
    const t = safe(() => (el.innerText || el.textContent || '').trim(), '');
    const outcome = /^correct/i.test(t) ? 'correct' : 'incorrect';

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
      exam: data.exam,
      url: location.href.slice(0, 500)
    })
      .then(({ record, deduped }) => {
        if (!deduped && record) showToast(record.fp);
      })
      .catch((e) => console.debug('[Cert Buddy] logOutcome failed', e));
  }

  const observer = new MutationObserver((mutations) => {
    for (const el of collectCandidates(mutations)) handleCandidate(el);
  });

  function startObserving() {
    if (document.body) {
      observer.observe(document.body, { childList: true, subtree: true });
    } else {
      document.addEventListener('DOMContentLoaded', startObserving, { once: true });
    }
  }
  startObserving();

  /* ------------------------------------------------------------------ *
   * Feature 2 — one-tap confidence toast                                *
   * ------------------------------------------------------------------ */

  const TOAST_CSS = `
    :host {
      all: initial;
      --bg: #fafbf9;
      --raised: #ffffff;
      --line: #e2e7e3;
      --fg: #14171a;
      --muted: #6b7480;
      --accent: #149463;
      --accent-ink: #ffffff;
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
        --warn: #e8c37a;
        --warn-ink: #2b2210;
      }
    }
    * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }

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
      padding: 12px 12px 12px 16px; font-size: 14px;
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
  `;

  const CONFIDENCE_KEYS = { '1': 'knew', '2': 'unsure', '3': 'guessed', '4': 'memorized' };
  const CONFIDENCE_VALUES = new Set(['knew', 'unsure', 'guessed', 'memorized']);

  let toastShadow = null;
  let toastEl = null;
  let toastTimer = null;
  let toastFp = null;

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
        <span class="label">How confident?<span class="seen" id="toastSeen" hidden> · seen before</span></span>
        <div class="btns">
          <button type="button" class="btn" data-val="knew">knew it<span class="k">1</span></button>
          <button type="button" class="btn" data-val="unsure">unsure<span class="k">2</span></button>
          <button type="button" class="btn" data-val="guessed">guessed<span class="k">3</span></button>
          <button type="button" class="btn" data-val="memorized">memorized<span class="k">4</span></button>
        </div>
      </div>`;
    shadow.appendChild(wrap);

    // The toast is built lazily — if its first appearance happens while the
    // player is ALREADY element-fullscreened, mounting outside that subtree
    // makes it invisible and no later fullscreenchange will rescue it. Born
    // inside the fullscreen element when there is one.
    (document.fullscreenElement || document.documentElement).appendChild(host);

    // Same fullscreen ride-along as the tagger: element-fullscreen would hide
    // the toast, and this toast IS the confidence feature during an exam.
    document.addEventListener('fullscreenchange', () => {
      const fs = document.fullscreenElement;
      if (fs && !fs.contains(host)) fs.appendChild(host);
      else if (!fs && host.parentElement !== document.documentElement) {
        document.documentElement.appendChild(host);
      }
    });

    for (const btn of shadow.querySelectorAll('.btn')) {
      btn.addEventListener('click', () => chooseConfidence(btn.dataset.val));
    }

    // Outside-dismiss replaces the old × button: any pointerdown whose
    // composed path doesn't pass through this host clears the toast WITHOUT
    // recording a confidence — moving on with the exam (Udemy's own "Next
    // question" control, clicking anywhere else on the page) dismisses it
    // for free. capture:true so this sees the event before the study site's
    // own handlers can stop propagation; composedPath (not e.target) so it
    // correctly reads a pointerdown on one of the toast's OWN buttons as
    // "inside" — that must fall through to the button's click handler and
    // record a choice, not get raced by this same pointerdown into hiding
    // the toast first.
    document.addEventListener(
      'pointerdown',
      (e) => {
        if (!toastFp || !toastEl || toastEl.hidden) return;
        if (!e.composedPath().includes(host)) hideToast();
      },
      true
    );

    return shadow;
  }

  function ensureToast() {
    if (!toastShadow) {
      toastShadow = buildToastHost();
      toastEl = toastShadow.getElementById('toast');
    }
    return toastShadow;
  }

  function showToast(fp) {
    ensureToast();
    toastFp = fp;
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
    // nothing, so the toast stays until a button, 1/2/3/4, or a pointerdown
    // outside it dismisses it. It stays bound to the fp that spawned it; the
    // next question's outcome simply replaces it via this same function.
  }

  function hideToast() {
    clearTimeout(toastTimer);
    toastFp = null;
    if (toastEl) toastEl.hidden = true;
  }

  function chooseConfidence(value) {
    if (!toastFp || !CONFIDENCE_VALUES.has(value)) return;
    const fp = toastFp;
    const btn = toastShadow.querySelector(`.btn[data-val="${value}"]`);
    if (btn) btn.classList.add('flash'); // accent select flash on tap
    Store.setConfidence(fp, value).catch((e) =>
      console.debug('[Cert Buddy] setConfidence failed', e)
    );
    // Dismiss immediately on tap — the flash gets one short paint before the
    // toast is gone, it doesn't linger.
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, 120);
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
      if (!toastFp || toastEl.hidden) return;
      if (e.altKey || e.ctrlKey || e.metaKey) return; // plain keys only
      const value = CONFIDENCE_KEYS[e.key];
      if (!value) return;
      if (isTypingTarget(e)) return;
      e.preventDefault();
      chooseConfidence(value);
    },
    true
  );
})();
