# Expert Review — AI Mixing Engineer M4L Measurement Engine

> Advisory only. No code changed. Every constant below was verified against `device/live_query.js`, `docs/tools.js`, `docs/compress.js` (line numbers are from those files as read 2026-06-07). Where the spec (`MIXING_SPEC.md`) disagrees with code, **code is treated as ground truth** and the discrepancy is noted.
>
> Standards cited: ITU-R BS.1770-4, EBU R128 / EBU Tech 3341 (meters) / 3342 (LRA), Glasberg & Moore 1990 (ERB), Moore-Glasberg excitation/spreading model.

---

## 1. Executive Summary — highest-impact changes (ranked)

| # | Change | Tag | One-liner |
|---|---|---|---|
| 1 | **Momentary LUFS is not 400 ms** — it averages the last 4 blocks (~1.6–2.0 s of one-second-spaced or unknown-spaced blocks) and the kms blocks are not confirmed 75%-overlapped per BS.1770. | **[BUG]** | Momentary must be a single 400 ms window (1 block if blocks ARE 400 ms gapless); current value reads like short-term and is mislabeled. |
| 2 | **Masking is frequency-only, no time co-occurrence gate** — alternating elements (verse vox vs chorus synth) falsely report as masked/complementing. | **[BUG]** | Gate every pairwise verdict by time-domain energy overlap of the two `focusBandSeries`; cheapest correct fix, near-zero payload. |
| 3 | **Stereo width metric `sm = side_db − mid_db` collapses to "mono" whenever the S buffer is near-silent**, and the documented symptom (known-stereo mix read as all-mono) most likely originates in the Max-side S=(L−R)/2 derivation or a focus tap pulling a mono Post-Mixer leg — not the JS math. | **[BUG / MAX-SIDE]** | The JS difference math is correct; verify S-channel actually carries (L−R)/2 in the patch and that focus taps are stereo "Post Mixer", not a mono sum. |
| 4 | **Masking spreading function is level-independent and uses `max()` of maskers** instead of power-sum; slopes (−22/+27 dB/ERB) are fixed. | **[EXPERT-LEVEL]** | Switch threshold accumulation to power-sum (additive masking) and make the downward (toward-low-freq) skirt level-dependent; raises parity with real psychoacoustic maskers. Near-zero payload. |
| 5 | **Spectrum grid is 1/12-octave (~119 bins) and shipped for master + every focus voice + sidechain.** This is the single largest payload line item and the main reason a 6-voice query hits ~$0.25. | **[COST-CUT]** | Drop to 1/6-octave (~60 bins) for focus voices and reference; keep 1/12 only on master. ~50% spectrum-token cut, no expert-relevant loss for per-track EQ decisions. |
| 6 | **Transient band split is 3 bands (sub/mid/high) with a 300 Hz–5 kHz "mid" lump**, and master uses a different method than focus. | **[EXPERT-LEVEL]** | 3 bands is defensible for cost, but the 300–5000 "mid" hides snare body vs presence; if budget allows, split at ~300/2k/6k (4 bands). Unify on the EMA method conceptually. |
| 7 | **Focus per-voice `time_series` (100 pts) + automation (100 pts) + gain_reduction (100 pts) per voice** is a large, often-low-value payload block. | **[COST-CUT]** | Cut focus time_series to 40 pts and only emit it when the voice has a duck/transient story (RDP already keeps shape); cap automation/GR to 30 pts. Large token cut, minimal validity loss. |
| 8 | **Spectral flux is un-normalized** (scales with absolute level) and **transient_per_beat threshold mixes a 2 dB floor with 0.8·stdev**. | **[EXPERT-LEVEL]** | Normalize flux by frame energy so it's comparable across captures; these are low-cost correctness polish, not headline bugs. |

**Single most important bug:** #1 — Momentary LUFS (`live_query.js:1741`, `momentaryBlocks = blocks.slice(-4)`) is not the BS.1770/EBU 400 ms momentary window. It averages 4 blocks (~short-term territory) and labels it `momentary_lufs`. Any "is this momentary peak too loud" reasoning by the LLM is operating on the wrong time constant.

---

## 2. CORRECTNESS BUGS (measurably wrong vs standard)

