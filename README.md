# cert_buddy

A Chrome extension that tracks the practice-exam questions you miss, tagged in
place while you study. Built for AWS SAP-C02 prep on Udemy; the taxonomy is
swappable.

**Design rules the whole thing follows:** capture and learning are separate
moments — flag a miss in ~3 seconds mid-exam, learn from it later, clustered by
topic, never question-by-question. Local-only: no backend, no login, no sync.
When in doubt, less UI.

## Install

1. `chrome://extensions` → **Developer mode** on → **Load unpacked** → select
   this folder
2. Pin the icon. Reload the extension (⟳ on its card) after any code change,
   then reload the study tab — content scripts inject at page load.

Runs automatically on `udemy.com` only. On any other site, the popup offers
**"Enable logging on this page"** (one-time, per-tab, via activeTab).

## During a practice set

**Miss a question →** press **⌥M** (Option+M; Alt+M elsewhere) or click the
**⚑ Log miss** badge. The compact panel auto-captures the question, your
answer, the correct answer, topics, and the stem *discriminator* (the
"MOST cost-effective" / "LEAST operational overhead" phrase the question turns
on). You supply exactly one required tap and one optional sentence:

- **Why you missed it** (required, ⌥1/⌥2/⌥3): `never learned` /
  `knew it, couldn't recall` / `misread` — each routes to a different fix
  (study / spaced review / technique)
- **"Why did you get this wrong?"** — one honest sentence, optional
- **guessed it (got it right)** toggle — for lucky guesses: score says pass,
  knowledge says miss
- **⌘Enter** saves. "save without reason" escape-hatch marks it untriaged.
- **Expand** reveals the full form (edit answers/topics, fact to memorize, exam)

Auto-tagging is suggest-and-veto: solid chips are applied (topic scored in the
correct answer or two fields), dashed **+chips** are one-tap suggestions.

**Answer any question →** the outcome is logged passively (see below); a small
toast asks `knew it (1) / unsure (2) / guessed (3)` — tap or keypress, or
ignore it (auto-dismisses, 8s).

## After the set — the debrief

Open the popup. Misses logged within 90 minutes group into a **session**; the
debrief card shows them clustered by topic ("4 misses → 2 topics") with your
one-line notes lined up under each cluster. Review cluster-by-cluster, add a
fact or reason where it earns it, **mark cluster reviewed**. The card retires
when everything's triaged.

Below it:
- **Focus card** — top 3 topics by recency-weighted misses (14-day half-life),
  your notes quoted under each; a **Memorize** list built from your logged
  facts; **Stubborn questions** (missed 3+, no right since) with retake links;
  a warning when several recent misses turned on the same discriminator
- **Weak areas** — attempt-weighted topic ranking (top 6, expandable), plus
  collapsed "why you miss them" and "what questions turn on" breakdowns
- **Recent** — every record, searchable, inline-editable, with repeat/guessed/✓
  pills. **✓ got it right** on retakes cools the topic and graduates the
  question; re-missing a conquered question flags **REGRESSION**
- **Data** — export/import JSON, snapshots, delete-with-undo

## Data model (schema v2)

One key in `chrome.storage.local`: `certbuddy.v1`.

- `misses[]` — id, ts, attempts[], rights[], fp (question fingerprint), exam,
  host/url, question, yourAnswer, correctAnswer, topics[], reason, disc,
  notes, fact, confidence, triaged, shaky
- `outcomes[]` — passive per-question log: fp, questionSnippet, outcome
  (`correct`/`incorrect`), confidence, exam, ts, attempts[], url. Written
  automatically when a result banner is detected; deduped by fingerprint,
  first outcome wins. Gives per-topic accuracy denominators.
- `backups[]` — last 3 daily in-storage snapshots (guards against corruption,
  not profile wipe). A JSON export auto-downloads weekly; **export is the only
  real backup.**

Legacy records migrate on read (old 7-bucket reasons → 3, missing fields
backfilled). Import merges by id/fp; re-importing the same file is a no-op.

## How extraction works (and how to fix it when Udemy changes)

`src/content/adapters.js`. The Udemy adapter matches semantic hooks — never
exact hashed class names: `[data-purpose="answer"]`, `data-purpose`
attributes, class *tokens* like `--correct--`, then visible badge text as a
fallback, then generic heuristics. Hard-won rules encoded there:

- the question sidebar carries every question's full text and per-question
  Correct/Incorrect labels — everything is filtered through a nav/footer
  exclusion first
- the page wrapper has "sidebar" in its class name — a container *holding* the
  answer rows is never treated as nav
- only **visible** elements can anchor extraction — the SPA keeps previous
  questions in the DOM, hidden, and document-order anchoring reads stale
  questions (and mis-attributes outcome fingerprints)
- checked inputs are sidebar filters, not answers; options aren't radios

The panel header shows which path ran (`via udemy adapter · v0.10.1`). If it
ever shows `+generic(...)`, a field fell back to guessing — run
`CertBuddyAdapters.extract()` in the console (context dropdown → Cert Buddy)
and tighten selectors against what you see. Highlighting text before ⌥M always
overrides detection.

## Retargeting another cert

Replace `TOPICS` in `src/lib/taxonomy.js` (id, label, category, aliases) and
optionally `DISCRIMINATORS`. Nothing else hardcodes AWS.

## Deliberately not built

- Spaced repetition — `fact` + `attempts[]` + `confidence` are the scheduling
  inputs, waiting on enough real data
- Any backend/sync — gated on: weeks of real use → a friend uses it unprompted
  → someone asks for sync

## Files

| Path | Job |
| --- | --- |
| `manifest.json` | MV3; permissions: storage, scripting, activeTab; udemy.com only |
| `src/lib/store.js` | storage, fingerprint dedupe, sessions, focus ranking, outcomes, backups |
| `src/lib/taxonomy.js` | topics + aliases, weighted auto-tagger, reasons, discriminators |
| `src/content/adapters.js` | page extraction (question/answers/discriminator) |
| `src/content/outcomes.js` | passive outcome logging + confidence toast |
| `src/content/tagger.js` | ⌥M compact capture panel (shadow DOM) |
| `src/popup/` | dashboard: debrief, focus card, weak areas, recent, data |
