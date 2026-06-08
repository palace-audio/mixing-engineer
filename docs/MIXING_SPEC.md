# Mixing Engine Spec — Measurement & Constant Reference

> **Purpose:** a complete, expert-reviewable inventory of every measurement, algorithm, and constant the device computes. Intended for a mixing engineer to red-team: *overkill / underkill / missing / unnecessary / wrong constant*.
>
> **LIVING DOCUMENT — rule:** every new measurement, constant, threshold, or tool added to the code MUST be added here in the same change. No silent additions.
>
> **Locations:** `device/live_query.js` (Max `js` object — all DSP-buffer reads + analysis), `docs/tools.js` (LiveAPI tool layer), `docs/compress.js` (payload shaping for the model). "Max DSP" = computed in the `.amxd` patch (filters, FFT, meters) and read by JS; "JS" = computed in `live_query.js`.
>
> **Review-flag legend:** 🚩 = I want an expert opinion on this specific choice.

---

## 0. Architecture in one paragraph

Audio is tapped non-destructively (no soloing) via routed `plugin~` channels into per-track `poly~` voices, each running a `pfft~` that pokes magnitude spectra into global buffers. A transport-synced metro (128th-note) drives `snapshot` functions in JS that read those buffers and accumulate. **Single source of truth:** focus-track level, spectrum, and transients all derive from the FFT path; the master bus additionally has its own time-domain peak/RMS/true-peak/LUFS chain. After capture, JS computes loudness, spectral, stereo, masking, and transient metrics and returns them to the model.

---

## 1. Signal acquisition & global constants

| Constant | Value | Where | Notes / 🚩 |
|---|---|---|---|
| `FFT_SIZE` | 4096 | live_query.js:9 | pfft~ window. ~93 ms @ 44.1k. |
| `NUM_BINS` | 2048 | :10 | FFT_SIZE/2. Linear bin width = SR/4096 ≈ **10.8 Hz** @ 44.1k. 🚩 sub-bass resolution: only ~7 linear bins below 100 Hz before log-binning. |
| `SAMPLE_RATE` | 44100 (or device) | :13 | Re-read on demand. |
| `FRAME_DT_BEATS` | 0.03125 (1/32 beat) | :24 | Must match `.amxd` metro = `128n`. Frame rate is tempo-locked, not time-locked. |
| pfft~ overlap | 4 | focus_chain abstractions | Hann window assumed. 🚩 window function not explicitly verified. |
| `NUM_FOCUS_VOICES` | 8 | :221 | Device exposes channels for this many parallel taps (after device save committed I/O). |
| Capture length cap | 8 bars (focus) | tools.js:318 | Master-only spans to next locator, uncapped. |
| Log-bin grid (master) | 20 Hz–20 kHz, **1/12 octave**, ~119 bins | :1464 `buildLogBins(12)` | center = geometric mean. Master spectrum only — fine tonal-balance reading. |
| Log-bin grid (focus/ref/masking) | 20 Hz–20 kHz, **1/6 octave**, ~60 bins | :1465 `LOG_BINS_FOCUS = buildLogBins(6)` | Focus voices + reference + the masking model. 1/6-oct ≈ 1 ERB up high, finer than 1 ERB down low — psychoacoustically sufficient. ~½ the per-voice payload (the dominant cost line, ×voice count). |

---

## 2. Loudness metrics (master bus only)

K-weighting filter is in **Max DSP**; JS receives K-weighted mean-square (`kms_*`) blocks and integrates per BS.1770-4 / EBU R128. **Verified patch chain (2026-06-07):** `biquad~ → *~ (square) → average~ → snapshot~ 100 → kms_*`. `average~ 19200` = 400 ms @48k (momentary/integrated), `average~ 144000` = 3 s @48k (short-term); `snapshot~ 100` = 100 ms hop (BS.1770 75% overlap). ✓ windowing correct. **⚠ two open issues:** (1) only ONE `biquad~` visible = the RLB high-pass (stage 2); the K-weighting **high-shelf pre-filter (stage 1) appears missing** — biases LUFS low on bright material; (2) coefficients + window lengths are **48 kHz-specific** (at 44.1k, `average~ 19200` = 435 ms and filter corner shifts). See §12 Max-side.

| Metric | Formula / constant | Where | Notes / 🚩 |
|---|---|---|---|
| Block loudness | `-0.691 + 10·log10(msL + msR)` | live_query.js:1735 | BS.1770 block. Block = 400 ms K-weighted MS (`kms` buffers, `average~ 19200`). |
| **Max-Momentary LUFS** (MaxM) | **loudest 400 ms block** in the section | :1741 (master), :2155 (sidechain) | Field `momentary_max_lufs`. Changed 2026-06-07 from "single block" → loudest block (EBU MaxM). A single momentary value is a real-time-meter concept, meaningless offline; the loudest moment is the useful section stat (perceived-loudness peak, ≠ true peak). |
| **Max-Short-term LUFS** (MaxS) | **loudest 3 s block** in the section | :1790 (master), :2191 (sidechain) | Field `short_term_max_lufs`. Changed 2026-06-07 from "most recent 3 s" → loudest (EBU MaxS). LRA still uses the full short-term distribution. |
| Integrated LUFS | absolute gate **−70 LUFS**, then relative gate **−10 LU** below ungated mean | :1748, :1757 | BS.1770 two-stage gating. ✓ standard. |
| LRA | 95th − 10th percentile of gated short-term; absolute **−70** gate + relative **−20 LU** below mean | :1779, :1798 | EBU R128 Tech 3342. ✓ standard. |
| True peak | **4× oversampled** per channel (Max `poly~ up 4`), max L/R | :29, :1823 | dBTP. ✓ meets BS.1770 ≥4× rule. |
| PLR (peak-to-loudness) | `true_peak_db − integrated_lufs` | :1773 | Higher = more dynamic. |
| Crest factor | `peak_db − rms_db` (time-domain) | :1802 area | Master only. |

