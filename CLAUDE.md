# AI Mixing Engineer — M4L device

An objective mixing-analysis device for Ableton Live: a Max for Live device captures audio + session
state, computes measurements, and an LLM interprets them for the user. **Prime directive: never send the
AI an inaccurate number** — the model has no ears and will confidently repeat a wrong measurement.

## Architecture: Max → JS → AI
- **Max DSP** (`device/`): `plugin~` taps feed `mc.poly~` focus voices; each voice's
  `spectrum_analyzer_focus_N.maxpat` (a `pfft~` subpatch) writes per-bin magnitude (+ now L/R
  cross-spectrum) into named `buffer~`s declared in `focus_chain_N.maxpat`. A `128n` transport-synced
  metro drives snapshots. Master has its own time-domain path (peakamp~/true-peak, K-weighted LUFS via
  `average~`+`snapshot~ 100`). 8 focus voices max (plugin~ channel cap — adding more needs a device re-save).
- **`device/live_query.js`** (~2600 lines, Max `js` object, pre-ES6 syntax): all measurement/DSP — FFT
  spectra, LUFS/BS.1770, masking (Moore-Glasberg), transients (GMaudio differential-EMA), calibration,
  mono-compat. Reads the buffers each snapshot; emits results to the browser bridge (chunked, 8000-char
  chunks — the bridge drops single messages >~30 KB).
- **`docs/` JS** (served to the device, no-cache): `anthropic.js` (the `SYSTEM_PROMPT`), `compress.js`
  (payload compaction), `tools.js` (tool surface), `extraction.js`, `max_bridge.js`.

## The docs/ folder — read these first
- **`docs/MIXING_SPEC.md`** — THE canonical living spec: every measurement, constant, threshold, tool,
  and the **§14 architecture redesign** (online AR masking-depth, phase/coherence pipeline, ducking,
  killing time_series) with §14.8 corrections and §14.9 implementation status. **Start here.**
- `docs/ARCHITECTURE_AUDIT.md` + `docs/ARCHITECTURE_AUDIT_2.md` — adversarial audits of the redesign.
- `docs/EXPERT_REVIEW.md` — expert mixing review of the original metrics.
- `docs/MAX_SIDE_TODO.md` — Max-editor tasks for the user (LUFS shelf was added; SR-48k; phase taps).

## Hard rules (do not violate)
1. **Update `docs/MIXING_SPEC.md` in the SAME change** as any measurement/constant/threshold/tool edit.
2. **Keep `docs/anthropic.js` (SYSTEM_PROMPT) and `docs/prompt_draft.txt` byte-identical** except
   anthropic.js escapes backticks (`\``). Every prompt edit goes in both.
3. **Session must run at 48 kHz** — K-weighting biquads + LUFS `average~` windows are hardcoded for 48k.
   JS warns via `lufs.sr_note` if not. (Project memory: `project_mixing_device_48k`.)
4. **The user ALWAYS reloads the device** — never ask "did you reload"; assume latest on-disk code is live.
   For the `.maxpat` edits, the user must **SAVE the device in the Max editor** to commit them.
5. **Tools return raw measurements only** — no verdicts/labels/recommendations in JS/Max; the LLM interprets.
6. **Focus taps are PRE the parent group's chain** (child Post Mixer). The prompt's CHAIN CHECK makes the
   AI reason about the group chain's effect (filters/saturation/dynamics) as an estimate. Group EQ filter
   corners ship inline as `eq` on `focus_group_chains` devices (don't make the AI call get_device_params for them).
7. Default to floating Anthropic model aliases (no version pinning) unless asked.

## Current status (2026-06-08)
- ✅ **Step 1 BUILT — per-band mono-compatibility.** Max: cross-spectrum poke~ in all 8
  `spectrum_analyzer_focus_N.maxpat` → `focus_N_reLR`/`imLR` buffers (in `focus_chain_N.maxpat`). JS:
  `focusMonoAccum` + `computeMonoCompat()` → `mono_compat` field. **User must save+reload the device.**
- ✅ **Step 2 BUILT — between-element phase cancellation.** Max: complex-mid poke~ in all 8 analyzers →
  `focus_N_reM`/`imM` buffers. JS: `focusMidPow` (Σ|M|²) + `focusPairAccum` (pairwise cross-spectrum) +
  `computeBetweenPhase()` → `phase_cancellation = {"A↔B":[{hz,cancel_db,phase_deg,coherence}]}`. ALL
  unordered pairs (kick/bass may be in any voice). Cross-spectrum accumulated in JS (in-process buffer
  reads, no bridge) — 2 poke~/voice, not O(N²) Max chains. Coherence>0.5 gate is the safeguard; C4
  delay-comp deferred (delayed pairs abstain → safe, never false-clear). **User must SAVE+reload.**
- ⏳ Masking-depth redesign (C1), streaming transients/ducking (C2/C3), AR per-band followers, α-from-dt
  — all designed in §14, **pending a clean re-audit before building**.

## Verify after editing
```bash
node --check device/live_query.js                 # JS syntax
cp docs/anthropic.js /tmp/a.mjs && node --check /tmp/a.mjs   # prompt (ESM) syntax
# .maxpat edits: confirm JSON still parses
node -e 'JSON.parse(require("fs").readFileSync(process.argv[1]))' device/spectrum_analyzer_focus_1.maxpat
```
`.maxpat`/`.amxd` are JSON; `.bak`/`.bak2` are backups. `device/focus_debug.txt` is a ground-truth dev
log (`flog()` writes it) — read it directly to see what a capture actually did.

## Gotchas
- Bridge drops messages >~30 KB → results are chunked (`sendChunked`). Keep payloads modest (cost target
  <$0.10/query); biggest costs are per-voice spectrum + masking pairs.
- `SAMPLE_RATE` is re-read at capture start (`refresh_samplerate`) — a stale 44.1k load-time value
  mislabels spectrum frequencies AND fires a false 48k warning.
- Decimation (no bulk-read, >3 voices) changes frame spacing → EMA α must be rescaled (`adjAlpha`).
- The user goes by "Palace" for public/music work; blur private company names in deliverables.
