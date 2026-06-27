import Anthropic from "https://esm.sh/@anthropic-ai/sdk@0.32.1";
import { tools } from "./tools.js";
import { extractWithRetry } from "./extraction.js";
import { dispatchToolCall } from "./session_common.js";
import { SYSTEM_PROMPT } from "./prompt.js";

// Per-million-token rates. cache_write is the 1-HOUR-TTL write rate (= 2x base
// input), because every request sets ttl:"1h" below — NOT the 5-min rate (1.25x).
// cache_read is 0.1x base input (TTL-independent).
const MODELS = {
  opus:   { id: "claude-opus-4-8",   input: 5, output: 25, cache_write: 10.0, cache_read: 0.50 },
  sonnet: { id: "claude-sonnet-4-6", input: 3, output: 15, cache_write: 6.0,  cache_read: 0.30 },
  haiku:  { id: "claude-haiku-4-5",  input: 1, output: 5,  cache_write: 2.0,  cache_read: 0.10 }
};

// Memory writes, greetings, and meta questions go to Haiku. Mixing-analysis
// questions go to Sonnet. Locked per send() so the multi-turn tool loop
// stays on one model.
function pickModel(userMessage) {
  if (!userMessage) return MODELS.opus;
  const m = userMessage.toLowerCase().trim();
  if (/^(remember|save|store|note that|forget|recall)\b/.test(m)) return MODELS.haiku;
  if (/^(hi|hello|hey|yo|sup)\b/.test(m)) return MODELS.haiku;
  if (/^(thanks|thank you|thx|ty|cool|nice|got it|gotcha)\b/.test(m)) return MODELS.haiku;
  if (/^(ok|okay|sounds good|sure)$/.test(m)) return MODELS.haiku;
  if (/^(help|what can you do|what tools|what do you do|how do you work)\b/.test(m)) return MODELS.haiku;
  return MODELS.opus;   // substantive analysis → Opus (was Sonnet); trivial/chatty/memory stay on Haiku above
}

// 1h cache TTL: write cost ~2x normal vs default 5min, but pays back after
// one hit past the 5min mark. Mixing sessions routinely pause >5min between
// turns (listening, A/B'ing), so 1h is strictly better.
const CACHE_TTL = { type: "ephemeral", ttl: "1h" };

// Builds the messages array sent to the API with cache_control applied at the
// right breakpoints: one on the message containing get_memory's tool_result
// (semi-static across the session) and one on the latest message (rolling
// cache that extends every turn). Combined with system + tools cache, this
// gives 4 breakpoints — the API maximum.
function prepareCachedMessages(messages, memoryMessageIndex) {
  const out = messages.map(msg => {
    let content = msg.content;
    if (typeof content === "string") {
      content = [{ type: "text", text: content }];
    } else {
      content = content.map(b => ({ ...b }));
    }
    return { role: msg.role, content };
  });
  const lastIdx = out.length - 1;
  if (lastIdx >= 0) {
    const blocks = out[lastIdx].content;
    blocks[blocks.length - 1].cache_control = CACHE_TTL;
  }
  // Skip if memory message is the latest — would be a redundant breakpoint.
  if (memoryMessageIndex >= 0 && memoryMessageIndex < lastIdx) {
    const blocks = out[memoryMessageIndex].content;
    blocks[blocks.length - 1].cache_control = CACHE_TTL;
  }
  return out;
}

// Cap pending extractions — beyond this, something is wrong (Haiku down,
// auth failed, etc.) and continuing to schedule retries wastes attempts.
const MAX_COMPRESSION_BACKLOG = 5;

export class ClaudeSession {
  constructor({ apiKey, model, onText, onToolStart, onDone, onError, onUsage, onAskUserChoice }) {
    this.client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
    this.apiKey = apiKey;
    this.modelOverride = model || null;
    this.messages = [];
    this.memoryMessageIndex = -1;
    this.currentTurnToolResultIndices = [];
    this.compressionPending = [];
    this.nextTaskId = 1;
    this.compressionPaused = false;
    this.onText = onText;
    this.onToolStart = onToolStart;
    this.onDone = onDone;
    this.onError = onError;
    this.onUsage = onUsage;
    // UI hook for ask_user_choice. Receives (question, options) and returns a
    // Promise<string> resolving to the user's chosen label. Loop pauses on
    // await; cache stays warm because the click is fast vs typing a reply.
    this.onAskUserChoice = onAskUserChoice;
    this.totalInputTokens = 0;
    this.totalOutputTokens = 0;
    this.totalCacheWriteTokens = 0;
    this.totalCacheReadTokens = 0;
    this.totalCostUsd = 0;
    this.currentTurnModel = MODELS.opus;
  }