### 2.1 Momentary LUFS window — [BUG]
- **Current:** `live_query.js:1741` `var momentaryBlocks = blocks.slice(-4);` then averages their mean-square and converts. Same pattern in sidechain at `:2155`.
- **Standard:** EBU Tech 3341 / BS.1770: **Momentary = single sliding 400 ms rectangular window, ungated.** Short-term = 3 s window, ungated.
- **Why it's wrong:** Averaging the last 4 blocks gives ~1.6 s (if blocks are 400 ms and gapless) up to undefined (if the `kms` buffers are sampled at metro rate, the "block" spacing is tempo-locked, not 400 ms — see 2.2). Either way it is not the 400 ms momentary descriptor; it behaves like a coarse short-term.
- **Fix:** Momentary should be the **most recent single 400 ms block**: `var momentary = blocks[blocks.length-1].lufs;` *provided* each `kms` block genuinely integrates 400 ms (confirm in Max). If the Max K-weighted MS is computed on a shorter window, momentary must integrate a trailing 400 ms worth of those sub-blocks. Given you already have a true 3 s short-term path (`kmsLstBuf`), momentary collapsing to one 400 ms block removes the redundancy.
- **Note on spec drift:** `MIXING_SPEC.md:41` already flags this ("using last 4 ≈ 1.6 s … looks closer to short-term"). Confirmed against code — it is a real violation, fix as above.

### 2.2 K-weighted block windowing / overlap unverified — [BUG-RISK, MAX-SIDE]
- **Current:** `kmsLBuf`/`kmsRBuf` are pushed one value per metro tick (`:187-190`, gated by `collecting`). The metro is `128n` (tempo-locked), so block cadence is **1/32 beat**, ≈ 14.6 ms at 128 BPM — NOT the 400 ms gating block BS.1770 requires, and NOT the 75%-overlapped 400 ms blocks (100 ms hop) the integrated measurement assumes.
- **Standard:** BS.1770-4 integrated loudness gates on **400 ms blocks overlapping by 75% (100 ms step)**. The gating block size is fixed in *time*, not musical beats.
- **Why it matters:** If each pushed `kms` value is an *instantaneous* K-weighted MS sample (not a 400 ms integral), then "block loudness" at `:1735` is computed on ~15 ms windows, the −70 absolute gate and −10 relative gate operate on the wrong statistics, and integrated LUFS will be biased (typically reads high on transient-dense material because short windows over-weight peaks).
- **What to verify in Max:** Is `kms_l`/`kms_r` the output of a 400 ms sliding-average of the K-weighted squared signal (e.g. `average~ <400ms> @mode rms` on the K-filtered signal), sampled at 100 ms? Or is it an instantaneous square sampled at 128n? **The integrated/gated math is only valid in the first case.**
- **Fix:** Decouple LUFS block cadence from the musical metro. Drive the kms snapshot from a **time-locked** sampler at 100 ms hop over a 400 ms K-weighted MS window. This is a Max-side change. (Short-term should be a 3 s window sampled at 1 s — `kmsLstBuf` at `:28` is the right idea but same time-vs-beat caveat applies.)
- **Status:** Cannot be fully confirmed from JS alone — the integration window lives in the `.amxd`. Flagged as the second-most-important correctness item after 2.1 because it can silently bias *every* LUFS number.

### 2.3 Masking has no time-domain co-occurrence — [BUG]
- **Current:** `mgPairAnalysis` (`:1498`) operates purely on time-averaged spectra (`voiceSpecDb`). Two sounds that never play simultaneously still produce a masked/complementing verdict.
- **Why it's wrong:** Masking is a *simultaneous* phenomenon. A verse vocal and a chorus pad averaged over an 8-bar capture will spectrally overlap and report "masked" even though they never co-occur. This over-reports and can send the LLM chasing a non-problem.
- **Cheapest correct fix (near-zero payload):** You already compute per-frame band energies in `focusBandSeries[voice]` (`:484`). For each masker→signal pair, compute a **time-domain co-occurrence factor** before trusting the frequency verdict:
  - Build per-voice broadband energy curve `E_v[frame] = sub+mid+high` (already available).
  - `overlap = Σ_frames min(active_masker, active_signal) / Σ_frames active_signal`, where "active" = frame energy above that voice's own (max − 20 dB) gate.
  - If `overlap < ~0.3`, set verdict to `"non_overlapping"` (or attach `cooccur: <0..1>` to the pair) and **do not** emit masked/audible bands.
  - Cost: one extra scalar per pair (or one short reason string). The masked-band lists already dominate; gating them OFF when non-overlapping is a net *payload reduction*.
