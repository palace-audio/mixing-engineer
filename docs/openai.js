import { SYSTEM_PROMPT } from "./anthropic.js";
import { tools } from "./tools.js";
import { dispatchToolCall } from "./session_common.js";

// OpenAI-PROTOCOL client (not OpenAI-the-company): one HTTP client that drives
// every provider speaking the Chat Completions API — Ollama and LM Studio
// (local, free) and OpenRouter (cloud gateway, paid). The whole point of the
// provider abstraction is that these differ only in baseUrl + model + key, so
// there is one class here, not three integrations. Mirrors ClaudeSession's
// constructor / callback / send() contract exactly; app.js can swap either in
// without knowing which is live.

const PROVIDER_PRESETS = {
  ollama:     { baseUrl: "http://localhost:11434/v1", local: true },
  lmstudio:   { baseUrl: "http://localhost:1234/v1",  local: true },
  openrouter: { baseUrl: "https://openrouter.ai/api/v1", local: false },
  custom:     { baseUrl: "", local: false }
};

// OpenRouter asks integrators to identify themselves for its rankings; harmless
// elsewhere (other servers ignore unknown headers).
const OPENROUTER_REFERER = "https://palace-audio.github.io";
const OPENROUTER_TITLE = "Palace Audio Mixing Engineer";

// Output headroom for a full multi-section FIX SEQUENCE answer — same sizing
// and reason as anthropic.js (a 2048 cap once truncated long answers). NOTE for
// local: the stable system+tools prefix is ~18.6k tokens, so the model must be
// run with a context window large enough to hold prefix + history + this output
// (e.g. Ollama num_ctx). That's a model-config concern, not something to paper
// over here with a smaller cap.
const DEFAULT_MAX_TOKENS = 16384;

// Anthropic tool schemas ({name, description, input_schema}) → OpenAI tool
// schemas ({type:"function", function:{name, description, parameters}}). The
// input_schema IS a JSON Schema, so it passes straight through as `parameters`
// — oneOf / enum / minItems and friends are all valid there. One pure function
// covers every tool; nothing tool-specific lives here.
export function toOpenAITools(anthropicTools) {
  return anthropicTools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema
    }
  }));
}

// fetch() rejects with no HTTP status on a network/CORS failure — the #1 local
// snag. Turn that opaque TypeError into an actionable, provider-aware hint.
function unreachableHint(provider, base) {
  if (provider === "ollama")
    return `Couldn't reach Ollama at ${base}. Confirm 'ollama serve' is running and that OLLAMA_ORIGINS trusts this page's origin (set it to the exact origin, never '*', and leave OLLAMA_HOST on 127.0.0.1). Serving the device locally removes the CORS grant entirely.`;
  if (provider === "lmstudio")
    return `Couldn't reach LM Studio at ${base}. Start its local server and turn on CORS in the server settings.`;
  if (provider === "openrouter")
    return `Couldn't reach OpenRouter at ${base}. Check your network and that the endpoint is correct.`;
  return `Couldn't reach ${base}. Check the endpoint is running and reachable from this page (CORS / network).`;
}

export class OpenAICompatSession {
  constructor({ provider, baseUrl, model, apiKey, maxTokens,
                onText, onToolStart, onDone, onError, onUsage, onAskUserChoice }) {
    const preset = PROVIDER_PRESETS[provider] || PROVIDER_PRESETS.custom;
    this.provider = provider || "ollama";
    this.baseUrl = (baseUrl || preset.baseUrl || "").replace(/\/+$/, "");
    this.model = model || "";
    this.apiKey = apiKey || "";
    this.maxTokens = maxTokens || DEFAULT_MAX_TOKENS;
    // Translate the shared tool schemas once; they never change within a session.
    this.openaiTools = toOpenAITools(tools);
    this.messages = [];
    this.onText = onText;
    this.onToolStart = onToolStart;
    this.onDone = onDone;
    this.onError = onError;
    this.onUsage = onUsage;
    this.onAskUserChoice = onAskUserChoice;
    this.totalInputTokens = 0;
    this.totalOutputTokens = 0;
    this.totalCostUsd = 0;
    // Stream by default. Auto-flips to one-shot for the rest of the session if a
    // server garbles streamed tool-calls — a real, model/server-dependent quirk.
    this.stream = true;
  }

  _headers() {
    const h = { "Content-Type": "application/json" };
    if (this.apiKey) h["Authorization"] = `Bearer ${this.apiKey}`;
    if (this.provider === "openrouter") {
      h["HTTP-Referer"] = OPENROUTER_REFERER;
      h["X-Title"] = OPENROUTER_TITLE;
    }
    return h;
  }

