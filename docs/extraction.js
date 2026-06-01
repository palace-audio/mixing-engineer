// Haiku-powered findings extraction. After Claude responds with mix analysis,
// this extracts the concrete findings as bullets so the raw tool result
// payloads (~30KB+ for analyze_section) can be replaced with a ~200-byte
// summary on subsequent turns. Findings carry forward; raw payloads don't.
//
// Model is pinned to a specific snapshot so behavior doesn't drift when
// Anthropic releases new Haiku versions.

import Anthropic from "https://esm.sh/@anthropic-ai/sdk@0.32.1";

const HAIKU_MODEL = "claude-haiku-4-5";

const EXTRACTION_SYSTEM = `Extract concrete findings from a mix-engineering AI assistant message. Findings are specific measurements, identified issues, and confirmed state — never recommendations or what the user should do.

Output format: dash-prefix bullets, one per line, no preamble, no closing. Keep each bullet under 80 chars.

Good findings:
- masking 400-600Hz between KICK and SUBS
- master integrated LUFS -10.4, true peak -1.1dBTP
- compressor on DRUMBUSS pulling 3-5dB GR sustained
- side-mid imbalance: side energy -6dB below mid at 2-4kHz
- transient density 4.2/sec — sparse for the genre

Skip: prose, narrative, suggestions, "you should...", subjective adjectives like "good"/"muddy" unless the assistant gave a concrete measurement to back it.

If the assistant message has no extractable findings (e.g. it's a clarifying question or chitchat), output a single line: NONE`;

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