- **Even cheaper variant:** gate by arrangement clips. `get_arrangement_clips` already exists; if two focus tracks' clip ranges don't intersect the captured window simultaneously, skip the pair. But intra-section alternation (both clips present, alternating hits) needs the frame-energy method above.

### 2.4 Stereo width / mono false-read — [BUG, root cause likely MAX-SIDE]
- **Symptom reported:** a known-stereo mix read as all-mono.
- **JS math reviewed and is correct:**
  - `stereo_correlation` (`:1620-1638`) uses mean-of-per-frame-ratios `crossLR/(rmsL·rmsR)`, clamped, which is the right choice (the comment correctly notes ratio-of-means biases high). No bug here.
  - `sm = side_db − mid_db` per bin (`:1711`, `:2307`) with S=(L−R)/2, M=(L+R)/2 is a valid width proxy; the calibration offset cancels in the difference (correct, `:2305`).
- **Where the mono false-read actually comes from (ranked):**
  1. **Focus tap pulling a mono leg.** `setFocusRouting` picks `"Post Mixer"` (`:1266`). If a routed track's Post Mixer is exposed as a mono identifier (or the child is mono-summed pre-group), S=(L−R)/2 ≈ 0 → `sm` floors to −∞ → reads mono. The routing log already captures `available_channels_with_ids`; check whether the *applied* identifier is the stereo one. This is the most likely culprit and is **Max/routing-side**.
  2. **S buffer derivation in the patch.** If `specS` is fed (L−R) without the ÷2, or if M and S use different window/gain, the `sm` difference is biased. Verify the `.amxd` matrix that fills `specS`/`focus_N_specS`.
  3. **True-silence floor:** when `dS` is `null` or both M,S hit the −120 floor, `sm` is `null` and the model may interpret absence as mono. `compress.js` should distinguish "no width data" from "narrow".
- **Recommended JS-side safety net:** add an explicit `width_ratio` per voice = `side_rms / mid_rms` (linear, from the overall energies) so a near-zero side energy is unambiguous (0.00 = truly mono) versus a `null`. One scalar per voice.
- **Action:** This is primarily a **Max-side verification** (S-channel wiring + stereo Post-Mixer tap). The JS metric and threshold are not themselves wrong.

### 2.5 LRA percentile indexing — minor [BUG]
- **Current:** `:1803-1806` `idx10 = floor(n*0.10)`, `idx95 = floor(n*0.95)`.
- **Standard (EBU Tech 3342):** LRA = 95th − 10th percentile of the relative-gated short-term distribution. Floor indexing with small n undershoots; for tiny n the 10th percentile can land on index 0.
- **Impact:** small. With section-length captures n is modest (a 16-bar/30 s capture at 1 s hop = ~30 short-term blocks), so `floor` vs interpolated percentile differs by ~1 block. Acceptable, but if you want spec-exact use linear interpolation between ranks. Low priority.

### 2.6 Spreading-function direction sign — verify intent (not a confirmed bug)
- **Current:** `mgSpreadDb(delta_erb)` with `delta_erb = ERB(test) − ERB(masker)` (`:1486`): upward (test above masker, Δ>0) uses **−22 dB/ERB** (gentle), downward (test below masker, Δ<0) uses **+27·Δ** i.e. **−27 dB/ERB magnitude** (steep).
- **Psychoacoustic truth:** *upward spread of masking* — a masker masks **higher** frequencies more easily than lower ones. So the slope toward higher frequencies (Δ>0) should be the **gentler** one and toward lower frequencies (Δ<0) the **steeper** one. The code's −22 (gentle, up) vs −27 (steep, down) **has the directions correct**. Good — confirmed not inverted.
- **Caveat:** magnitudes are level-independent (see 3.1).