---

## 3. Level metrics

| Metric | Source | Where | Notes / 🚩 |
|---|---|---|---|
| Master peak | `peakamp~` (time-domain) | Max + :144 | True windowed peak. |
| Master RMS | `average~`→`snapshot~` (time-domain) | Max + :146 | |
| Focus `rms_avg` | mean of per-frame FFT RMS = `sqrt(mean(\|bin\|²))` | :2320 area | dBFS via calibration (§8). |
| Focus `rms_max` | loudest single frame's FFT RMS | same | **NOT a true sample peak** — ~93 ms frame-RMS max. 🚩 inherent limit: focus voices have no true/inter-sample peak; only master does. |
| Track meter dB | Live perceptual `output_meter_*` → `meterToDb` | :1397, :1403 | Instantaneous single-sample read; **not section-accurate** — used only for "is it live" checks. 🚩 unreliable for level/stereo; do not present as measurement. |

---

## 4. Spectral metrics

| Metric | Formula / constant | Where | Notes / 🚩 |
|---|---|---|---|
| Per-band magnitude (`m`) | FFT magnitude averaged into 1/12-oct log bins, dB | :2258 bandEnergyDb | Mid channel = (L+R)/2. |
| Stereo width per band (`sm`) | `side_db − mid_db`, S=(L−R)/2 | :2202 area | Calibration-offset cancels (it's a difference). |
| Spectral centroid | magnitude-weighted mean freq of mid spectrum (Hz) | :1870 | Brightness proxy. |
| Spectral flux | Σ positive bin-to-bin magnitude diffs (mid) **÷ frame total magnitude**, per-frame, averaged | :41, :534 | ✓ NORMALIZED 2026-06-07 — now a level-independent 0..1 "spectrum-change" descriptor, comparable across captures. Master/sidechain only. |
| Band split (transients) | sub 20–300 Hz, mid **300–3000 Hz** (body), high **3000–20000 Hz** (attack click) | :433–438 | Crossover moved 5k→3k 2026-06-07 so "high" carries the transient edge (hat/cymbal/snare click). 🚩 still 3-band — no separate low-mid/presence. |

---

## 5. Stereo / phase

| Metric | Formula | Where | Notes |
|---|---|---|---|
| Stereo correlation (master) | Pearson per-snapshot (`crossLR / (rmsL·rmsR)`), then averaged across snapshots | :1620 | −1..+1. Explicitly per-frame-then-mean (mean-of-ratios), not ratio-of-means (correct choice, noted in code). |
| Phase block | `mid_rms_db`, `side_rms_db`, `side_minus_mid_db` | :1789 area | Negative side−mid = mono-dominant. |
| Focus `width_ratio` | `sqrt(Σ side² / Σ mid²)` linear, per voice | :analyzeFocus | **NEW 2026-06-07** — 0.00 = truly mono (a measurement, not missing data), →~1 = decorrelated/wide. Disambiguates real mono from null. Per-band width is still `spectrum.sm`. |

---

## 6. Masking — Moore-Glasberg psychoacoustic model

The headline analysis. Computed pairwise across all focus voices (masker → signal).

| Element | Formula / constant | Where | Notes / 🚩 |
|---|---|---|---|
| ERB scale | `z(f) = 21.4·log10(0.00437·f + 1)` over the 1/6-oct focus grid | :1471 `LOG_BIN_FOCUS_ERB` | Glasberg & Moore 1990. ✓ |
| Spreading fn (upward, Δerb≥0) | `slopeUp = −(22 − 0.2·max(0, Lm+40))`, floored at −6 dB/ERB; `max(slopeUp·Δerb, −100)` | :1481 mgSpreadDb | **Level-dependent 2026-06-07**: base −22 dB/ERB at −40 dBFS, shallowing 0.2/dB as the masker gets louder (loud bass masks mids/highs upward). |
| Spreading fn (downward, Δerb<0) | `max(27·Δerb, −100)` dB | :1488 | Steep low-side, level-independent. Direction is correct (upward spread of masking). |
| Threshold curve | per signal bin, **power-sum** of masker excitations: `thrLin += 10^(v/10)`, then `10·log10` | :1497 mgThresholdCurve | **Additive masking 2026-06-07** (was `max()`, which under-estimated by several dB in a dense mix). |
| Signal floor | `lufs_integrated − 40` dBFS | :2274 | Bins below = absent (filter rolloff, not content). 🚩 the −40 is a chosen heuristic; consider −45 for sparse/ambient (genre-keyed, open). |
| Absent-band skip | skip bin if `sig < threshold − 40` | :1519 | Tightened −60→−40 2026-06-07: a signal 40+ dB under the masking threshold was never a contender there (e.g. a ride's trace sub vs a kick) — reporting it as "masked" is noise. Keeps real masking (worst margins ~−15 to −35). |
| **Relevance band** | skip bin if `sig < (signal's own loudest band − **25 dB**)` | :1505 RELEVANCE_RANGE | Tightened 30→25 2026-06-07 (a track's body is within ~25 dB of its loudest band; 30 let in rumble/air). |
| Masked / audible threshold | margin = `sig − thr`; masked ≤ **−3 dB**, audible ≥ **+3 dB** | :1522 | ±3 dB dead-zone in between. |
| **Time co-occurrence gate** | `cooccur` = (frames both active) / (signal active frames); "active" = within 20 dB of own peak. If `cooccur < 0.3` → bands suppressed (pair dropped) | :1545 cooccurrence, :1535 gate | **NEW 2026-06-07** — masking is simultaneous; non-overlapping elements no longer over-report. `cooccur` attached to emitted pairs. |
| Verdict string | **REMOVED 2026-06-07** | — | Per "tools return raw, LLM interprets" ([[feedback_no_interpretation_in_tools]]). The model classifies heavy/partial/clean from band counts + margins + cooccur. |
| Output cap | **6 masked + 6 audible** bands per pair | :1527 | 8→6 2026-06-07 (pairwise is O(N²); per-pair savings multiply). |
| Pair emission | only pairs with ≥1 masked band ship (compress.js) | compress.js:192 | Complementing / non-overlapping / clean pairs dropped; a pair's absence = no significant masking between those two. |
| Self-masking suppression | skip pairs where one track is an ancestor/descendant of the other | `ancestorGroupNames` + analyzeFocus pairwise loop | Added 2026-06-07: a child vs its own parent-group bus (group output contains the child) is incoherent — no longer emitted. |
| EQ effect classification | `eq_bands_active[].effect` = cut / shelf / bell / notch | summarizeEq8Bands | Added 2026-06-07: only `cut` (HP/LP) removes content past its corner; shelf/bell only attenuate/boost. Stops the AI treating a −2 dB shelf as a high-pass and wrongly discounting masking. |
| Transient diagnostic | `focus_diagnostic.voice_N.onsets` = total onsets detected | analyzeFocus | Added 2026-06-07 to distinguish "detection found nothing" from "AI omitted it". |

> ✓ **RESOLVED 2026-06-07** (was the whole-model flag): masking now cross-checks **time-domain co-occurrence** via `cooccur` (see [[feedback_masking_is_temporal]]). It still runs on time-averaged spectra for the frequency overlap, but the co-occurrence gate prevents sparse/alternating elements from over-reporting. The spectral overlap within the co-occurring window is still an average (not per-frame masking), which is an acceptable approximation.

---

## 7. Transient detection — GMaudio differential-EMA (credit: GMaudio Ducker)

Per focus voice, 3 bands, post-capture on per-frame band energies.

| Element | Value | Where | Notes / 🚩 |
|---|---|---|---|
| Algorithm | dual-EMA: `fast` & `slow` envelope; onset when `diff>prevDiff && diff>slow·threshMult && diff>1e-6` | :284 detectOnsets | diff = fast−slow. |
| Sub band (20–300 Hz) | αfast=0.63, αslow=0.031, threshMult=0.5 | :2357 | |
| Mid band (**300–3k**, body) | αfast=0.63, αslow=0.061, threshMult=0.5 | :2358 | crossover 5k→3k 2026-06-07. |
| High band (**3k–20k**, click) | αfast=0.63, αslow=0.118, threshMult=0.5 | :2359 | |
| Frame rate dependence | EMA α tuned for **128n**; rescaled when decimated: `α' = 1 − (1−α)^decimate` | :2351 `adjAlpha` | ✓ FIXED 2026-06-07 — the no-bulk-read decimation path no longer mistunes α (was a silent failure). |
| Master transient density | local maxima `> mean + max(2, 0.8·stdev)` of L time-series, per beat | :1840 | Separate, simpler heuristic than the focus EMA. 🚩 two different transient methods (master vs focus) — inconsistent by design. |

---

## 8. Calibration (FFT → dBFS)

| Element | Formula | Where | Notes / 🚩 |
|---|---|---|---|
| Offset | `fftCalibrationDb = master_timedomain_RMS_dBFS − master_FFT_RMS_dB` | live_query.js (analyzeAudio) | Computed per-capture from the master's dual measurement. |
| Applied to | focus rms_avg, rms_max, spectrum `m`, time_series (NOT `sm` — a difference) | analyzeFocus | 🚩 assumes the FFT↔time-domain offset is a constant property of the transform (true for linear/window scaling); good enough but is an approximation. |

---

## 9. Time series / dynamics

| Element | Value | Where | Notes |
|---|---|---|---|
| Compression | Ramer-Douglas-Peucker on max(L,R) envelope, ε = **0.5 dB** | :102 rdpCompressStereo | Keeps inflection points (ducks, recovery), drops flat runs. |
| Max points — master time_series | **120** | analyzeAudio | 200→120 2026-06-07 (payload). |
| Max points — focus time_series | **40**, conditional emit (only if >6 kept points) | :2324 | 100→40 2026-06-07; a flat element omits the curve entirely (absence = flat, not no-data). |
| Max points — automation / GR (master + focus) | **30** | :1909/:1917/:2336/:2342 | 100→30 2026-06-07 (smooth curves survive RDP at 30). |
| Units | absolute musical beats (`captureStartBeat` + frame·dt) | — | Variable-rate; read t[i] per frame, don't assume regular spacing. |

---

## 10. Tools (LiveAPI query layer)

`list_tracks`, `get_track_devices`, `get_device_params`, `get_session_overview`, `get_track_routing`, `get_returns`, `get_arrangement_clips`, `get_group_chain`, `get_all_track_meters`, `get_memory`, `save_memory`, `ask_user_choice`, **`analyze_section`** (master + up to 8 focus voices + optional sidechain reference + per-track meters, with pairwise masking + transients + group-chain auto-fetch).

---

## 11. Capture & transfer infrastructure

| Element | Value | Where | Notes / 🚩 |
|---|---|---|---|
| Metro | `128n` transport-synced, quantized | .amxd | Frame timing source. |
| Sample-rate refresh | `refresh_samplerate()` at every capture start | start_record handler | Re-reads DSP SR when audio is on (load-time read can stale-fall-back to 44100 → false 48k warning + mislabeled spectrum freqs). Fixed 2026-06-07. |
| EQ corners inline | Eq8 `eq_bands_active` attached in `listDevices` → ships in `focus_group_chains`/`get_track_devices` as `eq` | live_query.js:`eqBandsForDevice` + listDevices | Cost fix 2026-06-07: AI reads group HP/LP corners from the capture instead of a `get_device_params` round-trip per EQ (the main driver of the $0.26 filter-mapping query). `get_device_params` also drops EQ8 per-band params (kept: globals + `eq_bands_active`). |
| Bulk buffer read | `Buffer.peek(ch,0,N)` one-call, auto-detected per capture | :251, snapshot | ~2000× fewer bridge calls than per-bin. Falls back to per-bin if unsupported. |
| Decimation | snapshot every `ceil(activeVoices/3)`-th tick **only when bulk-read unavailable** | snapshot_focus_spectrum | Trades temporal resolution to avoid main-thread starvation. With bulk-read, always 1 (full rate). |
| Result transfer | chunked, **8000 chars/chunk**, reassembled by requestId | :251 sendChunked, max_bridge.js | Max→browser bridge drops single messages >~30 KB. |
| Query timeout | 15 s | max_bridge.js | |

---

## 12. Known limitations / accepted tradeoffs (for the reviewer)

1. **Focus voices = pre-group-chain.** Taps capture a child's Post Mixer, before the parent group's devices (saturation/comp/clipper). Levels/spectra understate/differ from master contribution. Nonlinear chains can't be offset-corrected. *(Accept & document.)* The tap is Post Mixer (AFTER the track's own device chain), so the child's own effects are already in the spectrum — only the PARENT GROUP chain is downstream. The prompt's **CHAIN CHECK** directs the model to read `focus_group_chains` and reason QUALITATIVELY about that group chain's net transformation from its training on each device class — not a hardcoded filter rule, and not the child's own chain (already baked in). Added 2026-06-07.
2. **Focus has no true/inter-sample peak** — only frame-RMS (avg + loudest frame). True peak is master-only. *(Accept & document.)*
3. **Cross-scale comparison:** focus dB (FFT) vs master scalar dB (time-domain) may carry a constant offset; focus-to-focus is consistent, focus-to-master absolute is approximate. *(Accept.)*
4. **Two transient methods** (master heuristic vs focus EMA) — §7. Master density vs focus onset lists are different descriptors by design. *(Accept & document.)*
5. **Sub-bass resolution is FFT-bound** — ~18 FFT bins below 200 Hz (binHz≈10.8). No log grid recovers resolution the 4096 FFT doesn't have; this is why coarsening focus to 1/6-oct loses nothing real down low. A larger FFT would help but doubles per-frame read cost. *(Accept.)*

### Resolved in the 2026-06-07 pass
- ✓ Momentary LUFS now a single 400 ms block (§2).
- ✓ Masking now time-co-occurrence gated + power-sum + level-dependent skirt; verdict string removed (§6).
- ✓ Decimation-aware EMA α (§7). ✓ Spectral flux normalized (§4). ✓ Focus `width_ratio` added (§5).
- ✓ Cost: focus/ref spectrum 1/6-oct, time_series 40/conditional, automation/GR 30, masking 6+6 + masking-only pair emission, routing debug fields stripped from payload.

### MAX-SIDE (patch edits) — see hand-off note `docs/MAX_SIDE_TODO.md`
- ✓ **A. LUFS block window — RESOLVED 2026-06-07.** Patch confirmed: `average~ 19200` (400 ms) + `snapshot~ 100` (100 ms hop). Windowing is correct; the metro does NOT drive LUFS.
- ✓ **A2. K-weighting high-shelf — RESOLVED 2026-06-07.** Both biquads confirmed present and correctly ordered: shelf (`1.535125 -2.691696 1.198393 -1.690659 0.732481`) → RLB high-pass (`1. -2. 1. -1.990047 0.990072`). Full BS.1770 K-weighting.
- **A3. Sample-rate-pinned constants — DECISION: run session at 48 kHz.** All biquad coeffs + `average~ 19200`/`144000` are 48k. `average~` window can't be resized at runtime, so stock-object SR-awareness isn't clean (would need a `gen~` rewrite). Chosen path = pin to 48 kHz (exact, pro-standard). **Guard added 2026-06-07:** `live_query.js` flags `lufs.sr_note` + posts a console warning when SR≠48k so LUFS is never silently wrong.
- **B. Stereo S-channel wiring.** Confirm `specS`/`focus_N_specS` carry S=(L−R)/2 and focus taps are a STEREO Post-Mixer leg — suspected root cause of the "all-mono" false read (JS math is correct). `width_ratio` now disambiguates real mono, but the tap must actually carry stereo. Re-run and check `width_ratio` first.
- **C. pfft~ window** (low). Confirm Hann (coherent gain 0.5) so master `bandEnergyDb` `/(NUM_BINS/2)` holds. Focus self-calibrates, so this only shifts master absolute spectrum dB.

---

## 13. Debug scaffolding currently in code (to be removed once stable)

`flog()` → writes `device/focus_debug.txt` on every result send; `post()` traces (`[FOCUS] ...`) to Max console; `focusDebugLines`, `bulk_read`/`decimate` exposed in `focus_diagnostic`. Harmless but should be stripped for production. *(Routing identifier/channel diagnostics were stripped from the model payload 2026-06-07 — compress.js now ships only `track/voice/failed/silent`.)*

---

## 14. Correct-approach redesign — temporal masking, phase, and removing time_series (design, 2026-06-08)

> Supersedes the patchwork in §6. The current masking model is structurally wrong for transient material; this section is the agreed correct architecture before implementing.

### 14.1 How masking is computed TODAY — and the three structural flaws
`voiceSpecDb[track]` = each voice's spectrum **averaged over ALL capture frames, including the silence between hits**. `mgThresholdCurve` builds an ERB power-sum spreading threshold from the masker's *average* spectrum; `mgPairAnalysis` compares the signal's *average* spectrum to it; `cooccurrence()` then bolts on a temporal-overlap gate; and `signalFloor` / `relevanceFloor` / the −40 dB absent-skip are ad-hoc patches.

1. **Duty-cycle dilution (the worst one).** Averaging a transient — a clap that hits 8× in 8 bars — across all frames divides its real per-hit spectrum by its duty cycle. The clap reads ~10–20 dB quieter than it actually is when it sounds. **Every transient-vs-X masking margin is mis-scaled at the source.**
2. **Time is smeared, then bolted back on.** Masking is a per-moment event. Computing it on a time-average and multiplying by a separate `cooccur` is not the physics. The band gates (incl. the −40 skip) are band-aids for the missing time axis — exactly the "tightening" that shouldn't exist.
3. **`cooccur` answers the wrong question.** It measures *temporal overlap* ("what fraction of the signal's sounding-time does the masker also sound"). The meaningful quantity is *how often the signal is actually BELOW threshold*. Kick+clap always overlap (≈1.0) yet that says nothing about whether the clap is buried — this is the "it's something else" the user kept flagging.

### 14.2 Correct approach — online time-resolved masking (what real plugins do)
**Do NOT store per-frame history** — that's not how real masking meters work. iZotope **Neutron** (Masking Meter), **Soothe2**, **TrackSpacer**, Pro-Q's dynamic mode all operate on a **live short-term smoothed spectrum** (a fast EMA, ~tens–hundreds of ms), computed per block, never a stored frame buffer. We do the same:
- Maintain an **attack/release envelope follower per band per voice** — fast attack (~5 ms) everywhere to catch onsets, and a **frequency-dependent release**: long in the sub (~150–250 ms), short at HF (~20–40 ms). It MUST be per-band, two grounded reasons: (a) low ERBs are narrow so low bands physically ring far longer; high bands decay in a few ms; (b) auditory temporal resolution is finer at HF and forward masking is shorter there. A single global release would over-hold the highs (smearing hat masking) and under-hold the lows. This mirrors the per-band α already in `detectOnsets` (faster slow-EMA at HF) — same philosophy, consistent architecture. Bonus: the release time IS the forward/temporal-masking tail, so temporal masking is modeled for free by the ballistics, not bolted on. (Plain EMA is the symmetric special case.)
- **Online, each snapshot tick** (precompute the 60×60 ERB spread matrix once): compute each voice's masking threshold from its EMA spectrum, then for each pair, in bands where the signal's EMA is *present* (above its own running per-band floor), accumulate counters `masked_frames`, `present_frames`, `Σmargin`.
- **Memory: O(bins×voices) for the EMA spectra (~360 floats) + O(pairs×bands) counters (~1800). No frame history.** Compute ~20–25k ops/tick (precomputed matrix) — negligible next to the 2048-bin reads already happening each tick.
- Output per pair, per surviving band: `{ hz, masked_pct = masked_frames/present_frames, mean_margin_db }`, emitted only when `masked_pct ≥ ~0.3 && mean_margin ≤ −3`. **[SUPERSEDED by §14.8 C1 — output is DEPTH + bands + coarse co-occurrence class, NOT a percentage.]**
- **Co-occurrence becomes intrinsic** (a band counts only in frames where both sound), **dilution is gone** (EMA = real per-hit level), and `cooccur` + every ad-hoc gate (floor/relevance/−40 skip) are **replaced by the single principled number `masked_pct`**. Headline: "LEADS buries CLAPS' 600 Hz–1.1 kHz in **85% of the clap's sounding-frames**, ~18 dB." Payload is *smaller* (fewer real bands, no cooccur).
- The long-term **average** spectrum stays — but only for the OUTPUT tonal-balance `spectrum` (a section's average shape is the right thing there). Masking uses the EMA; tonal balance uses the average. Two cheap reductions of the same per-tick reads.
- Optional refinement: forward temporal masking (a transient raises threshold ~20–200 ms after) — a short decay on the threshold. Defer.

### 14.3 Phase / comb filtering — what it BUYS, and the honest reason it was never built
**What it adds to the engineer (a class of problems masking literally cannot see — masking is "A covers B", phase is "A and B cancel each other"):**
1. **Kick/sub-layer cancellation** — the big one for techno. Two kick layers, or kick+sub, that are phase-misaligned cancel in the low end → weaker/thinner than either alone. "KICK and SUB are ~140° out of phase at 55 Hz, losing ~5 dB — nudge timing or flip phase." This is usually the real cause of "weak low end" a producer can't diagnose by ear.
2. **Mono compatibility** — wide stereo content (pads, widened hats/claps) cancels when summed to mono (clubs sum bass to mono; phones are mono). "CLAPS lose 4 dB at 2 kHz in mono — the widener is over-decorrelating."
3. **Comb/hollowness** — a doubler, a parallel path with latency, or a misused widener creates periodic comb notches (phasey/hollow). Flags the notch signature.

All three payoffs are **full-spectrum** (mono-compat and comb apply to ambiance/hats/pads, not just low end — phase issues live everywhere). Build it properly.

**Build — full spectrum, coherence-gated (the foolproof part). Architecture Max → JS → AI:**
- **Within-element mono compatibility (all freqs):** **[SUPERSEDED by §14.8 C5 — `|M|` magnitude conflates pan with phase; use L/R coherence instead.]** ~~`mono_retain_dB = 20·log10(|M|/rms(|L|,|R|))`~~ — wrong: a hard-panned coherent sound reads as fake cancellation. Correct metric = L/R cross-spectrum coherence (same engine as between-element, applied to L vs R of one voice).
- **Between-element cancellation (all freqs, the real new tool):** needs the **cross-spectrum**, which needs phase. **Max:** inside the analyzer tap `fftin~`'s **real+imag** per voice and, per pair, accumulate IN DSP four running sums per bin into buffers — `ΣRe(A·conj B)`, `ΣIm(A·conj B)`, `Σ|A|²`, `Σ|B|²`. **JS** reads those four arrays per pair and computes per band:
  - **Coherence** γ² = (ΣRe²+ΣIm²)/(Σ|A|²·Σ|B|²) ∈ [0,1] — how STABLE the phase relationship is.
  - **Phase** φ = atan2(ΣIm, ΣRe).
  - **Cancellation when summed** ΔdB = 10·log10( (Σ|A|²+Σ|B|²+2ΣRe)/(Σ|A|²+Σ|B|²) ) — negative = energy lost to destructive interference.
- **Foolproof gates (the accuracy guarantee):** report a band ONLY when (a) **coherence γ² > ~0.5** — a consistent relationship, not random-phase noise (coherence is exactly the safeguard transfer-function / room measurement uses to reject garbage); (b) both `|A|²`,`|B|²` above a presence floor; (c) `ΔdB` meaningfully negative (< ~−1.5 dB). Low coherence → say nothing.
- **Output per pair:** compact `{ hz, cancel_db, phase_deg, coherence }` for the offending bands. Smaart/transfer-function-grade, full spectrum.
- **Why Max-side accumulation, not JS-reads-complex-per-frame:** moving real+imag for every voice every frame across the bridge would drop/lag = inaccurate. Accumulating the cross-spectrum in Max DSP and sending only the per-band sums is lighter on the bridge AND foolproof. Heavy DSP is fine — it stays in Max where it's reliable.

**Verdict:** build it, full spectrum. Mono-compat is free; between-element cancellation is the genuinely new tool; **coherence is the gate that guarantees we never hand the AI a phantom phase issue.** This is the correct measurement-grade approach, not a low-end hack.

### 14.4 time_series — what actually uses it (code audit), and the plan
**Audit of consumers (live_query.js):**
- **OUTPUT `time_series`** field (RDP envelope, master :1995 / focus :2489) — consumed **only by the AI**, for ducking/dynamics shape. Nothing in the code depends on it. **Safe to remove from payload.**
- Internal `timeSeries` array ALSO feeds: **FFT→dBFS calibration** (master, :1736 `fftRmsMean`) and **master transient density** (:1930). Internal `focusTimeSeries` ALSO feeds: **focus level `rms_max`/`rms_avg`** (:2478, the single source of truth for focus level). Internal `focusBandSeries` feeds **transients + cooccur**.
- ⇒ The internal arrays are load-bearing for level/calibration/transients, but each only needs a **reduction** (mean, max, peak-count), not the full series, and they're **never sent**. So removing the output field changes payload only; keep the internal reductions (optionally convert to running accumulators to save device memory).

**Plan:** drop the OUTPUT `time_series` (+ its `rdpCompressStereo` calls for output). Replace its meaning with derived descriptors: **ducking** = correlate each voice's internal broadband envelope (`focusBandSeries`) against the kick voice's onsets → `{ duck_depth_db, recovery_beats }`; **dynamics** = crest + transient/sustain ratio. Emit a coarse fixed-grid envelope only on explicit request. Net: a 40–120-point ×3-array block per voice replaced by ~2–3 numbers that directly answer "is it sidechained, how hard, how fast it recovers."

### 14.5 Implementation order
1. **Per-frame masking** — replaces `mgPairAnalysis` average + `cooccurrence` + all ad-hoc gates (incl. the −40 skip). JS-only. Biggest correctness + cost win. **← do first**
2. **Ducking descriptor + drop raw `time_series`.** JS-only.
3. **Phase/comb**: free `sm`-as-mono-compat (prompt only); kick/sub correlation (small Max add); skip the full complex tap unless needed.

### 14.6 Metric audit — is each one mixing-relevant, and is there a better method?
| Metric | Mixing-relevant? | Verdict |
|---|---|---|
| LUFS (integ/MaxM/MaxS/LRA), true peak, PLR | Yes — loudness/limiting/dynamics | Keep. BS.1770 is the modern standard. No time series needed (kms blocks). |
| Spectrum (avg magnitude, log bins) | Yes — tonal balance / EQ | Keep. Avg (or median, more transient-robust) is correct for *balance*. Masking uses the AR-smoothed spectrum instead (§14.2). |
| `rms_max`/`rms_avg` (focus level) | Yes | Keep, but compute as running max/mean — no stored array. (Per-element short-term loudness would be more perceptual but heavier; RMS is a fine proxy.) |
| Transients (per-band onsets) | Yes — timing/groove/alignment | Keep. Onset detection is the modern method. |
| `sm` / width_ratio / stereo_correlation | Yes — width AND **mono compat** (§14.3 #1) | Keep; upgrade interpretation (sm>0 = mono cancellation). |
| Automation / gain_reduction | Yes — what's moving / how hard it's compressed | Keep (compact). |
| **spectral_centroid** | Weak — brightness is readable from the spectrum curve | **Drop** — redundant scalar. |
| **spectral_flux** | Weak — an MIR/onset feature, not a mix action | **Drop** — nothing acts on it. |
| **master `transient_per_beat`** | Weak — coarse heuristic; the per-band onsets are the real thing | **Drop or replace** with onset-derived density. |
| **crest_factor** | Marginal — overlaps PLR/LRA | Keep (cheap) or fold into PLR. |
| **output `time_series`** | No consumer but the AI's eyeball | **Drop** → ducking descriptor (§14.4). |

Net modern set: LUFS suite + true peak/PLR, balance spectrum, focus level, onsets, width+mono-compat, masking (online AR), ducking, automation/GR. Everything reduces to running accumulators / onsets / counters — **no sent time series, no stored frame history.**

### 14.7 The three storage primitives — and the prime directive (never send an inaccurate number)
Everything reduces to one of three, so we **never store or send a dense time series**:
- **Running accumulator** — a variable updated per frame holding a reduction (sum/mean, max, min). O(1) memory. → focus level (`rms_max`=running max, `rms_avg`=Σ/n), FFT calibration (Σ FFT-RMS/n), tonal-balance spectrum (Σ|bin|/n), the four phase sums (ΣRe/ΣIm/Σ|A|²/Σ|B|²), per-band `|M|`/`|L|`/`|R|` for mono-compat.
- **Onset list** — a sparse list of event beats from the AR differential detector; only events, not a curve. → transients (kick/clap/hat); onset lists also drive ducking **trigger attribution** — match a ducked element's dips to whichever voice's onsets align (NOT assumed to be the kick; see §14.8 C3).
- **Counter** — an integer incremented when a per-frame condition holds; a ratio of counters = a prevalence. → masking (`masked_frames`/`present_frames` = `masked_pct`), phase prevalence if wanted.

Per-functionality map: **levels**→accumulators; **loudness**→Max `average~` blocks + JS gating; **tonal balance**→avg-spectrum accumulator; **masking**→per-band AR state + counters + Σmargin; **transients**→onset list; **ducking**→kick onsets + envelope sampled around each onset → {depth, recovery}; **phase**→four cross-spectrum accumulators + coherence; **width/mono-compat**→`|M|`/`|L|`/`|R|` accumulators. Per-frame STATE kept = only the small AR follower values + accumulators ⇒ **memory O(bins×voices), independent of capture length.**

**Foolproofing — the prime directive is "never feed the AI a wrong number":**
1. **Presence gate everywhere** — never judge masking/phase/width in a band where the element isn't actually present (above floor). No judging silence or noise floor.
2. **Coherence gate for phase** — only report cancellation where the relationship is statistically stable (γ²>~0.5). The one safeguard against phantom phase.
3. **AR per-band envelope kills the dilution bug** — levels measured when the element actually sounds, not averaged across its own silence.
4. **Ratios are calibration-immune** — masked_pct, coherence, mono_retain, cancel_dB are relative, robust even if absolute calibration drifts.
5. **Estimates are LABELED** — anything not directly measurable (downstream opaque plugins, SR≠48k) is flagged so the AI marks it an estimate. The device emits measurements or explicitly-marked estimates — never a guess dressed as a measurement.
6. **No metric depends on a sent time series** — the data most prone to bridge truncation/drift is simply gone.

### 14.8 A+++ corrections — SUPERSEDE the relevant bullets in 14.2–14.7 (from the independent audit + design review)
The audit (docs/ARCHITECTURE_AUDIT.md) graded the first draft **B**. These six corrections resolve the 4 MAJOR + related MINOR leaks.

**C1 — Masking output is DEPTH + BANDS, not a percentage (audit MAJOR #1 + sparse elements).** For deterministic material (same samples every hit), "masked in 13/16 hits" is spurious jitter — it's ~always or ~never. The real answer is **which bands, how many dB**. Maintain the per-band AR-followed level per voice; per pair/band, measure **depth = signal's active level − masker's threshold**, over frames where BOTH are present (co-occurring + signal above its per-band floor); aggregate to a representative depth (median). Output bands with `depth ≤ −3 dB` + their dB. Temporal dimension = a **coarse 3-way co-occurrence class** (always/sometimes/rarely), never a precise %. Depth is a level comparison ⇒ **valid from a single event** (lone crash → "masked 3 kHz, 12 dB"); no minimum-count needed, the sparse problem dissolves. Frames/onsets are the internal mechanism for an undiluted level; depth+bands is the deliverable.

**C2 — Phase verdicts require persistence; abstaining on rare events is CORRECT (audit MAJOR #4).** Coherence needs enough independent averages; a lone crash gives too few. But phase cancellation is inherently **persistent** (kick+sub every beat, sustained pad) — you cannot have a phase problem from one transient. So sparse overlaps ⇒ "insufficient persistence for a phase verdict" (honest, not a gap); masking depth (C1) still reports the event. Bias-correct coherence `γ²_corr ≈ (n·γ̂²−1)/(n−1)`, gate on a confidence floor that depends on n.

**C3 — Ducking is a per-DIP sparse sequence, TRIGGER-AGNOSTIC, not a scalar (audit MAJOR #2 + "8 bars may change" + the trigger isn't always the kick).** Sidechain ducking can be keyed to anything — kick, bongo, clap, perc bus, vocal — so never assume the kick. Detection hierarchy, most-reliable first:
1. **`gain_reduction`** of a sidechain compressor on the element IS the duck, exactly — already captured.
2. **Volume/LFO `automation`** IS the duck, exactly — already captured (when it exposes a Live param).
3. **Fallback — the SAME GMaudio differential-EMA detector, read on the falling edge.** A duck is the inverse of an onset: onset = `fast−slow` sharply POSITIVE (rising edge); duck = `fast−slow` sharply NEGATIVE (level drops fast vs its own recent average). The detector already in place for transients detects ducks for free — no new algorithm, and fittingly the GMaudio algorithm is a *ducker* by origin. Covers ducking by means that expose no Live param (M4L/VST modulators, baked-in gain).
Output one `{beat, depth_db, recovery_beats}` per dip. `depth` = how far `fast` fell below the pre-dip level (≈ `slow`); `recovery` = beats until `fast` re-converges to `slow`. **Attribute the trigger by MATCHING**: cross-correlate dip times against every captured voice's onsets; the aligned one is the trigger (kick/bongo/clap/…), else "trigger not captured".
**Fully STREAMING — no ring buffer, no time series:** the EMA followers ARE the memory (O(1) state per band) plus a tiny per-voice "current duck" record (start-beat, depth) finalized when `fast` recovers. Ducking is read from EMA STATE + its differential, NOT from a stored envelope — so it does not reintroduce a time series (this corrects both the audit's false "no-history" claim AND my earlier ring-buffer drift).

**C4 — Phase needs inter-tap delay removal (audit MAJOR #3).** Estimate τ via **cross-correlation lag** (robust; correlation DSP already exists) or cross-spectrum phase-slope; remove it before judging cancellation; the residual is real. Ableton PDC aligns chains **at master**, so tap-relative delay is a tapping artifact — removing it is correct. Too-dissimilar ⇒ low coherence ⇒ no verdict (self-consistent). Clip-timing offsets are reported separately by onset alignment, not phase.

**C5 — Mono-compat uses L/R coherence, not |M| magnitude (audit MINOR; unifies the engine).** `20·log10(|M|/rms(L,R))` conflates **pan** with **phase** (hard-panned coherent content reads as fake cancellation). Real mono cancellation = **anti-correlation of L and R** = the cross-spectrum/coherence engine applied to **L vs R of one voice** — SAME machinery as between-element (A vs B). One phase engine, used twice. Report mono-loss only where L/R coherence is high AND summed energy drops. (Also retire the "sm>0 = mono cancellation" shortcut from §14.3 #1.)

**C6 — Keep the 128n metro; derive every follower α from REAL elapsed time (audit MINOR; recurring bug class).** The metro's job is **beat-aligned groove/onset timing** (still wanted); it does NOT drive LUFS (time-based `average~`/`snapshot~ 100`). So killing time_series doesn't free us from beats, and a ms metro gains nothing under constant tempo. Fix ballistics by conversion: `frame_dt_sec = (60/tempo)/8 × decimate`, `α = 1 − exp(−frame_dt_sec/τ_sec)`. One helper for masking AR + transient EMA. ms-correct ballistics, beat-correct timing, no metro change.

⇒ With C1–C6 the MAJORs and related MINORs are resolved. **Re-audit required to confirm A+++ before implementing the masking/ducking redesign.**

### 14.9 Implementation status (2026-06-08)
- ✅ **BUILT — Step 1: per-band mono-compatibility (L/R cross-spectrum).** Max: each `spectrum_analyzer_focus_N.maxpat` now computes `ReLR = rL·rR+iL·iR`, `ImLR = iL·rR−rL·iR` from the `fftin~` real/imag and `poke~`s them to `focus_N_reLR`/`focus_N_imLR` (buffers added to `focus_chain_N.maxpat`). JS: `focusMonoAccum` accumulates ΣReLR/ΣImLR/Σ|L|²/Σ|R|² in `snapshot_focus_spectrum`; `computeMonoCompat()` outputs `voices[N].mono_compat = [{hz, loss_db, coherence?}]` (present only when bands cancel; presence-gated, coherence bias-corrected + n_eff-gated; hard-pan reads ~0). Prompt updated. **User must SAVE the device in the Max editor** (commits the patch edits) then reload.
- ⏳ **PENDING — Step 2: between-element cancellation (full phase pipeline §14.3).** Same cross-spectrum block fed two voices' mono; selected pairs first; needs delay-comp (C4). Hold per the feasibility audit.
- ⏳ **PENDING — masking-depth redesign (C1), streaming transients/ducking (C2/C3), AR per-band followers (§14.2), α-from-dt (C6).** Re-audit first.

---

*Last updated: 2026-06-07 (expert-review optimization pass: §2 momentary, §4 flux/transient-bands, §5 width_ratio, §6 masking overhaul, §7 EMA, §9 payload caps, §1 dual spectrum grid). Add to this file with every measurement/constant/tool change.*
