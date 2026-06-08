# Architecture Audit — §14 "Correct-approach redesign"

*Independent examiner audit, 2026-06-07. Audited against `docs/MIXING_SPEC.md` (whole file, §14 focus) and `device/live_query.js` (verified line-by-line where claims touch code). Prime directive under test: **can any part ever hand the AI a wrong or misleading number?***

---

## 1. Verdict & grade

**Grade: B (MAJOR leaks present).**

One-line justification: the masking redesign's core diagnosis (duty-cycle dilution) is **correct and well-grounded**, but the redesign as written contains at least two MAJOR leaks that send the AI wrong numbers under common conditions — the **"online per-tick" masking claim is false against the actual capture architecture** (onset detection and band series are computed *post-capture* on stored arrays, so the "no frame history" + "O(bins×voices)" memory claim cannot hold for transients, and the masked_pct counter as specified will be **statistically unstable for sparse elements**), and the **cross-voice phase pipeline cannot guarantee sample/frame alignment across separate focus taps**, which silently corrupts coherence and phase. A+++ is not earnable until these are closed.

It is **not** "no leaks." A prior reviewer's "no leaks" is exactly the failure pattern flagged in the brief.

---

## 2. LEAKS (ranked by severity)

### [MAJOR] L1 — `masked_pct = masked_frames/present_frames` is statistically unstable for sparse elements
- **Location:** §14.2 (output line) and §14.7 (counter primitive).
- **Scenario:** A clap hits 8× in 8 bars. With AR release ~20–40 ms at HF, `present_frames` for the clap's HF bands may be only a handful of frames per hit — possibly 20–40 present frames total over the whole capture. `masked_pct` is then a ratio of small integers. One or two borderline frames swing it across the 0.3 emit gate. The headline "buries the clap in 85% of its sounding frames" can read 85% or 40% depending on noise in the envelope follower near threshold. **The AI receives a confidently-precise percentage built on ~20 samples.**
- **Why it's real:** the spec itself notes this risk in the brief ("few present frames → noisy ratio") and §14 never addresses it. There is no minimum-`present_frames` guard, no confidence interval, no labeling.
- **Fix:** (a) require `present_frames ≥ N_min` (e.g. ≥ ~15–20 actual onsets-worth of frames) before emitting a pair/band, else suppress or label `low_confidence`; (b) emit `present_frames` itself alongside `masked_pct` so the AI can weight it. Per the foolproofing doctrine #5, an undersampled ratio is a guess dressed as a measurement.

### [MAJOR] L2 — "Online, each snapshot tick" + "no frame history" is FALSE for transients/ducking; memory is NOT O(bins×voices)
- **Location:** §14.2 ("Online, each snapshot tick … No frame history"), §14.6 ("no stored frame history"), §14.7 ("memory O(bins×voices), independent of capture length").
- **Code reality:** `detectOnsets` (`live_query.js:284`) runs **post-capture** over the full stored `focusBandSeries[voice]` array (built every tick at `:487`), and `transientDensity` (`:1930`) runs over the full stored `timeSeries`. The onset detector is a causal dual-EMA *but it is invoked after capture on a retained per-frame array*, not online. The kick onset list — which §14.4/§14.7 make the **reference clock for ducking** — is therefore derived from a stored frame series. Ducking ("sample the envelope around each kick onset") **also** requires retaining the per-frame envelope to look up windows around each onset beat.
- **Scenario where it bites:** the claim "memory O(bins×voices), independent of capture length" is used to justify the whole storage-primitive doctrine. For a master-only capture spanning to the next locator (uncapped, §1) the retained `timeSeries`/`focusBandSeries` grow with capture length. If the redesign is implemented believing memory is bounded and the per-frame arrays are dropped, **transient detection and ducking break** (return empty/garbage), and the AI is told "no onsets / not sidechained" when the element is in fact transient/ducked. That is a wrong number to the AI.
- **Fix:** either (a) make onset detection genuinely online (run the dual-EMA inside the snapshot tick, push only event beats — feasible, the EMA is causal), and make ducking accumulate per-onset depth online (requires the kick onset clock to exist *before* other voices are processed, i.e. a two-pass or a designated kick voice processed first); or (b) honestly restate the memory claim as O(bins×voices) **for masking/level/phase only**, with transients/ducking still O(frames) unless converted. As written §14.7 overstates.