---

## 3. EXPERT-LEVEL UPGRADES (pro-tool parity)

### 3.1 Additive (power-sum) masking instead of max() — [EXPERT-LEVEL, ~0 payload]
- **Current:** `mgThresholdCurve` (`:1486-1488`) takes `if (v > thr[t2]) thr[t2] = v;` — the **loudest single** spread contribution wins.
- **Better:** real masking from multiple maskers is closer to a **power sum** of excitations: `thr_lin += 10^(v/10)` then `thr = 10·log10(thr_lin)`. With many maskers (a full mix) max() under-estimates the threshold by up to ~3–6 dB, so the model under-reports masking.
- **Cost:** none (same loop, accumulate in linear then one log at the end).
- **Recommendation:** switch to power-sum. This is the single biggest *quality* lift in the masking model and free.

### 3.2 Level-dependent downward skirt — [EXPERT-LEVEL, ~0 payload]
- **Current:** fixed −22/+27 dB/ERB (`:1472-1473`).
- **Moore-Glasberg:** the **lower skirt** (steeper, toward low freq from a high masker — i.e. how a masker spreads downward) is the level-dependent one; filters are ~symmetric near 51 dB/ERB and the low-side slope shallows as masker level rises (so loud low-frequency content spreads upward more — the classic "bass masks everything" effect).
- **Practical, cheap approximation:** make the **upward** spread (Δ>0, low masker → high test) shallower as masker level rises: `slopeUp = -(22 - k·max(0, Lm - 40))` clamped to e.g. −6 dB/ERB, with `k≈0.2`. Keep the downward slope near −27. This captures the audible "loud bass masks mids/highs" behavior that the fixed slope misses.
- **Cost:** negligible (one extra term per masker bin).
- **Priority:** do AFTER 3.1; it's a refinement, not a correctness fix.

### 3.3 Masking heuristic constants — judged individually
| Constant | Where | Verdict | Recommendation |
|---|---|---|---|
| Signal floor `lufs − 40` | `:2274` | **Reasonable.** −40 LU below integrated is a sane "this bin is real content not rolloff" gate for a busy mix. | Keep; consider −45 for sparse/ambient material (genre-dependent → open question). |
| Relevance window −30 dB (`RELEVANCE_RANGE`) | `:1505` | **Slightly wide.** A track's musically-relevant body is usually within ~20–25 dB of its loudest band; 30 dB lets in rumble/air that isn't the sound's identity. | Tighten to **−25 dB**. Minor, reduces false masked bands. |
| Rolloff skip `sig < thr − 60` | `:1519` | Fine — only excludes deeply-buried bins. | Keep. |
| Masked/audible dead-zone ±3 dB | `:1522-1523` | **Reasonable** as a deliberate "uncertain" band. | Keep; it's a sensible hysteresis, not a label-only threshold. |
| Verdict ratios 0.6 / 0.4 | `:1531-1532` | **These are label-only thresholds** producing `complementing/masked/mixed` strings. Per the project's "tools return raw, LLM interprets" rule, a categorical verdict in JS is borderline. | Either drop the string verdict entirely and let the LLM judge from `masked_bands`/`audible_bands` counts + new `cooccur` factor, OR keep it but document it's a convenience. Leaning **drop the verdict, keep raw bands** — removes a tuning knob and a payload field. |
| Output cap 8 masked + 8 audible | `:1527-1528` | Good for cost. | Keep (or 6/6 if cutting further — see §4). |

### 3.4 Transient detection — band split & method unification — [EXPERT-LEVEL]
- **Current focus method:** GMaudio differential-EMA, 3 bands, `detectOnsets` (`:284`), params `αfast=0.63` (all bands), `αslow=0.031/0.061/0.118` (sub/mid/high), `threshMult=0.5` (`:2357-2359`).
- **Current master method:** local-maxima over L time-series, threshold `mean + max(2, 0.8·stdev)` (`:1850`). Different algorithm entirely.
- **Band split judgment:** sub=20–300, mid=300–5000, high=5000–20000 (`:433-438`). **The 300 Hz–5 kHz "mid" is too broad** — it lumps snare body (~200–400 Hz fundamental), low-mid mud, vocal presence, and attack click together. A pro transient view separates **body (≈300–2 kHz)** from **presence/click (≈2–8 kHz)**.
  - If budget allows: 4 bands **20–200 / 200–2k / 2k–8k / 8k–20k**.
  - If holding at 3 to save cost: at least move the mid/high crossover from 5 kHz down to ~3 kHz so "high" captures the attack click that defines snare/hat transients.
