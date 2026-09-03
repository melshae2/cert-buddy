# Cert Buddy browser test harness

Manual/visual fixtures for exercising the content-script pipeline
(`adapters.js` -> `outcomes.js` -> `tagger.js`) and the popup (`popup.js`) in
a real browser, without needing a live Udemy/Tutorials Dojo account or a
build step. Everything here is a static file loaded via classic `<script>`
tags — no bundler, no npm, no node.

For the OTHER kind of test — pure functions (`fingerprint`, `migrateReason`,
`computePartial`, `detectWeighted`, `sessionize`, ...) with no DOM and no
chrome.storage — see `../test.html` instead. That suite is self-contained
and unrelated to this directory; open it directly, no server needed.

## Serving

Everything here resolves paths as `../../src/...`, so the server root MUST
be the repo root, not this directory:

```sh
cd /path/to/cert-buddy
python3 -m http.server 8000
```

Then open fixtures under `http://localhost:8000/tests/harness/<file>.html`.

## THE CACHE LESSON (read this before debugging a "why didn't my change show up")

Two independent things get cached by the browser, and bumping only one of
them has burned multiple sessions on this project:

1. **The script tags.** Every fixture loads `mock-chrome.js`, the `src/lib/*`
   and `src/content/*` (or `src/popup/*`) files with a `?v=2101` cache-bust
   query param. After editing any of those SOURCE files, bump that version
   number on every `<script src="...?v=2101">` tag that loads it (or just
   bump `2101` -> a new number everywhere in the fixture you're testing —
   don't leave a stale value on some tags and not others).
2. **The document itself.** The fixture `.html` page you're looking at is
   ALSO cached by the browser as a plain page fetch, independent of its
   `<script>` tags' own cache-busting. Bumping only the script `?v=` while
   reloading the SAME page URL can still serve you a stale cached copy of the
   `.html` document itself (with its old inline JS, old markup, etc.) —
   append a fresh unique query param to the PAGE url too, e.g.
   `td.html?v=2101&r=2` (bump `r` again after your next edit), or hard-reload
   (shift-reload / disable cache in devtools) instead.

If a fixture "isn't picking up" a change you just made, suspect #2 first —
it's the one that looks like nothing changed even though the file on disk is
definitely right.

## Fixtures

### `mock-chrome.js`
Not a page — a shared script every other fixture (except `popup-harness.html`,
which loads it the same way) includes first. Fills in `chrome.runtime`
(`getURL`, `lastError`, `onMessage.addListener`) and a promise-based
`chrome.storage.local` (`get`/`set`/`remove`/`clear`) plus
`chrome.storage.onChanged`, backed by an in-memory object exposed as
`globalThis.__certBuddyMockStorage` (inspect it from the devtools console at
any time), **wherever those are missing** — see "real `window.chrome`" under
Deviations below for why it's "fill in what's missing" and not "only if
`window.chrome` is absent". Deliberately installs **no** `chrome.tabs` and
**no** `chrome.scripting` — that absence is itself the test for popup.js's
`checkActiveTab()` feature-detection (see below).

### `exam.html` — Udemy REVIEW-mode fixture
A finished practice-exam review page: the question is already answered, one
wrong option and the right option are both marked via Udemy's hashed
`answer-result-pane--{correct,incorrect}--XXXXX` class convention, and
`[data-purpose="answer-result-header-user-label"]` marks which one was
yours. Exercises `udemyAdapter.extract()`'s three-layer row lookup, its
`stemAbove()` walk (the `#questionBlock` wrapper is what makes the walk stop
at `[data-purpose="question-content"]` instead of climbing to the page's own
`<h1>`/`.controls`), and the sidebar-exclusion half of `inNav()`/`NAV_SEL`
(the `aside.sidebar` decoy). Click **Show result** to swap in a freshly
INSERTED `#resultBanner` (a real `addedNodes` mutation, matching how Udemy's
own SPA player actually reveals the banner) and watch `outcomes.js`'s
`BANNER_RE` / `collectCandidates` path log an outcome — open the tagger
panel (Alt+M or the launcher badge) or the devtools console
(`chrome.storage.local.get(null)` or `globalThis.__certBuddyMockStorage`) to
confirm it landed.

### `practice-live.html` — Udemy PRACTICE-mode fixture
The question loads with nothing answered yet — no result classes, no user
label — so you see the "before" state adapters.js has to work from mid-test,
not just the finished review page. `window.__certBuddyPreSubmitSelectors =
['#btnCheck']` points `outcomes.js`'s pre-submit gate at the harness's own
Check button — but the gate only actually ENGAGES in `'deep'` capture mode
(see "Capture mode: quick vs deep" below); on the default `'quick'` mode a
click on **Check answer** goes straight through with no toast at all. Click
**Switch to deep mode** first if you want to see the gate: then clicking
**Check answer** is intercepted by the "how sure?" toast (this is the
intended interaction in deep mode, not a bug — answer the toast, or click
its own × to skip, and the underlying reveal handler fires via the gate's
synthetic re-click). Either way, once the reveal handler runs, the row
classes/user-label are patched in and, after a 150ms `setTimeout` (standing
in for Udemy's real check-answer XHR), a fresh `#resultBanner` node is
inserted — a real `addedNodes` mutation for `outcomes.js` to catch. In deep
mode this confirms the gate -> release -> reveal -> banner-detection chain
end to end, and that a rating collected PRE-reveal (`confAt: 'pre'`) gets
correctly joined onto the outcome once it fires; in quick mode it confirms
the same banner-detection path with no pre-rating (`confAt: null`, the
today's-flow post-toast shows instead).

### `td.html` — Tutorials Dojo (wpProQuiz) REVIEW-mode fixture
Four sibling `.wpProQuiz_listItem` question blocks (`#q1`-`#q4`) sit in the
DOM at once, exactly like the real portal keeps every question in a review
set mounted with only one shown via a `display` toggle — the same
stale-hidden-sibling trap `tdVisibleBlock()` exists to solve. `#q1`/`#q3`
are permanently-hidden decoys whose stems are prefixed `STALE QUESTION` so
any leak into a live extraction is obvious immediately. `#q2` (visible by
default, single-select radios) and `#q4` (checkboxes, shown via **Show
multi-select question (Q4)**) are the two real ones, deliberately using the
TWO DIFFERENT wpProQuiz question-numbering markup shapes so both branches of
`parseQuestionNumber`'s priority order get exercised: Q2's own stem carries
a `"Question 41:"` marker that must win over its sibling
`.wpProQuiz_question_page`'s conflicting `"19. Question"` text; Q4's stem
carries no marker at all, so its number can ONLY come from
`.wpProQuiz_question_page`'s `"Question 12 of 65"` text (the other wpProQuiz
variant). A `.wpProQuiz_reviewDiv` review-grid decoy sits outside the
question list to exercise `NAV_SEL`'s wpProQuiz-specific entries.

Click **Run adapter assertions** to run an in-page PASS/FAIL check (mirrors
`../test.html`'s style, but exercises the real DOM-reading path
`CertBuddyAdapters.extract()` + `CertBuddyStore.computePartial()` instead of
calling internals directly) — results render into `#resultsOut` and land on
`window.__tdSummary = {pass, fail}` for scripted checks (13/13 pass against
the current source). **Reveal Q2/Q4 answer** toggle the (initially
`display:none`, no stylesheet override — clearing the inline style alone
makes them visible) wpProQuiz feedback boxes, which is what `outcomes.js`'s
ATTRIBUTE-mutation path (as opposed to the `addedNodes` path the Udemy
fixtures use) watches for via `IS_TUTORIALS_DOJO` +
`wpProQuiz_correct`/`wpProQuiz_incorrect` class tokens. Both reveal buttons
are ALSO submit-gate targets (`__certBuddyPreSubmitSelectors`), so — same as
`practice-live.html`'s Check button — they only actually go through the
gate-toast-then-release flow in `'deep'` capture mode; click **Switch to
deep mode** first if you want to see it (see "Capture mode: quick vs deep"
below). `__certBuddyForceTutorialsDojo = true` is what makes any of this
engage at all on `http://localhost` — it's the harness-only escape hatch
documented directly in `adapters.js`/`outcomes.js`'s own comments, never set
on a real page.

### `popup-harness.html` — popup.js under the mock
Fetches the REAL `src/popup/popup.html`, extracts its `<body>` markup
(stripping its own `<script>` tags, since their paths are relative to
`src/popup/` and would 404 mounted here), injects it into `#popup-mount`,
loads `popup.css` for real styling, then sequentially loads
`store.js`/`taxonomy.js`/`theme.js`/`popup.js` so the ACTUAL shipped popup
code runs, against the mock `chrome.storage.local` from `mock-chrome.js`.
`window.__popupHarnessReady` flips `true` on success;
`window.__popupHarnessError` (and a console.error) on any failure.

Because `mock-chrome.js` installs no `chrome.tabs`/`chrome.scripting`,
loading this fixture with no query params exercises popup.js's
feature-detection directly: `checkActiveTab()` guards on
`globalThis.chrome && chrome.tabs && chrome.tabs.query` and returns early,
so the popup loads clean with the "Not on Udemy" bar simply never appearing
— confirmed by reading popup.js (`if (!(globalThis.chrome && chrome.tabs
&& chrome.tabs.query)) return;`). Note this guard is local to
`checkActiveTab()`; the `#expand` button's own click handler calls
`chrome.tabs.create(...)` unconditionally and WOULD throw if clicked with no
`?tabUrl=` seeding `chrome.tabs` — don't click "open in a full tab" (⤢) on
an un-seeded load.

**Query params:**
- `?tabUrl=<url>` — installs a fake `chrome.tabs.query`/`chrome.scripting.executeScript`
  so `checkActiveTab()` sees an "active tab" at `<url>`, letting you exercise
  the "Not on Udemy — Enable logging here" bar. Try a non-Udemy,
  non-Tutorials-Dojo URL, e.g.:
  `popup-harness.html?tabUrl=https%3A%2F%2Fexample.com%2Fquiz`
- `?seed=<json>` — a `encodeURIComponent()`-wrapped JSON object for the WHOLE
  `certbuddy.v1` storage record (same shape `Store.getAll()` returns:
  `{version, misses, outcomes, backups, settings}`), written before
  `popup.js` loads so the dashboard renders real data instead of the
  first-run empty state. Smallest useful seed, one miss:
  ```
  {"version":2,"misses":[{"id":"seed1","ts":1735689600000,"host":"udemy.com","url":"","exam":"SAP-C02","question":"Example seeded question text long enough to fingerprint","yourAnswer":"A","correctAnswer":"B","yourAnswers":["A"],"correctAnswers":["B"],"selectCount":1,"topics":[],"reason":"","notes":"","fact":"","disc":"","attempts":[1735689600000],"fp":"seedfp1","rights":[],"triaged":false,"shaky":false,"confidence":null,"confNum":null,"confAt":null,"qnum":null,"qtotal":null,"seconds":null}],"outcomes":[],"backups":[],"settings":{"autoTag":true,"hiddenHosts":[],"lastExportAt":0}}
  ```
  Build the URL with `encodeURIComponent(JSON.stringify(seed))` from a
  console, don't hand-encode it.

## Capture mode: quick vs deep

v0.21.0 added a capture-mode SETTING (`Store.getMode()`/`setMode()`,
`settings.mode` in the `certbuddy.v1` blob, default `'quick'`) that
`outcomes.js`'s pre-submit gate itself now checks before ever engaging:
`onDocumentClickCapture` reads it and does `if (mode !== 'deep') return;`
right before the `preventDefault()`/`stopImmediatePropagation()` that would
otherwise block the click. In other words: **on a fresh/unseeded store (the
default you get on every reload of these fixtures, since `mock-chrome.js`'s
storage is a fresh in-memory object per page load), the pre-submit gate
never shows at all** — `#btnCheck` (`practice-live.html`) and
`#btnRevealQ2`/`#btnRevealQ4` (`td.html`) all go straight through to their
real click handlers on the very first click, with no toast in between.

Both fixtures have a **Switch to deep mode** button that calls
`CertBuddyStore.setMode('deep')` and updates a small `#modeStatus` readout —
no reload needed, since `outcomes.js` keeps its own `mode` variable live via
`chrome.storage.onChanged` (real in the extension; faithfully mocked here,
see `mock-chrome.js`'s `fireChanged`). Click it BEFORE clicking a gated
button if you want to see the "how sure?" pre-toast; otherwise you'll see
(correctly!) the reveal happen immediately with no gate — that's `'quick'`
mode doing exactly what it's designed to do, not a broken fixture.

## Deviations from the literal spec, and why

- **Real `window.chrome`, not `undefined`.** The spec describes
  `mock-chrome.js` as "Defines `window.chrome` (only if absent)". A LITERAL
  `if (window.chrome) return` — this file's actual first draft — breaks in
  every real Chromium-based browser (confirmed via the Browser pane used to
  verify this harness): Chrome exposes a native `window.chrome` global on
  EVERY page, extension or not, typically an empty `{}` with no
  `.storage`/`.runtime.getURL` at all. Bailing out on that truthy-but-empty
  object left `chrome.storage` undefined and every content script's first
  `chrome.storage.local.get(...)` threw `TypeError: Cannot read properties
  of undefined (reading 'local')` — caught live via `read_console_messages`
  on `exam.html`, not from reading the source. Fixed by checking the
  SPECIFIC api surface each piece provides (`root.storage.local.get` being
  a function, etc.) and filling in only what's missing, so a genuinely
  working `chrome.storage.local` (the "loaded as a real unpacked-extension
  content script" case "only if absent" was presumably meant for) still
  wins over the mock. See the file's own header comment for the full
  explanation.
- **`udemyAdapter` has no localhost override.** `adapters.js`'s
  `tutorialsDojoAdapter.match()` honors `globalThis.__certBuddyForceTutorialsDojo`
  specifically so a local harness can exercise it without a real
  `*.tutorialsdojo.com` origin — but `udemyAdapter.match()` has NO equivalent
  flag, only `/(^|\.)udemy\.com$/i.test(loc.hostname)`. Left alone, on
  `http://localhost` the central `Adapters.extract()` dispatcher silently
  falls through to `genericAdapter` for `exam.html`/`practice-live.html` —
  confirmed live: `adapter: "generic"`, `yourAnswer: ""`, and `question`
  came back as the ENTIRE merged block text (badge words included) instead
  of just the stem, because genericAdapter has no `[data-purpose]`
  awareness at all. Since editing `adapters.js` is out of scope for this
  harness, both Udemy fixtures now include a small inline `<script>` between
  the `adapters.js` and `outcomes.js` `<script>` tags that monkey-patches the
  udemy entry's own `match()` via `CertBuddyAdapters.adapters` (public API,
  "exposed so you can test one from the console" per `adapters.js`'s own
  comment) to always return `true` — the same effect
  `__certBuddyForceTutorialsDojo` has for the TD adapter, applied from
  outside since no such flag exists for Udemy. This is the one place either
  fixture's `<script>` tags don't match the given loading-order list
  literally; it's additive (an extra tag between two spec'd ones), not a
  change to any of the seven listed files, and is fully commented in both
  `exam.html` and `practice-live.html` at the insertion point. Verified
  after the patch: `adapter: "udemy"`, correct stem-only `question`, correct
  `yourAnswer`/`yourAnswers`.
- **`practice-live.html`/`td.html`'s "Switch to deep mode" buttons and
  `#modeStatus` readouts** aren't in the spec's file-by-file description —
  added after discovering the quick/deep capture-mode gate (see above,
  itself a v0.21.0 addition made by a concurrently-editing agent after the
  spec for this harness was written) live-testing the gate flow the spec
  describes. Without them, a reader clicking the "Reveal answer" buttons
  cold would see the button appear to do nothing gate-related and have no
  way to tell whether that's expected or broken.
- **`popup-harness.html`'s status bar** (`#harnessBar`) isn't in the spec's
  file-by-file description — added purely so a human opening the fixture can
  tell "ready" from "error: ..." without opening devtools first;
  `window.__popupHarnessReady`/`__popupHarnessError` (the spec'd signals)
  are still set exactly as described and are what any scripted check should
  actually assert on.
- Everything else matches the spec as given — see the source-reading notes
  inline in each fixture's HTML comments for WHY a given selector/class/
  ordering choice matches what `adapters.js`/`outcomes.js` actually read
  (each fixture cites the exact function/regex it's targeting).

## Things in the source that would silently defeat a fixture

All of these were actually hit and fixed while building this harness (see
Deviations above for the first two) or found while reading — listed here so
a future source change doesn't reopen them silently.

- **The quick/deep capture-mode gate** (see its own section above) — the
  single biggest "why isn't the gate showing" trap. A fixture (or a person)
  that doesn't know about `'quick'` being the default would watch
  `#btnCheck`/`#btnRevealQ2`/`#btnRevealQ4` fire their reveal handler
  immediately and could easily read that as "the gate selector doesn't
  match" rather than "the gate is correctly declining to engage."
- **`udemyAdapter`'s missing localhost override** (see Deviations above) —
  without the monkey-patch, `exam.html`/`practice-live.html` would silently
  test `genericAdapter`'s behavior while APPEARING to test `udemyAdapter`
  (same page, same fixture, same intent — just the wrong code path
  underneath), which is a much easier failure mode to miss than an outright
  error.
- **A real (non-mock) `window.chrome`** (see Deviations above) — any harness
  in this codebase (present or future) that assumes `window.chrome` is
  `undefined` outside an extension context, on any real Chromium browser,
  will silently skip installing `chrome.storage`.
- `outcomes.js`'s pre-submit gate (`onDocumentClickCapture`) matches
  `__certBuddyPreSubmitSelectors` against `e.target.closest(sel)` in the
  CAPTURE phase and, on a match (and only in `'deep'` mode — see above),
  calls `stopImmediatePropagation()` before the click ever reaches the
  button's own listener. That means a fixture's own "reveal the answer"
  click handler on a gated button does **not** run on the user's actual
  first click in deep mode — only on the SYNTHETIC `el.click()` the gate
  re-dispatches once its toast is resolved (answered or skipped via ×). A
  fixture that expected its reveal logic to run immediately on click, with
  no gate in between, would see nothing happen in deep mode and could
  easily be mistaken for a broken selector rather than "the toast is
  waiting for input."
- `tutorialsDojoAdapter` sets `noGenericBackfill: true`, so on `td.html` a
  field the adapter itself leaves blank is NEVER filled in by
  `genericAdapter`'s document-wide heuristics (unlike Udemy's adapter, which
  does get generic backfill after the match-patch above puts it in play). A
  `td.html`-style fixture with a genuinely empty stem or option list would
  surface that field as permanently blank in the merged `extract()` result,
  not silently patched over.