### [MAJOR] L3 — Cross-voice phase: no guarantee the two voices share the same FFT frame/window/sample alignment
- **Location:** §14.3 ("Between-element cancellation … accumulate IN DSP ΣRe(A·conj B) …"), and the brief's explicit alignment question.
- **Why it's real:** the cross-spectrum `A·conj(B)` is only meaningful if A and B are the **same time block** transformed by the **same window at the same sample offset**. The current architecture runs **separate `pfft~` instances per voice** (one per `mc.poly~` voice / focus tap). Nothing in §14.3 or the existing patch guarantees the per-voice `pfft~` windows are phase-locked sample-for-sample. Any fixed inter-voice latency (different device chains on the two child tracks, plugin latency, PDC differences) shifts B relative to A by Δt; the cross-spectrum then carries a **frequency-proportional phase ramp φ(f)=2πfΔt that is an artifact, not a real phase relationship**. Coherence can still read high (the relationship is *stable*, just wrong), so the coherence gate does **not** catch it.
- **Scenario:** KICK and SUB on tracks with different plugin latencies. The tool reports "140° out of phase at 55 Hz, losing 5 dB — flip phase," when the 140° is pure latency skew. The producer flips phase and makes it worse. **Wrong, confidently-stated number.**
- **Fix:** (a) ensure all focus taps are PDC-compensated to a common reference (Live's delay compensation helps only if taps are at equivalent points — they are Post-Mixer pre-group, so child-chain latency differences remain); (b) explicitly measure/subtract the broadband group delay before reporting per-band phase, OR restrict the between-element phase tool to same-bus or known-aligned pairs and **label** cross-track phase as latency-sensitive (doctrine #5). This is the single highest-risk new build and §14.3 treats alignment as solved when it is not.

### [MAJOR] L4 — Coherence is biased HIGH for few averages; the γ²>0.5 gate does not fix it and can leak phantoms
- **Location:** §14.3 (coherence estimator + γ²>0.5 gate).
- **Why it's real:** the magnitude-squared coherence estimator `γ²=(ΣRe²+ΣIm²)/(Σ|A|²·Σ|B|²)` is a classic biased estimator. With `n_d` independent averaging segments, **E[γ̂²] ≈ γ² + (1−γ²)/n_d**. For two uncorrelated signals (true γ²=0) with only n_d=2 segments, the *expected* estimate is ~0.5 — i.e. **random-phase garbage clears the 0.5 gate roughly half the time**. A short capture (a few bars) at a 4096/overlap-4 hop yields few independent windows per band, especially in the sub where there are few cycles. §14.3 even names this in the brief and §14 does not address it.
- **Scenario:** short 2-bar capture, two unrelated wide elements → coherence estimate jitters above 0.5 → the tool emits a phantom "cancellation, 0.6 coherence." Exactly the phantom the gate was supposed to prevent.
- **Fix:** (a) raise the gate as a function of segment count: require γ̂² > 1/n_d + margin, or apply the bias correction `γ²_corr = (n_d·γ̂² − 1)/(n_d − 1)`; (b) require a minimum number of independent averages (capture-length / hop) before any phase output, and label short captures; (c) report n_d so the AI can discount. **Without this, the "coherence prevents phantoms" claim is false at small n.**

### [MINOR] L5 — `|M|` mono-compat formula `20·log10(|M|/rms(|L|,|R|))` mislabels mid-panned content as cancellation
- **Location:** §14.3 ("Within-element mono compatibility … `mono_retain_dB = 20·log10(|M|/rms(|L|,|R|))`").
- **Why it's real:** M=(L+R)/2. For a hard-panned-but-coherent source (say all in L), |M|=|L|/2 while rms(|L|,|R|)=|L|/√2, giving mono_retain ≈ 20·log10((1/2)/(1/√2)) = **−3 dB** even with **zero phase cancellation** — it's just the level loss of summing a one-sided signal. The metric conflates *pan-induced sum level change* with *phase cancellation*. Reported to the AI as "this band cancels in mono" when nothing cancels.
- **Fix:** define mono-compat against the *coherent* sum reference, or compare |M| to the in-phase expectation, or restrict the "cancellation" interpretation to bands where side energy and a negative real cross-term dominate. At minimum, document that mono_retain mixes pan and phase, so the AI doesn't over-call. (Note: the spec's §14.6 table separately says to interpret `sm>0 = mono cancellation`, which is the **same conflation** — width is not cancellation.)