- **EMA constants judgment:**
  - `αfast=0.63` → τ_fast ≈ 1 frame (~14 ms). Good for attack capture.
  - `αslow=0.031` (sub) → τ ≈ 32 frames (~450 ms): reasonable for kick spacing.
  - `αslow=0.118` (high) → τ ≈ 8 frames (~110 ms): fine for hats.
  - **All three use the same fast α** — but a sub-bass transient (kick) has a slower physical attack than a hat click; `αfast` could be slightly slower for sub (≈0.4) to avoid double-triggering on the kick's pitch wobble. Low priority.
  - **`threshMult=0.5` is the sensitivity knob** and is the same across bands; defensible. The `diff > prevDiff` rising-edge condition means it fires on the frame *before* the peak — fine for onset timing.
- **Frame-rate dependence is real:** `MIXING_SPEC.md:115` and `:2345` note α is tuned for 128n. With bulk-read (`focusBulkRead=true`) decimate=1 and α stay valid (`:696`). Without bulk-read, decimate ≥2 and **the α become wrong** (every onset time also stretches because `beatOffset` multiplies by decimate at `:480`). **Recommendation:** when `decimate>1`, rescale α by decimate (`α' = 1−(1−α)^decimate`) so the time constants stay in real time. Cheap, removes a silent failure mode.
- **Method unification:** master's heuristic and focus's EMA producing different "transient" semantics is genuinely confusing for the LLM. **Recommendation:** run the same `detectOnsets` EMA on the master's `timeSeries` broadband envelope and report onset times, OR at minimum document that `transient_per_beat` (master, density) and `transients.{sub,mid,high}` (focus, onset lists) are different descriptors. Unifying is moderate effort, not free.

### 3.5 Spectral flux normalization — [EXPERT-LEVEL, ~0 payload]
- **Current:** `:527-536` sums positive bin differences, averaged over frames; un-normalized → scales with absolute level (`MIXING_SPEC.md:70` flags this).
- **Fix:** divide each frame's flux by that frame's total magnitude (`fluxSum / Σ|currentM|`) so flux is comparable across captures of different loudness. One division per frame. Makes it an actual "how much is the spectrum changing" descriptor rather than "how loud × changing".
- **Or:** if nothing in the prompt consumes `spectral_flux` for a decision, **drop it** (see §4) — it's a weak descriptor for mixing verdicts.

### 3.6 Spectral centroid uses linear FFT bins — acceptable
- `:1870-1879` weights by linear bin Hz over the raw 2048-bin spectrum. This is the standard centroid definition and correct. Keep.

### 3.7 True peak — correct
- 4× oversampled per channel, max L/R (`:1823-1836`, fed by Max `poly~ up 4`). Meets BS.1770 ≥4× rule. **No change.** (Documented limitation: focus voices have no true peak — correct to leave as-is, §7.)

### 3.8 Integrated LUFS gating — correct
- Absolute −70 LUFS then relative −10 LU below ungated mean (`:1748`, `:1757`). Matches BS.1770-4. **No change** (assuming 2.2 block windowing is fixed — the gating logic is right, only the block definition is in question).

---

## 4. COST CUTS (get a typical query under $0.10)

Context: a full 6-voice, full-spectrum, with-time-series query ≈ $0.25. The spectrum and per-voice time-series blocks dominate. Ordered by token-saved-per-validity-lost.