  async send(userMessage) {
    this.currentTurnModel = this.modelOverride
      ? Object.values(MODELS).find(m => m.id === this.modelOverride) || MODELS.opus
      : pickModel(userMessage);
    this.currentTurnToolResultIndices = [];
    // Background: retry any extractions from earlier turns that failed transiently.
    // Doesn't block the current turn — replacements that complete mid-stream
    // are seen by subsequent prepareCachedMessages calls.
    this._retryPendingExtractions();
    this.messages.push({ role: "user", content: userMessage });
    try {
      await this._runLoop();
    } catch (e) {
      this.onError?.(e.message || String(e));
    }
  }

  _retryPendingExtractions() {
    if (this.compressionPaused) return;
    if (this.compressionPending.length > MAX_COMPRESSION_BACKLOG) {
      this.compressionPaused = true;
      this.onError?.(`Findings extraction backlog at ${this.compressionPending.length} turns — Haiku may be unreachable. Compression paused for this session.`);
      return;
    }
    for (const entry of [...this.compressionPending]) {
      this._tryExtract(entry);
    }
  }

  async _tryExtract(entry) {
    entry.attempts++;
    const result = await extractWithRetry({
      apiKey: this.apiKey,
      assistantText: entry.assistantText
    });
    // Track Haiku extraction cost as part of the session total.
    if (result.usage && (result.usage.input || result.usage.output)) {
      const m = MODELS.haiku;
      this.totalCostUsd += (result.usage.input * m.input + result.usage.output * m.output) / 1e6;
      this.onUsage?.({
        input: this.totalInputTokens,
        output: this.totalOutputTokens,
        cache_write: this.totalCacheWriteTokens,
        cache_read: this.totalCacheReadTokens,
        cost_usd: this.totalCostUsd
      });
    }
    if (result.ok) {
      const summary = result.findings
        ? `Your trace of this tool call — what you measured and how you derived each conclusion (the bulky raw payload was condensed to this trace). This is your authoritative record. USE it: answer the user's question from it, and when you make a claim show the path — which measurement, which reasoning, which conclusion. When asked how you know, or when challenged, walk this trace step by step rather than caving. These values were measured, not invented; condensation is not fabrication.\n${result.findings}`
        : `This tool call's raw payload was condensed; no separate trace was extracted this turn. Your own message above records what the tool returned and how you used it — answer from that, walk it step by step if challenged, and treat its values as measured, not invented.`;
      for (const ref of entry.toolResultRefs) {
        if (ref.msgIdx >= this.messages.length) continue;
        const msg = this.messages[ref.msgIdx];
        if (msg.role !== "user" || !Array.isArray(msg.content)) continue;
        const decaySet = new Set(ref.decayableIds);
        if (decaySet.size === 0) continue;
        for (const block of msg.content) {
          if (block.type === "tool_result" && decaySet.has(block.tool_use_id)) {
            block.content = summary;
          }
        }
      }
      this.compressionPending = this.compressionPending.filter(e => e.id !== entry.id);
    } else if (result.classification === "auth" || result.classification === "bad_request") {
      // Won't fix itself — stop trying this entry; surface the issue.
      this.compressionPending = this.compressionPending.filter(e => e.id !== entry.id);
      this.compressionPaused = true;
      this.onError?.(`Extraction failed (${result.classification}): ${result.error}. Compression paused.`);
    }
    // Transient failure: leave in backlog, will retry on next user turn.
  }