  // POST /chat/completions with transient-error retry, mirroring anthropic.js
  // _streamWithRetry. Returns the OK Response with its body UNREAD so the caller
  // chooses how to consume it (.json() for one-shot, or read the SSE stream).
  // The stable system+tools prefix is prepended every turn (never stored in
  // this.messages) so the history holds only the conversation; servers
  // prefix-cache that prefix automatically — no cache code.
  async _fetchChat(stream, maxRetries = 4) {
    const url = `${this.baseUrl}/chat/completions`;
    const body = JSON.stringify({
      model: this.model,
      messages: [{ role: "system", content: SYSTEM_PROMPT }, ...this.messages],
      tools: this.openaiTools,
      tool_choice: "auto",
      max_tokens: this.maxTokens,
      stream,
      // Without this a streamed turn reports no token usage; harmless on servers
      // that already include it.
      ...(stream ? { stream_options: { include_usage: true } } : {}),
      // OpenRouter returns real spend in usage.cost ONLY when asked; every other
      // compat server ignores the unknown field. This is what makes the live
      // OpenRouter "$" readout possible.
      ...(this.provider === "openrouter" ? { usage: { include: true } } : {})
    });
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      let resp;
      try {
        resp = await fetch(url, { method: "POST", headers: this._headers(), body });
      } catch (e) {
        // No HTTP status → network/CORS failure; retrying won't fix it.
        throw new Error(unreachableHint(this.provider, this.baseUrl));
      }
      if (resp.ok) return resp;
      const transient = resp.status === 429 || resp.status === 500 ||
                        resp.status === 502 || resp.status === 503 || resp.status === 529;
      if (!transient || attempt === maxRetries) {
        const detail = await resp.text().catch(() => "");
        throw new Error(`${this.provider} ${resp.status} ${resp.statusText}${detail ? ": " + detail.slice(0, 300) : ""}`);
      }
      await new Promise((r) => setTimeout(r, Math.min(1000 * 2 ** attempt, 8000)));
    }
  }

  // One-shot turn → normalized {message, usage, finishReason}. The whole
  // assistant message arrives at once; nothing is emitted live, so the caller
  // emits its prose.
  async _completeOnce() {
    const resp = await this._fetchChat(false);
    const data = await resp.json();
    const choice = (data.choices && data.choices[0]) || {};
    return {
      message: choice.message || { role: "assistant", content: null },
      usage: data.usage,
      finishReason: choice.finish_reason || null
    };
  }

  // Streamed turn → the SAME normalized {message, usage, finishReason}, but prose
  // is emitted live via onText as it arrives and tool-call fragments are
  // reassembled by index. SSE shape: `data: {json}` lines terminated by a
  // `data: [DONE]`; delta.content accumulates the answer, and each
  // delta.tool_calls[i] carries an id + function.name on first sight, then
  // function.arguments fragments to concatenate.
  async _completeStream() {
    const resp = await this._fetchChat(true);
    if (!resp.body || typeof resp.body.getReader !== "function") {
      // Environment can't read a stream body — degrade to one-shot for the session.
      this.stream = false;
      return this._completeOnce();
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let content = "";
    let usage = null;
    let finishReason = null;
    const toolAcc = [];   // indexed by tool_call .index

    const handle = (json) => {
      if (json.usage) usage = json.usage;
      const choice = json.choices && json.choices[0];
      if (!choice) return;
      if (choice.finish_reason) finishReason = choice.finish_reason;
      const delta = choice.delta || {};
      if (typeof delta.content === "string" && delta.content) {
        content += delta.content;
        this.onText?.(delta.content);
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const d of delta.tool_calls) {
          const i = typeof d.index === "number" ? d.index : 0;
          const slot = toolAcc[i] || (toolAcc[i] = { id: "", name: "", args: "" });
          if (d.id) slot.id = d.id;
          const fn = d.function || {};
          if (fn.name) slot.name = fn.name;
          if (typeof fn.arguments === "string") slot.args += fn.arguments;
        }
      }
    };

    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line || !line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") continue;
        let json;
        try { json = JSON.parse(payload); } catch (e) { continue; }
        handle(json);
      }
    }

    const message = { role: "assistant", content: content || null };
    const toolCalls = toolAcc.filter(Boolean).map((s) => ({
      id: s.id, type: "function", function: { name: s.name, arguments: s.args }
    }));
    if (toolCalls.length) message.tool_calls = toolCalls;
    return { message, usage, finishReason };
  }

  _accountUsage(usage) {
    if (!usage) return;
    // Count only NON-cached input, mirroring the Anthropic path (whose displayed
    // token count already excludes cache reads). The stateless tool-loop re-sends
    // the ~18.6k system+tools prefix on EVERY tool round; OpenRouter caches it so
    // COST stays tiny, but still reports the whole prefix in prompt_tokens each
    // call — which ballooned the token readout ~4x ("quadrupling") vs the actual
    // fresh work. prompt_tokens_details.cached_tokens is that re-read portion;
    // subtract it so the tally reflects real, uncached tokens.
    const cached = (usage.prompt_tokens_details && usage.prompt_tokens_details.cached_tokens) || 0;
    this.totalInputTokens += Math.max(0, (usage.prompt_tokens || 0) - cached);
    this.totalOutputTokens += usage.completion_tokens || 0;
    // OpenRouter returns real USD spend in usage.cost (because _fetchChat asked
    // for it) — accumulate it. Local providers are free, so cost_usd stays 0; any
    // other compat server doesn't report cost and stays 0, which app.js renders
    // as "$—" (untracked). Cost already reflects caching; only the token tally
    // needed the cached-read correction above.
    if (this.provider === "openrouter" && typeof usage.cost === "number") {
      this.totalCostUsd += usage.cost;
    }
    this.onUsage?.({
      input: this.totalInputTokens,
      output: this.totalOutputTokens,
      cost_usd: this.totalCostUsd
    });
  }

  async send(userMessage) {
    this.messages.push({ role: "user", content: userMessage });
    try {
      await this._runLoop();
    } catch (e) {
      this.onError?.(e.message || String(e));
    }
  }

  // Some servers omit tool_call ids. The protocol requires every assistant
  // tool_call to be answered by a role:"tool" message carrying the SAME id, or
  // the next request is rejected with a dangling-tool error — so stamp a stable
  // id (and the required type) onto the message we keep, and answer with it.
  _ensureToolCallIds(msg) {
    if (!Array.isArray(msg.tool_calls)) return;
    msg.tool_calls.forEach((tc, i) => {
      if (!tc.id) tc.id = `call_${i}`;
      if (!tc.type) tc.type = "function";
    });
  }

  // A streamed tool-call turn the server mangled: it signalled tool_calls yet
  // delivered none, or a call has no name, or its arguments won't parse. This is
  // the documented local-server streaming-tool-call quirk that the one-shot
  // fallback exists for.
  _toolCallsGarbled({ message, finishReason }) {
    const tcs = message.tool_calls || [];
    const isToolTurn = tcs.length > 0 || finishReason === "tool_calls";
    if (!isToolTurn) return false;
    if (tcs.length === 0) return true;
    return tcs.some((tc) => {
      const fn = tc.function || {};
      if (!fn.name) return true;
      const args = fn.arguments;
      if (args && args.trim()) {
        try { JSON.parse(args); return false; } catch (e) { return true; }
      }
      return false;   // empty args is valid (a no-argument tool call)
    });
  }

  // The agentic loop. Each turn is streamed (prose live via onText, tool-calls
  // reassembled by index); a one-shot fallback covers servers that mangle
  // streamed tool-calls. Keyed on the PRESENCE of tool_calls (more robust than
  // finish_reason across local servers): when the model asks for tools, every
  // call — even a malformed one — is answered with a role:"tool" message so none
  // is left dangling, then we loop; a turn with no tool calls is the answer.
  async _runLoop() {
    while (true) {
      let result = this.stream ? await this._completeStream() : await this._completeOnce();

      // Auto-fallback: a streaming server garbled the tool-calls. Re-run this
      // turn one-shot and stay one-shot for the rest of the session. Safe to
      // re-run only because a garbled tool-call turn carries no prose (guarded
      // on empty content), so nothing was emitted to the user yet.
      if (this.stream && !result.message.content && this._toolCallsGarbled(result)) {
        this.stream = false;
        result = await this._completeOnce();
      }

      const msg = result.message;
      this._ensureToolCallIds(msg);
      // Push the assistant message verbatim: the next request echoes it back so
      // each tool_call id lines up with our tool answers.
      this.messages.push(msg);
      this._accountUsage(result.usage);

      const toolCalls = msg.tool_calls || [];
      // One-shot prose wasn't emitted live, so emit it now; streamed prose
      // already went out via onText during _completeStream — don't double it.
      if (!this.stream && msg.content) this.onText?.(msg.content);

      if (toolCalls.length === 0) {
        this.onDone?.();
        return;
      }

      for (const tc of toolCalls) {
        const name = (tc.function && tc.function.name) || "";
        let input = {};
        const rawArgs = tc.function && tc.function.arguments;
        if (rawArgs) {
          try { input = JSON.parse(rawArgs); } catch (e) { input = {}; }
        }
        const { content } = await dispatchToolCall(name, input, {
          onToolStart: this.onToolStart,
          onAskUserChoice: this.onAskUserChoice
        });
        this.messages.push({ role: "tool", tool_call_id: tc.id, content });
      }
    }
  }
}

// Reachability + auth probe for the settings UI (Phase 3). Hits the OpenAI-compat
// /models list; surfaces a CORS/network failure with the same actionable hint.
export async function validateProvider({ provider, baseUrl, apiKey } = {}) {
  const preset = PROVIDER_PRESETS[provider] || PROVIDER_PRESETS.custom;
  const base = (baseUrl || preset.baseUrl || "").replace(/\/+$/, "");
  if (!base) return { ok: false, error: "No base URL set for this provider." };
  const headers = {};
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  if (provider === "openrouter") {
    headers["HTTP-Referer"] = OPENROUTER_REFERER;
    headers["X-Title"] = OPENROUTER_TITLE;
  }
  try {
    const resp = await fetch(`${base}/models`, { headers });
    if (!resp.ok) return { ok: false, error: `${resp.status} ${resp.statusText}` };
    const data = await resp.json().catch(() => null);
    const models = data && Array.isArray(data.data) ? data.data.map((m) => m.id) : [];
    return { ok: true, models };
  } catch (e) {
    return { ok: false, error: unreachableHint(provider, base), cors: true };
  }
}
