// Haiku-powered findings extraction. After Claude responds with mix analysis,
// this extracts the concrete findings as bullets so the raw tool result
// payloads (~30KB+ for analyze_section) can be replaced with a ~200-byte
// summary on subsequent turns. Findings carry forward; raw payloads don't.
//
// Floating family alias — tracks the latest Haiku 4.5 release automatically.

import Anthropic from "https://esm.sh/@anthropic-ai/sdk@0.32.1";

const HAIKU_MODEL = "claude-haiku-4-5";

const EXTRACTION_SYSTEM = `Extract the REASONING STEPS the assistant took in this turn AND the findings each step produced. The goal is to preserve the methodology so the assistant can re-trace and audit its own logic in future turns. Raw numbers are kept when the question was numeric; qualitative conclusions are kept when the question was analytical — together with the supporting measurements that earned the conclusion.

Output format: numbered list, one step per line, format:
N. [METHOD or SOURCE] → [FINDING]

Each step pairs WHAT was done with WHAT it produced. For a simple lookup, the finding is the measurement. For an analysis, the finding is the qualitative conclusion AND the numbers that grounded it.

Good examples:
1. analyze_section(BUILD1→DROP) → integrated -23.9 LUFS, true peak -10.5 dBTP, LRA 8 LU
2. Compared SUB time_series baseline (~16dB) to value at kick frames → drop -22dB, recovery in 2 frames (ducking confirmed, not masking)
3. Read sm[] spectrum for PAD at 130-200Hz → ~-2dB (wide in that band)
4. Cross-checked master stereo_correlation → 0.98 broadband; mass-weighted by mono lows, doesn't contradict per-band width
5. get_track_devices on SUBS → Compressor2 active, Ducker (M4L, opaque) — sidechain present
6. Compared KICK and BASS time_series + spectrum → phase-aligned, no anti-correlation (interference unlikely)

ALWAYS preserve concrete measurements the message reports, even when stated as a plain data dump with no analysis (e.g. "KICK peak [16.9, 16.9], rms [15.3, 15.3]"). For a pure data dump, the method is the tool and the finding is the values verbatim — list them so the assistant can cite and defend them later. A message containing numbers is NEVER NONE.

Skip: recommendations ("you should..."), subjective adjectives without a method behind them ("muddy", "tight"), narrative prose, restating the user's question.

Output NONE only when the message contains NO measurements and NO reasoning at all — a clarifying question, chitchat, an error report with no data, or an ask_user_choice prompt.`;

export async function extractFindings({ apiKey, assistantText }) {
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
  try {
    const resp = await client.messages.create({
      model: HAIKU_MODEL,
      max_tokens: 512,
      system: EXTRACTION_SYSTEM,
      messages: [{ role: "user", content: `Assistant message:\n\n${assistantText}` }]
    });
    const text = resp.content.map(b => b.text || "").join("").trim();
    const usage = {
      input: resp.usage?.input_tokens || 0,
      output: resp.usage?.output_tokens || 0
    };
    if (!text) return { ok: false, classification: "malformed", error: "empty response", usage };
    if (text === "NONE") return { ok: true, findings: null, usage };
    return { ok: true, findings: text, usage };
  } catch (e) {
    return { ...classifyError(e), usage: { input: 0, output: 0 } };
  }
}

function classifyError(e) {
  const status = e?.status;
  const errType = e?.error?.type || "";
  const msg = e?.message || String(e);
  if (status === 401 || status === 403) return { ok: false, classification: "auth", error: msg };
  if (status === 400) return { ok: false, classification: "bad_request", error: msg };
  if (status === 429 || status >= 500 || errType === "overloaded_error" || /timeout|network|overload|fetch/i.test(msg)) {
    return { ok: false, classification: "transient", error: msg };
  }
  // Unknown — treat as transient (safer to retry)
  return { ok: false, classification: "transient", error: msg };
}

// Internal retry: 3 attempts over ~7s with exponential backoff for transient
// errors. Auth and bad_request fail fast. Accumulates usage across attempts.
export async function extractWithRetry(params) {
  let lastResult = null;
  let totalIn = 0, totalOut = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await extractFindings(params);
    totalIn += result.usage?.input || 0;
    totalOut += result.usage?.output || 0;
    lastResult = result;
    if (result.ok) return { ...result, usage: { input: totalIn, output: totalOut } };
    if (result.classification === "auth" || result.classification === "bad_request") break;
    if (attempt < 2) await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
  }
  return { ...lastResult, usage: { input: totalIn, output: totalOut } };
}