  async _streamWithRetry(maxRetries = 4) {
    // 4 cache breakpoints: system prompt, last tool def, memory message
    // (when present), latest message (rolling). All use 1h TTL.
    const cachedTools = tools.map((t, i) =>
      i === tools.length - 1 ? { ...t, cache_control: CACHE_TTL } : t
    );
    const cachedMessages = prepareCachedMessages(this.messages, this.memoryMessageIndex);
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await this.client.messages.stream({
          model: this.currentTurnModel.id,
          max_tokens: 16384,   // headroom for a full multi-section analysis; was 2048 → truncated long answers mid-sentence
          system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: CACHE_TTL }],
          tools: cachedTools,
          messages: cachedMessages
        });
      } catch (e) {
        const transient = e?.status === 529 || e?.status === 503 || e?.status === 429 || e?.error?.type === "overloaded_error" || /overload/i.test(e?.message || "");
        if (!transient || attempt === maxRetries) throw e;
        const wait = Math.min(1000 * 2 ** attempt, 8000);
        await new Promise(r => setTimeout(r, wait));
      }
    }
  }

  async _runLoop() {
    // Dual guard against a runaway tool loop (likeliest on a weak model, but
    // cheap insurance everywhere). PRIMARY: an identical tool call (same name +
    // args) repeated within one send can only be non-progressing — re-fetching
    // identical data returns identical data, zero new information. BACKSTOP: a
    // hard ceiling at ~2x the deepest legitimate analysis (a thorough multi-
    // section capture is ~6-15 batched rounds), so it only ever catches genuine
    // runaway, never real work. Both surface an error and end the turn cleanly.
    const MAX_TOOL_ROUNDS = 30;
    const seenToolCalls = new Set();
    let toolRounds = 0;
    while (true) {
      if (++toolRounds > MAX_TOOL_ROUNDS) {
        this.onError?.(`Stopped after ${MAX_TOOL_ROUNDS} tool rounds — the model may be stuck in a loop. The work above is what completed.`);
        this.onDone?.();
        return;
      }
      const stream = await this._streamWithRetry();
      stream.on("text", (delta) => this.onText?.(delta));

      const final = await stream.finalMessage();
      this.messages.push({ role: "assistant", content: final.content });

      if (final.usage) {
        const p = this.currentTurnModel;
        const inp = final.usage.input_tokens || 0;
        const out = final.usage.output_tokens || 0;
        const cw  = final.usage.cache_creation_input_tokens || 0;
        const cr  = final.usage.cache_read_input_tokens || 0;
        this.totalInputTokens += inp;
        this.totalOutputTokens += out;
        this.totalCacheWriteTokens += cw;
        this.totalCacheReadTokens += cr;
        this.totalCostUsd += (inp * p.input + out * p.output + cw * p.cache_write + cr * p.cache_read) / 1e6;
        this.onUsage?.({
          input: this.totalInputTokens,
          output: this.totalOutputTokens,
          cache_write: this.totalCacheWriteTokens,
          cache_read: this.totalCacheReadTokens,
          cost_usd: this.totalCostUsd
        });
      }

      if (final.stop_reason !== "tool_use") {
        this.onDone?.();
        // Schedule background Haiku extraction only if at least one decayable
        // tool ran this turn. Settings queries don't benefit from decay and
        // shouldn't trigger a Haiku call.
        const hasDecayable = this.currentTurnToolResultIndices.some(r => r.decayableIds.length > 0);
        if (hasDecayable && !this.compressionPaused) {
          const assistantText = final.content
            .filter(b => b.type === "text")
            .map(b => b.text || "")
            .join("\n")
            .trim();
          if (assistantText) {
            const entry = {
              id: this.nextTaskId++,
              assistantText,
              toolResultRefs: [...this.currentTurnToolResultIndices],
              attempts: 0
            };
            this.compressionPending.push(entry);
            this._tryExtract(entry);
          }
        }
        return;
      }

      const toolResults = [];
      const decayableIds = [];
      let memoryCalledThisTurn = false;
      for (const block of final.content) {
        if (block.type !== "tool_use") continue;
        // Identical-call loop guard. ask_user_choice is exempt — it's interactive,
        // so the same question can legitimately yield a different answer; every
        // other tool is deterministic over its args, so an exact repeat is a loop.
        // On a repeat we feed back an error result (not the data again) so the
        // model stops and answers; every tool_use still gets a tool_result, so
        // the message history stays valid. The backstop bounds it if it ignores us.
        const sig = block.name !== "ask_user_choice"
          ? block.name + ":" + JSON.stringify(block.input) : null;
        if (sig && seenToolCalls.has(sig)) {
          toolResults.push({ type: "tool_result", tool_use_id: block.id,
            content: `ERROR: you already called ${block.name} with these exact arguments this turn; the result is unchanged. Do not repeat it — answer from the data you already have, or take a different action.` });
          continue;
        }
        if (sig) seenToolCalls.add(sig);
        // The actual dispatch (ask_user_choice picker vs runTool + compress) is
        // the shared seam in session_common; here we only translate to/from
        // Anthropic's content-block shape and keep the decay/memory bookkeeping.
        const { content, decayable, isMemory } = await dispatchToolCall(
          block.name, block.input,
          { onToolStart: this.onToolStart, onAskUserChoice: this.onAskUserChoice }
        );
        if (isMemory) memoryCalledThisTurn = true;
        if (decayable) decayableIds.push(block.id);
        toolResults.push({ type: "tool_result", tool_use_id: block.id, content });
      }
      this.messages.push({ role: "user", content: toolResults });
      this.currentTurnToolResultIndices.push({
        msgIdx: this.messages.length - 1,
        decayableIds
      });
      // Mark the message containing get_memory's result as the cache
      // breakpoint for memory — semi-static for the rest of the session.
      if (memoryCalledThisTurn) this.memoryMessageIndex = this.messages.length - 1;
    }
  }
}

export async function validateApiKey(apiKey) {
  try {
    const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
    await client.messages.create({
      model: MODELS.haiku.id,
      max_tokens: 1,
      messages: [{ role: "user", content: "ok" }]
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e?.message || "unknown error" };
  }
}