### [MINOR] L6 — AR follower start-up transient and metro/ballistics mismatch (the LUFS-metro bug, again)
- **Location:** §14.2 (AR envelope, "fast attack ~5 ms," "release 150–250 ms sub / 20–40 ms HF"), tension with §1 (`FRAME_DT_BEATS` tempo-locked 128n).
- **Why it's real:** the spec ties release to **milliseconds** but the snapshot metro is **tempo-locked (128n)**, exactly the failure mode the spec elsewhere flags (§2: "the metro does NOT drive LUFS" precisely because tempo-locked timing breaks ms ballistics; §7 already had to rescale EMA α for decimation). A 5 ms attack is shorter than a single frame (~14 ms at 134 BPM, longer at slow tempo) — the "fast attack everywhere to catch onsets" cannot resolve onsets finer than one frame, and the per-band release in ms must be converted to per-frame α **using the live frame dt** (tempo- and decimation-dependent) or the ballistics are wrong at non-default tempos. Also the first frames before the follower settles bias `present_frames` low. §14.2 specifies the time constants in ms without specifying the ms→α conversion against the tempo-locked frame clock.
- **Fix:** convert all AR time constants to α per the *actual* frame dt at capture time (as `adjAlpha` already does for decimation, `:2517`) and re-derive on tempo change; warm up the follower (skip first ~N frames from counters) or seed it. Document that onset timing resolution is frame-bound.

### [MINOR] L7 — Removing `time_series` is mostly safe, but two internal reductions are asserted equivalent without proof
- **Location:** §14.4 ("keep the internal reductions … convert to running accumulators").
- **Verified safe:** OUTPUT `time_series` has **no non-AI consumer** — confirmed: `compress.js` only reshapes it (`:114`,`:131`), nothing computes from it. Master calibration uses `fftRmsMean = mean over timeSeries` (`:1736`) which **is** a pure running mean — safe to accumulate. Focus `rms_avg` is a mean and `rms_max` a max (`timeStats`, `:1682`) — safe as running accumulators.
- **The catch:** `transientDensity` (`:1930`) needs **mean + stdev + local-maxima count** over the series — a running accumulator can hold mean and stdev (sum, sum-of-squares) but **local-maxima detection needs the ordered series** (it compares `lVals[j]` to neighbors). You cannot reduce that to O(1) without keeping the sequence or detecting maxima online. §14.4 lists transient density under "needs only a reduction (peak-count)" — a peak-count is **not** a pointwise reduction; it's a sequence operation. Same class of error as L2.
- **Fix:** detect master transient maxima online (track previous two frames) and increment a counter; do not claim it as a simple accumulator.

