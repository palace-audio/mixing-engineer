# Max-side verification — needs you in the Max editor

The 2026-06-07 optimization pass fixed everything that's fixable in JS. Three things
can only be confirmed/fixed inside the `.amxd` patch. They're ordered by impact.
Each: **what to find → what's correct vs broken → how to fix.** You don't need to
change anything blind — for A and B, just *check* and tell me what you see.

---

## A. LUFS windowing  — ✅ RESOLVED, but two follow-ups

**Windowing is correct** (you sent the chain): `biquad~ → *~ (square) → average~ →
snapshot~ 100 → kms_*`. `average~ 19200` = 400 ms @48k (momentary/integrated),
`average~ 144000` = 3 s @48k (short-term), `snapshot~ 100` = 100 ms hop (BS.1770's 75 %
overlap). The musical metro does NOT drive LUFS. Nothing to fix here. But the chain
surfaced two real problems:

### A2. K-weighting  — ✅ RESOLVED

Both biquads confirmed: shelf (`1.535125 -2.691696 1.198393 -1.690659 0.732481`) → RLB
high-pass (`1. -2. 1. -1.990047 0.990072`), correct order. Full BS.1770 K-weighting.
Nothing to do.

### A3. Sample rate  — DECISION: run at 48 kHz

Stock-object SR-awareness isn't clean: `average~`'s window length is a creation argument
and **can't be resized at runtime**, so the 400 ms / 3 s windows are locked to 48k sample
counts (`19200` / `144000`). Pushing SR-correct biquad coeffs from JS would only fix the
filter half and leave an ~8.75 % window error at 44.1k. A fully SR-independent version
means a `gen~` rewrite of the filter+window section — not worth it.

**Run the Ableton session at 48 kHz** (you already prefer this — it's the pro default and
makes every BS.1770 constant exact, zero added complexity). **Safety net (added JS-side):**
if the session is ever NOT 48k, `live_query.js` posts a console warning and tags the LUFS
block with `sr_note` so the AI presents loudness as approximate — you can't be silently
misled. No further patch work needed.

---

## B. Stereo tap wiring  — fixes the "everything reads mono" bug

**Why it matters:** you saw all groups read mono when only KICKBASS should be. The JS
M/S math (`sm = side−mid`, `stereo_correlation`) is provably correct — so the all-mono
read comes from the **signal reaching the analyzer being mono** (S=(L−R)/2 ≈ 0).

**First, re-run a capture with the new code** and look at the new `width_ratio` field per
focus track (0.00 = truly mono, →~1 = wide):
- If known-stereo elements (PERCUSSION, AMBIANCE, etc.) now show `width_ratio > 0` → it
  was a display/`sm`-floor artifact and it's effectively resolved; nothing to do.
- If they STILL show `width_ratio = 0.000` → the tap genuinely carries mono. Continue:

**What to find / check:**
1. **`specS` derivation.** In the focus analyzer patch (`spectrum_analyzer_focus_N` and
   master), confirm S = `(L − R) · 0.5` — i.e. an actual `-~` of the two channels with a
   `*~ 0.5`, not `(L+R)` and not a single channel. M = `(L + R) · 0.5`.
2. **The two pfft~/fftin~ inputs really differ.** Each focus voice's `pfft~` must receive
   a genuine stereo pair (`in~ 1` ≠ `in~ 2`). If both inlets get the same signal, S is 0
   by construction → mono for everything.
3. **The routed source is stereo.** `setFocusRouting` routes each voice to the track's
   **Post Mixer** input pair (channels 5/6, 7/8, …). Confirm in Live that the routed
   tracks are stereo at that point and the device's `plugin~` pairs receive distinct L/R
   (a mono clip/instrument legitimately reads mono — that's not a bug).

**Fix:** depends on which of 1–3 is wrong; report which and I'll guide the specific patch
change. Most likely culprit (per the expert review) is #3 — a tap pulling a mono leg.

---

## C. pfft~ window function  — LOW priority (master spectrum only)

**Why it matters (small):** `bandEnergyDb` on the **master** divides FFT magnitude by
`NUM_BINS/2` assuming a Hann window (coherent gain 0.5). If the window is something else,
the master's *absolute* spectrum dB is off by a constant. Focus voices are unaffected —
they self-calibrate via the measured `fftCalibrationDb`. Master peak/RMS/LUFS are
time-domain, also unaffected. So this only shifts the master spectrum's absolute dB.

**What to check:** open the analyzer subpatch, confirm the `pfft~` is running a Hann
(Hanning) window at overlap 4. **Fix if not:** either switch the window to Hann, or tell
me the actual window and I'll adjust the coherent-gain constant in `bandEnergyDb`.

---

*Reload the device after any patch change (assumed — you always reload). Once A and B are
confirmed/fixed, the loudness numbers and the stereo reads are trustworthy end-to-end.*