### 4.1 Coarsen focus/reference spectrum to 1/6-octave — biggest win
- **Current:** `buildLogBins()` `stepsPerOctave=12` (`:1443`) → ~119 bins, emitted for **master + every focus voice + sidechain**. Each focus voice ships `hz[119] + m[119] + sm[119]`.
- **Cut:** use **1/6-octave (~60 bins)** for focus voices and reference; keep **1/12 on master only** (master is where fine EQ/tonal-balance reading matters). Masking can run on the coarser grid — 1/6 oct ≈ 1/3 to 1/2 an ERB up high, still finer than the auditory filter where it counts.
- **Impact:** ~50% of all spectrum tokens. On a 6-voice query this is the single largest reduction — easily the difference between $0.25 and ~$0.13.
- **Validity cost:** negligible for per-track decisions; 1/12 oct (semitone) resolution per *individual track* is overkill for EQ verdicts (you don't EQ a kick in semitones). Masking loses a little low-freq precision; mitigate by keeping bins below 200 Hz at 1/12 (hybrid grid) since sub resolution is already the weak spot.

### 4.2 Trim focus `time_series` 100 → 40 points, conditional emit
- **Current:** `rdpCompressStereo(..., 0.5, 100)` per voice (`:2324`); master at 200 (`:1905`).
- **Cut:** focus → **40 points** (RDP ε=0.5 already keeps only inflection points; 40 captures a duck + recovery + a few hits in 8 bars). Master can stay 200 or drop to 120. **Only emit focus time_series when the curve has >~6 kept points** (i.e. there's actual dynamic story); a steady pad's flat curve carries no information.
- **Impact:** focus time_series is 3 parallel arrays × up-to-100 × N voices. Cutting to 40 + conditional emit removes a large block on multi-voice queries.
- **Validity cost:** low. The duck/transient shape is what matters and RDP preserves it; you lose nothing on flat material because you stop emitting it.

### 4.3 Cap automation / gain_reduction to 30 points
- **Current:** `samplesToBeats(..., 100)` for automation, `(..., 100, 0.5)` for GR, per voice and master (`:1909`, `:1917`, `:2336`, `:2342`).
- **Cut:** **30 points** for both. A gain-reduction or filter-sweep curve's *shape* survives RDP at 30 points over a section.
- **Impact:** moderate; matters most when several voices have automation.
- **Validity cost:** minimal — these are smooth curves, RDP-friendly.

### 4.4 Masking band lists 8+8 → 6+6, drop string verdict
- **Current:** 8 masked + 8 audible per pair (`:1527-1528`), plus `verdict` string, `worst_masked_db`, `best_audible_db`.
- **Cut:** **6+6**, drop `verdict` (per §3.3 it's a label the LLM should derive), keep `worst_masked_db`/`best_audible_db` (cheap, decision-relevant). Pairwise is **N×(N−1)** entries — at 6 voices that's 30 pairs, so per-pair savings multiply hard.
- **Bigger structural cut:** masking is currently **fully bidirectional** (A→B and B→A both emitted). For most use you want the *asymmetric* story but 30 pairs at 6 voices is a lot. Consider emitting only pairs where `worst_masked_db ≤ −3` (an actual masking event) — drop "everything is fine" pairs entirely (compress.js already drops `insufficient_data` at `:198`; extend to drop all-clear pairs).
- **Impact:** large on high-voice-count queries (the pairwise block is O(N²)).
- **Validity cost:** none — you're dropping non-events.

### 4.5 Drop weak descriptors that no decision consumes
- **`spectral_flux`** (`:1929`, `:2227` not present for focus — master/sidechain only): un-normalized, weak for verdicts. **Drop** unless the system prompt actually uses it.
- **`fft_meta`** is already stripped by compress.js (`:111`, `:206`) — good, no action.
- **`frames_averaged`** stripped per-voice (`compress.js:132`) — good.
- **`audio_inputs_count`, `available_channels_with_ids`, identifier diagnostics** in `focus_routing` (`compress.js:159-168`): these are **debug fields** that ship to the model on every focus query. Once routing is stable, **strip all the `*_identifier` and `available_channels*` fields** — keep only `track/voice/failed/silent`. Per `MIXING_SPEC.md:170` this is acknowledged scaffolding. Meaningful recurring cost.

### 4.6 Estimated combined effect
- 4.1 alone ≈ −45% spectrum tokens. 4.2+4.3 ≈ trim the second-largest block. 4.4 ≈ big on ≥4 voices. 4.5 ≈ steady overhead removed.
- A typical 3–4 voice query should land **well under $0.10**; the worst-case 6-voice full query should approach ~$0.10–0.13 (vs $0.25). If 6-voice must be guaranteed <$0.10, additionally drop `sm` from focus voices (width per-band is rarely needed per-track; keep it on master only) — that's another ~⅓ of each focus spectrum.

---

## 5. MAX-SIDE actions (require editing .amxd / re-saving in Max editor)

| Item | Why | Friction |
|---|---|---|
| **Verify K-weighted MS block window = 400 ms @ 100 ms hop, time-locked (not 128n).** (§2.2) | Integrated/momentary/short-term LUFS validity depends on it. Currently the kms snapshot cadence is the musical metro. | High — needs a separate time-locked sampler + 400 ms/3 s sliding RMS on the K-filtered signal. |
| **Verify focus Post-Mixer tap is STEREO, and S=(L−R)/2 is wired correctly** for `specS`/`focus_N_specS`. (§2.4) | Root cause candidate for the all-mono false read. | Medium — inspect routing identifiers + the M/S matrix in the patch. |
| **Confirm pfft~ window is Hann with the assumed coherent gain 0.5** (calibration divides magnitude by NUM_BINS/2 = FFT_SIZE/4 at `:1694`). | If the window isn't Hann (or overlap≠4), the absolute dBFS calibration is off by a constant. The per-capture `fftCalibrationDb` largely absorbs this for focus, but master's `bandEnergyDb` hard-codes the /  (NUM_BINS/2) factor. | Low — one inspection; `MIXING_SPEC.md:27` flags window unverified. |
| **Expand to >8 focus voices** (if ever wanted) needs re-saving the device to commit more plugin~ audio-input channels. | Structural M4L limit. | High; out of scope unless requested. |
| **Optional: master transient onset path** to unify with focus EMA (§3.4) — if done in Max would need a band-split on master too. | Consistency. | Medium; or do it JS-side on existing master timeSeries (cheaper). |

---

## 6. JS-SIDE actions (live_query.js / tools.js / compress.js only)

| Item | File:line | Change |
|---|---|---|
| Momentary = single 400 ms block | `live_query.js:1741`, `:2155` | `momentary = blocks[blocks.length-1].lufs` (after confirming block = 400 ms). |
| Power-sum masking threshold | `:1486-1488` | accumulate `10^(v/10)`, log at end. |
| Time co-occurrence gate on masking | new, uses `focusBandSeries` | compute per-pair overlap; gate verdict / suppress bands; add `cooccur`. |
| Level-dependent up-skirt | `mgSpreadDb` `:1471-1474` | pass masker level, shallow the Δ>0 slope with level. |
| Tighten RELEVANCE_RANGE 30→25 | `:1505` | one constant. |
| Drop `verdict` string, keep raw bands + worst/best | `:1530-1540` | remove categorical label. |
| Coarsen focus/ref spectrum to 1/6 oct (hybrid: 1/12 below 200 Hz) | `buildLogBins` `:1439-1453` + call sites | parameterize stepsPerOctave; or build a second coarse grid for focus. |
| Focus time_series 100→40, conditional emit | `:2324` + `compress.js:130` | lower maxPoints; skip emit when <6 kept points. |
| Automation/GR 100→30 | `:1909`,`:1917`,`:2336`,`:2342` | lower maxPoints. |
| Masking 8+8 → 6+6; drop all-clear pairs | `:1527-1528`; `compress.js:192-201` | smaller caps; extend the `insufficient_data` drop to all-clear. |
| Normalize spectral flux (or drop) | `:527-536`,`:1929` | divide by frame energy, or remove field. |
| Strip routing identifier/debug fields from model payload | `compress.js:159-168` | keep only track/voice/failed/silent. |
| LRA percentile interpolation (optional) | `:1803-1806` | linear interp between ranks. |
| Decimation-aware EMA α (if no bulk-read) | `detectOnsets` callers `:2357-2359` | `α' = 1−(1−α)^decimate`. |
| Add `width_ratio` per voice (mono disambiguation) | `analyzeFocus` | `side_rms/mid_rms` linear scalar. |
| Remove `flog()` / `post()` debug scaffolding | `:238-245`, throughout | per `MIXING_SPEC.md:170`, strip for production. |

---

## 7. STRUCTURAL LIMITATIONS (can't fix in M4L — document & communicate)

| Limitation | Status | What to tell the user |
|---|---|---|
| **Focus taps are PRE the parent group's chain** (child Post Mixer). `MIXING_SPEC.md:160`, confirmed by `get_group_chain` auto-fetch in tools.js. | **Accept & document.** | Focus spectra/levels for grouped tracks reflect the child *before* the group's saturation/comp/clipper. The group chain is fetched so the LLM can caveat — make sure the system prompt instructs it to. Nonlinear group processing can't be offset-corrected. |
| **Focus voices have NO true/inter-sample peak** — only FFT-frame RMS (avg + loudest ~93 ms frame). `:2312-2321`. | **Accept & document.** | Never present focus `rms_max` as a sample/true peak. compress.js already labels it `rms_max`/`rms_avg` (good, `:74-83`). For true-peak/clipping checks, only the master number is valid. |
| **FFT-domain (focus) vs time-domain (master) scale** reconciled by single `fftCalibrationDb`. `:1665`, `:2244`. | **Accept; approximate.** | Focus-to-focus comparisons are consistent; focus-to-master *absolute* dB is approximate (assumes a constant linear window/scaling offset — true for level, not for nonlinear chain differences). |
| **Sub-bass resolution is coarse** — ~7 linear FFT bins below 100 Hz (binHz≈10.8 Hz). `MIXING_SPEC.md:24`. | **Accept; partially mitigable.** | Below ~80–100 Hz, individual-note discrimination is unreliable. Mitigate by keeping the **low end of the log grid at 1/12 oct** (hybrid grid, §4.1) so you don't make it worse when coarsening elsewhere. A larger FFT (8192) would help sub resolution but doubles per-frame read cost and latency — not worth it. |
| **Single mc.poly~ box = 8 voices max** without re-saving the device. `:221`. | **Accept.** | 8 is the hard ceiling per capture; tools.js already slices focus to 8 everywhere. |
| **Decimation mistunes EMA without bulk-read.** `:696`, §3.4. | **Fixable JS-side** (rescale α) — not truly structural. | Move to JS-side actions; the structural part (main-thread starvation) is real but the α drift is correctable. |
| **Constant-tempo assumption** for beat-based timestamps. `:678`. | **Accept & document.** | Tempo automation across a capture will drift timestamps. Fine for the vast majority of sections. |

---

## 8. OPEN QUESTIONS for the human (depend on intent/taste/genre)

1. **Signal floor depth (`lufs − 40`, `:2274`).** −40 LU suits dense club/pop. For ambient/sparse/jazz material, −40 may exclude real quiet content; want a genre toggle (−40 dense / −45 sparse)? Memory already stores genre — could key off it.
2. **Drop the masking `verdict` string entirely?** Per your "raw measurements only, LLM interprets" rule (memory `feedback_no_interpretation_in_tools`), the `complementing/masked/mixed` label is a borderline violation. Confirm you want it removed (I recommend yes — keep `masked_bands`/`audible_bands` + `cooccur`).
3. **How aggressively to cut for the 6-voice worst case?** 1/6-oct focus spectrum + 40-pt time series gets *typical* queries under $0.10. Guaranteeing the **6-voice full** query <$0.10 requires also dropping per-voice `sm` (width). Is per-track width per-band ever load-bearing for your verdicts, or is master width enough?
4. **Transient bands: 3 vs 4?** 4 bands (add a presence/click split) is more pro-accurate but adds payload to every voice's `transients`. Worth it, or hold at 3 with the crossover moved to 3 kHz?
5. **Spectral flux: keep (normalized) or drop?** Does any part of your system prompt actually act on it? If not, dropping is free cost savings.
6. **Master time_series 200 pts — needed?** 200 is generous for an 8-bar section; 120 would save tokens with no real loss unless you're doing fine envelope analysis on the master.

---

*Reviewed against code as of 2026-06-07. Where Max-side behavior couldn't be confirmed from JS (kms block window §2.2, pfft~ window §5, S-channel wiring §2.4), the item is flagged as a verification task rather than a confirmed defect.*