### [MINOR] L8 — Live-doc inconsistency: frame rate documented as both 128n and 64n
- **Location:** `live_query.js:24` `FRAME_DT_BEATS=0.03125` (1/32, =128n) vs in-code comments `:526` "Metro fires every 64n … 1/16 beat" and `:1947` "64n = 1/16". §1 of the spec says 128n.
- **Why it matters for the AI:** `transientPerBeat` and all beat-stamped outputs scale by `FRAME_DT_BEATS`. The constant (0.03125) is internally consistent in the math, but the **conflicting comments mean nobody knows the true patch metro**, and the AR ms→α conversions in the redesign depend on knowing it exactly. If the patch metro is actually 64n while the constant says 128n, **every beat timestamp and per-beat density is off by 2×** — a wrong number to the AI. Resolve and verify against the .amxd before building AR ballistics on top.

---

## 3. DSP / math correctness check

**§14.3 Coherence** `γ² = (ΣRe²+ΣIm²)/(Σ|A|²·Σ|B|²)`:
- **Form is correct** (magnitude-squared coherence: |Σ A·conj B|² / (Σ|A|²·Σ|B|²), and |Σ A·conj B|² = (ΣRe)²+(ΣIm)² = ΣRe²+ΣIm² *only if* "ΣRe²" means (ΣRe)² — i.e. square-of-sum, not sum-of-squares). **The notation in §14.3 is ambiguous and a literal reading is WRONG.** It must be **(ΣRe)² + (ΣIm)²** (square the accumulated sums), NOT Σ(Re²)+Σ(Im²). If implemented as sum-of-squares it is not coherence at all and would be garbage. Flag explicitly. Also requires averaging over independent segments to be meaningful (L4) — and is biased high at small n (L4).

**§14.3 Phase** `φ = atan2(ΣIm, ΣRe)`: **correct** (argument of the averaged cross-spectrum). Caveat: corrupted by inter-voice latency (L3).

**§14.3 Cancellation** `ΔdB = 10·log10((Σ|A|²+Σ|B|²+2ΣRe)/(Σ|A|²+Σ|B|²))`: **correct in form** — |A+B|² = |A|²+|B|²+2Re(A·conj B), summed. Numerator is the mono-sum power, denominator the incoherent-sum power; negative ΔdB = energy lost. **Valid only where the cross-term is from aligned blocks (L3).** Note this is cancellation of A+B (full sum), distinct from the (L+R)/2 mono fold — fine, but the two must not be conflated in output.

**§14.2 ERB spreading + power-sum threshold** (carried from current `mgThresholdCurve`, `:1517`): the power-sum of excitations is **standard and correct** (additive masking). The level-dependent upward slope (`:1502`) is grounded (loud maskers spread more). **Computing it per-frame online**: the cost claim ("20–25k ops/tick, negligible") — the threshold curve is **O(bins²)** per masker (`:1521` nested loop, 60×60=3600) ×N maskers ×N signals per pair. With a precomputed 60×60 spread matrix it drops to O(bins²) matrix-vector per voice per tick. At 8 voices, ~8×3600 = ~29k mults/tick for thresholds + pair compares — **plausible on Max's single-threaded JS but NOT "negligible next to 2048-bin reads"**: the reads are 8 voices × 4 channels × 2048 = ~65k simple array reads, the masking adds a comparable load *every tick* that today runs *once* post-capture. The "online" move multiplies masking cost by frame-count. Buildable, but the cost claim is optimistic — verify against main-thread budget at the snapshot rate before committing (this is what drove decimation in the first place, §11).

**§14.2 per-band frequency-dependent release** (150–250 ms sub, 20–40 ms HF): **defensible.** Grounded in (a) narrow low ERBs ring longer and (b) shorter forward masking / finer temporal resolution at HF. The specific numbers are in the right order of magnitude for forward-masking tails (forward masking decays over ~100–200 ms). Reasonable, not hand-wavy. Caveat: must be converted to per-frame α against the live frame dt (L6).

**§14.1 duty-cycle-dilution diagnosis: VERIFIED CORRECT.** Confirmed against code: `avgM[i] = accum.M[i] / frameCount` (`:2444`) averages magnitude over **all** frames including silence, and `voiceSpecDb[...] = f_m` (`:2462`) feeds that average straight into masking. A clap sounding 1/8 of the time reads ~9 dB (20·log10(8)) low. The diagnosis is exactly right and is the strongest part of §14.

---

## 4. Max → JS → AI feasibility check

- **Online masking counters (§14.2):** buildable in JS (no new Max). But "online per tick" contradicts the current post-capture flow (L2) and the cost claim is optimistic (§3). **Feasible with restated cost + counter guards.**
- **Cross-spectrum phase (§14.3):** requires **new Max-side infrastructure that does not exist** — current buffers (`specL/R/M/S`) carry **magnitude only**; there is no real/imag tap and no per-pair cross-spectrum accumulator. Building "four running sums per bin per pair into buffers" means **O(N²) pairs × 2048 bins × 4 buffers** = for 8 voices, 28 pairs × 8192 = ~230k buffer slots, plus the DSP graph to compute A·conj(B) per pair in `gen~`/`pfft~`. This **strains the same channel/voice limits** that capped focus at 8 voices (§1: "Device exposes channels for this many parallel taps after device-save committed I/O"). N² pair accumulation in DSP is the part most likely to blow up the patch. The §14.5 implementation order **wisely defers the full complex tap** ("skip the full complex tap unless needed") — that hedge is correct and should be treated as the plan, not the fallback.
- **Cross-voice alignment (§14.3):** **not guaranteed** by the architecture (L3). Same-FFT-frame requirement across separate `pfft~` taps is unverified.
- **Bridge:** reading accumulated cross-spectrum arrays via `Buffer.peek` hits the **same bulk-read path already documented** (`:251`, `:462`); chunked transfer (`:251`, 8000 chars) handles output. No new bridge limit *if* the per-pair sums are reduced to ~60 log-bins before send (don't ship 2048 raw bins × 28 pairs).
- **Within-element mono-compat (`|M|`):** free in JS from existing M/L/R magnitudes — buildable, but the formula leaks (L5).

---

## 5. Claims audit

| Claim (§14) | Verdict | Evidence |
|---|---|---|
| "OUTPUT time_series has no consumer but the AI" | **VERIFIED** | `compress.js` only reshapes (`:114/:131`); no computation depends on output field. |
| "Duty-cycle dilution mis-scales every transient masking margin" | **VERIFIED** | `avgM=accum/frameCount` `:2444` → `voiceSpecDb` `:2462`; average over all frames incl. silence. |
| "memory O(bins×voices), independent of capture length" | **OVERSTATED / FALSE for transients+ducking** | onset/density/ducking need the per-frame series (`detectOnsets:284` post-capture on `focusBandSeries`; `transientDensity:1930`). True only for masking/level/phase/tonal. (L2, L7) |
| "Online, each snapshot tick … no frame history" | **OVERSTATED** | current detection is post-capture on stored arrays; making it online is possible but unbuilt. (L2) |
| "temporal masking modeled for free by the release ballistics" | **VERIFIED (conceptually sound)** | release tail ≈ forward-masking tail; valid approximation, given correct ms→α conversion (L6). |
| "coherence prevents phantoms / never hand the AI a phantom phase issue" | **FALSE at small n** | MSC biased high; E[γ̂²]≈γ²+(1−γ²)/n_d clears 0.5 for random phase at few segments. (L4) |
| "calibration-immune ratios (masked_pct, coherence, mono_retain, cancel_dB)" | **MOSTLY VERIFIED, one caveat** | ratios/differences cancel the cal offset — true. BUT `masked_pct` rides on the **presence gate threshold** and AR follower (so it's immune to *calibration* but sensitive to the *gate*, L1); `mono_retain` conflates pan w/ phase (L5). |
| "`|M|` is the post-mono-sum magnitude usable for mono-compat" | **VERIFIED (M formed in time domain)** | M=(L+R)/2 channel `:445/:2452`; |FFT(M)| is the mono-sum spectrum. Sound. (interpretation leaks, L5) |
| "replaces cooccur + all ad-hoc gates with single number masked_pct" | **OVERSTATED** | still needs a presence-gate threshold (a new ad-hoc threshold) and a min-frames guard; not gate-free. |
| "20–25k ops/tick, negligible" | **OPTIMISTIC** | masking is O(bins²)×voices *per tick* now vs once post-capture; comparable to the bin reads, not negligible. (§3) |

---

## 6. What's missing (where the real leaks hide)

1. **No min-`present_frames` / confidence handling** for masked_pct (L1) — the single biggest unaddressed accuracy hole.
2. **No inter-voice latency / PDC alignment treatment** for cross-voice phase (L3) — §14.3 assumes alignment silently.
3. **No coherence bias correction / minimum-averages rule** (L4).
4. **No ms→α conversion spec** for the AR follower against the tempo-locked, decimation-variable frame clock (L6) — the exact class of bug §2 and §7 already had to fix twice.
5. **Ducking edge cases enumerated in the brief are not addressed in §14.4:** no kick present (no reference clock → ducking undefined, must emit "no reference" not "not ducked"); multiple kick layers (which onset list is the clock?); polymetric/half-time ducking (recovery_beats assumes a single period). Each can hand the AI a wrong "not sidechained" / wrong recovery number.
6. **Pre-group-chain tap (§12.1) interaction unacknowledged in §14:** masking, phase, and mono-compat are all computed on the **child Post-Mixer** signal, *before* the parent group's saturation/comp/clipper. A group bus clipper can re-introduce phase/level relationships the per-voice phase tool never sees, and masking margins measured pre-group don't reflect what hits the master. §14 never states that its new measurements inherit this limitation — so the AI may present "kick/sub cancel 5 dB" as a master-bus fact when it's a pre-group child fact.
7. **Window/coherent-gain assumption** (§1 🚩, §12 C "pfft~ window unverified") flows into the cross-spectrum: if the window isn't the assumed Hann, |A|²/|B|² normalization and the cal offset shift. Phase is window-robust but cancellation ΔdB rides on magnitudes.
8. **SR≠48k** is labeled for LUFS but §14's new metrics (band center freqs, ERB mapping, ms↔frame) **also** depend on SR; §14.7 #5 claims estimates are labeled but doesn't enumerate the new SR-dependent ones.

---

## 7. Path to A+++

Minimal set of fixes that would earn the grade:

1. **L1:** add `present_frames ≥ N_min` guard + emit `present_frames`; suppress/label low-confidence masked_pct.
2. **L2/L7:** either make onset detection + master-transient maxima + ducking-envelope **genuinely online** (causal EMA inside the tick, event/counter output), or restate the memory claim honestly (O(bins×voices) for masking/level/phase only; transients/ducking O(frames)).
3. **L3:** PDC-align focus taps or measure-and-subtract broadband group delay before per-band phase; otherwise restrict between-element phase to aligned pairs and **label** cross-track results latency-sensitive.
4. **L4:** coherence bias correction `(n_d·γ̂²−1)/(n_d−1)` + minimum-averages rule + emit `n_d`; raise the gate at small n.
5. **L5:** redefine mono_retain so pan-induced sum loss is not reported as cancellation (and fix the §14.6 "sm>0 = mono cancellation" line).
6. **L6:** specify ms→α conversion against the live frame dt (reuse `adjAlpha` pattern) and re-derive on tempo change; warm up the follower.
7. **Doc:** resolve the 128n/64n inconsistency (L8) against the actual .amxd; add a sentence to §14 that masking/phase/mono-compat inherit the pre-group-chain limitation (§12.1) and the SR≠48k label set.
8. **Fix the coherence notation** to unambiguously mean **(ΣRe)²+(ΣIm)²** (square-of-sum), not Σ(Re²).

Close L1–L4 (the MAJORs) and the redesign goes from B to A; close all eight plus the doc/notation items and it earns A+++.
