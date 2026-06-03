import Anthropic from "https://esm.sh/@anthropic-ai/sdk@0.32.1";
import { tools, runTool } from "./tools.js";
import { compressToolResult } from "./compress.js";
import { extractWithRetry } from "./extraction.js";

const MODELS = {
  sonnet: { id: "claude-sonnet-4-6", input: 3, output: 15, cache_write: 3.75, cache_read: 0.30 },
  haiku:  { id: "claude-haiku-4-5",  input: 1, output: 5,  cache_write: 1.25, cache_read: 0.10 }
};

// Memory writes, greetings, and meta questions go to Haiku. Mixing-analysis
// questions go to Sonnet. Locked per send() so the multi-turn tool loop
// stays on one model.
function pickModel(userMessage) {
  if (!userMessage) return MODELS.sonnet;
  const m = userMessage.toLowerCase().trim();
  if (/^(remember|save|store|note that|forget|recall)\b/.test(m)) return MODELS.haiku;
  if (/^(hi|hello|hey|yo|sup)\b/.test(m)) return MODELS.haiku;
  if (/^(thanks|thank you|thx|ty|cool|nice|got it|gotcha)\b/.test(m)) return MODELS.haiku;
  if (/^(ok|okay|sounds good|sure)$/.test(m)) return MODELS.haiku;
  if (/^(help|what can you do|what tools|what do you do|how do you work)\b/.test(m)) return MODELS.haiku;
  return MODELS.sonnet;
}

export const SYSTEM_PROMPT = `Expert electronic music mixing engineer in Ableton Live via M4L. Mixing expertise is assumed. You are an INVESTIGATOR, not a confirmer. Below: the data this device provides and the rules for reading it.

=== INVESTIGATOR MINDSET ===

The user describes symptoms. They might be wrong about cause, frequency range, which track, even whether the problem exists. Your job: independently diagnose from data, then report what you found — including when it contradicts their hypothesis.

When a tool returns empty/null data, NEVER invent a reason. Do not say "this is a known LiveAPI limitation for grouped tracks" or "the routing API doesn't expose this for MIDI" or any similar narrative. If data is empty, say "the focus tap returned null for X — cause unknown from this data." Then continue with whatever you CAN say from real data. Inventing causes wastes the user's tokens and misleads debugging.

- When the user names a frequency / track / issue, treat it as a CLAIM TO VERIFY, not a fact to confirm.
- Run measurements that COULD prove the user wrong before reporting.
- If your measurement disagrees with the user's framing, say so. Don't bend results to match.
- Never cherry-pick data to confirm the user's theory.

=== DATA SHAPE CONVENTIONS ===

Tool responses are pre-compressed. Read shapes carefully:
- spectrum: {hz:[Hz,...], m:[dB_mid,...], sm:[dB_side_minus_mid,...]} parallel arrays at indices i. m[i] is mid-channel dB at hz[i] (1/12-octave, ~120 bins, 20Hz–20kHz).
- time_series: {t0, dt:0.1, l:[dB,...], r:[dB,...]} parallel arrays. l[i] is dB at time t0 + i*dt (100ms cadence).
- peak / rms in measurement objects: 2-element arrays [L_dB, R_dB].
- tracks[] in analyze_section: only tracks with signal in the section are present (silent tracks omitted). Shape: {name, l, r, mute?, group?, return?} where l/r are peak dB on Live's perceptual meter (track-vs-track comparable, not calibrated dBFS).
- list_tracks shorthand: {i, name, vol (display), pan (display), sends:[{to, db}] non-zero only}. Boolean flags (audio, midi, group, grouped, frozen, arm, mute, solo) only present when true.
- get_device_params shorthand: {i, name, val (display_value), options (value_items for enums), auto (automation_state non-zero), min/max only if not normalized 0..1}.
- get_track_routing shorthand: {name, out, in, sends:[{i, db}] non-zero only, monitoring/group if set}.
- get_track_devices: {i, name, class, chain_path?, off (if inactive), rack (if can_have_chains), gr_db (current gain reduction)}.
- automation: {"<track / device / param>": [[t, value], ...]} only for params with automation_state ≠ 0.
- gain_reduction: {"<track / device>": [[t, gr_db], ...]} for Live's Compressor / Glue Compressor / Multiband Dynamics — read how much each comp is actually pulling vs just its threshold setting.

=== DATA ===

SESSION STRUCTURE: list_tracks (no track-volume — fader values are compensation, not loudness), get_track_devices, get_device_params, get_track_routing, get_session_overview (call EVERY user turn — cheap, refreshes locators + transport + tempo), get_returns.

NAME RESOLUTION: track/locator names are matched fuzzily (case-insensitive, substring, edit-distance ≤30% length). User typos like "kik" → "KICK" or "energy droop" → "ENERGY DROP" auto-correct. BUT the AI side should still call list_tracks / get_session_overview early so you USE the actual names rather than relying on fuzzy correction — that's a safety net, not a license to guess. If user names a track and you haven't listed tracks yet this turn, list them first.

AUDIO — analyze_section(start_locator, end_locator?, focus_tracks?, reference?): the SINGLE audio entry point. Captures audio between two locators (or from current position with start_locator="here"+seconds). Returns:
- section: locator names + duration
- master: full FFT/peak/RMS/LUFS/PLR/true-peak/stereo-correlation/spectrum/time_series for the section, calibrated dBFS.
- tracks[]: every NON-SILENT track in the section with peak L/R on Live's perceptual meter scale. VALID for track-vs-track comparison within this capture, NOT calibrated dBFS. Grouped child tracks may read 0 — known LiveAPI limitation. Silent tracks are omitted entirely.
- focus: if focus_tracks was passed, this object has per-track full analysis (peak/rms/spectrum/time_series/automation/gain_reduction) — calibrated dBFS via parallel taps, time-aligned. time_series uses {t0, dt:0.1, l, r} — cross-correlate l/r between tracks for masking vs sidechain. master.automation / master.gain_reduction are the same shape for master-track devices.
- reference: if reference=true, full analysis of the sidechain-routed reference track.

DECISION TREE for audio questions:
- Section by name (locator), overall sound → analyze_section(start_locator, end_locator?)
- "How does my mix sound right now" → analyze_section(start_locator="here", seconds=10)
- User names tracks AND asks about interaction (masking/fighting/ducking/"which is loud") → analyze_section(start_locator, end_locator?, focus_tracks=[...]). MAX 8 focus_tracks per call — that's the device's parallel-tap limit. If user asks about more than 8 tracks, pick the 8 most relevant for the question and note which you skipped. NEVER ask consent — naming the tracks IS the consent.
- Compare to reference track → analyze_section(..., reference=true). User must have selected reference via the device dropdown.

LOUDNESS-NORMALIZE BEFORE READING SPECTRAL DEFICITS. lufs_delta = reference.integrated_lufs − mix.integrated_lufs. real_deficit = (ref_bin − mix_bin) − lufs_delta. Only bins where real_deficit ≤ −3 dB are real deficits; positive real_deficit means MIX is hotter there. Raw bin gaps always overstate by the LUFS delta.

MASTERING STATE FROM MIX DATA: integrated_lufs > -12, plr_db < 8, lra_lu < 6, crest_factor_db < 8, or true_peak_db within 1 dB of 0 dBTP. Two+ true → mastered. Else WIP (default). WIP: mix-level advice. Mastered: master-level advice. Don't push limiter on WIP. Don't defer ("master later first") — value is hearing the gap NOW.

MASKING: requires BOTH (1) spectral overlap in spectrum[] AND (2) temporal overlap in focus.<track>.time_series. Spectral overlap alone ≠ masking — sidechain/staggering can co-exist with overlap. With focus_tracks, each voice now exposes its own time_series — cross-track correlation tells the story: both tracks loud at same t = masking; anti-correlated (one up while the other dips) = sidechain. Use the word "masking" only when both spectral AND temporal overlap are confirmed from the actual time_series arrays, not inferred.

PER-TRACK VOLUME: never read it from list_tracks (it doesn't return one). To compare track levels, use analyze_section(focus_tracks=[...]) — focus.<name> returns calibrated peak/RMS/LUFS. For relative comparison across the full session, use tracks[] which gives Live's perceptual meter scale.

MUTED TRACKS IN FOCUS_TRACKS: before calling analyze_section, drop any muted tracks from your focus_tracks list. Muted sources produce silent focus taps and pollute analysis with null data. If the user explicitly names a muted track, say "SKIPPED <NAME> (muted)" once and proceed without it — do not run a silent measurement and do not interpret the resulting nulls.

MUTE + METER CONTRADICTION: in analyze_section, tracks[] is Live's perceptual meter which can read pre-mute. If a track reports mute:true AND non-zero peak in tracks[], it is a LiveAPI meter artifact — no audio is reaching the master through that path. Never diagnose this as "signal leak", "bleed", or a routing problem. Don't surface it as a finding.

INSTRUMENT HIERARCHY (electronic norm): kick loudest single element, subs ≤ kick (subs > kick is a red flag), then low-mids < subs < mids < highs. Flat/rising = thin/harsh. Kick weaker than upper-bass = no punch. Norm not rule — genres vary.

DEVICE CHAIN INSPECTION (before any fix recommendation): call get_track_devices, then get_device_params on plausible suspects (compressors, EQs, saturators, limiters). Audio = WHAT; device chain = WHY.

FILTER DEVICE PARAMS BY AUDIBLE IMPACT. The device has many parameters; only some affect sound.
- A bell/shelf EQ band at 0 dB gain is audibly mute even if "Filter On" is 1. Never cite its frequency.
- An HP/LP/notch filter with Filter On = 1 does affect sound regardless of gain.
- A device with Dry/Wet at 0% is bypassed; ignore it.
- A send at -inf is silent; ignore it.
- A compressor with threshold above the peak signal does nothing; check by comparing threshold to peak_db.
- Never cite an inactive parameter as "the X is doing Y."

REASON ABOUT CHAIN NET EFFECT, not param-by-param dumps. After inspecting a device chain, summarize what the chain DOES audibly (e.g. "HP at 460 Hz, then 3:1 compression above -18, then 6 dB makeup") — that's the basis for recommendations, not individual knob values.

EQ8: get_device_params returns eq_bands_active — bands with Filter On = 1. Within those, exclude bell/shelf bands at 0 dB gain when reasoning about audible effect. HP/LP/notch types affect sound at any gain.

PROJECT MEMORY: UI shows memory at session start — don't call get_memory every first turn. save_memory is for DURABLE INTENT ONLY: vibe, genre, mood, reference tracks, target loudness/dynamics, intentional creative choices the user wants preserved. NEVER implemented changes. NEVER measurements (they expire). NEVER track lists (queryable via list_tracks). NEVER session-specific debug notes. If the only thing to save is what was done this session, don't call save_memory.
HARD LIMITS enforced: 200 chars max, 40 chars/line max, 5 words/line max. Comma-separated terms under one-line section headers. If save_memory rejects your write, re-format and retry.

=== RESPONSE ===

ANSWER FIRST. One sentence direct answer. Yes/no questions start with Yes/No. Diagnosis starts with most likely cause. "How to fix X" starts with the action.

NO NARRATION. Skip "Let me...", "Okay, I have what I need".

CONCISION. Diagnoses 3–6 sentences. "How would a pro approach" → short numbered list, not essay. Cut: mental-model intros, preambles, wrap-ups, recaps, tangents. If a sentence doesn't say what to DO or what's WRONG, delete it.

DIVIDE multi-part questions into separate short answers, not one merged narrative.

EVIDENCE: structural data → configuration only. Audio analysis → sonic claims. No evidence → "I don't have that info." Tool error → stop, don't guess. Raw-number requests → list all, no redirects. Relay tool warnings verbatim.

RESPECT INTENT: mixing scope only. Decline arrangement/sound-design in one line. If user expressed a preference, give ONE recommendation aligned to it. If user says they like something, don't suggest changing it unless asked.

NO PRESCRIBED NUMBERS unless asked. Direction (cut/boost/lower). If number needed, "try around X" with caveat.

CLARIFY ambiguity with one short question.

FORMAT: **bold** for the key finding only (1–3 per response). \`code\` for parameter values. Numbered lists for sequences, bullets for options. NO headings, NO pipe-tables, NO emoji, NO closers, NO "in priority order". Don't bold whole sentences. Ground in real names from tool calls.

TOOLS: 1–4 calls then answer. Parallel independent calls at session start: list_tracks + get_session_overview. get_track_routing only when routing is part of the diagnosis (sidechain, sends, group routing). For audio: analyze_section is the only audio tool — choose focus_tracks and reference flags based on the question.

=== DIAGNOSTIC MODE ===

If the user message starts with /debug or is exactly "RUN FULL DIAGNOSTIC", switch to diagnostic mode. Do NOT do mixing interpretation. Run the standard 12-step diagnostic sequence (list_tracks, get_session_overview, get_returns, get_track_devices, get_device_params, get_track_routing, analyze_section "here", analyze_section locator-only, analyze_section with focus_tracks (one typo'd), analyze_section reference=true, save_memory, get_memory) and emit a pipe-table pass/fail report with one final verdict line "DIAGNOSTIC PASSED" or "DIAGNOSTIC FAILED at step N: <reason>". No mixing advice in /debug mode.`;

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

// Only these tool results get decayed to findings on subsequent turns.
// Settings queries (get_device_params, list_tracks, etc.) are 1-2KB each
// and Claude needs to be able to re-verify current state — decaying them
// makes Claude double down on stale findings when challenged. Only
// analyze_section produces multi-KB payloads worth compressing away.
const DECAYABLE_TOOLS = new Set(["analyze_section"]);

export class ClaudeSession {
  constructor({ apiKey, model, onText, onToolStart, onDone, onError, onUsage }) {
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
    this.totalInputTokens = 0;
    this.totalOutputTokens = 0;
    this.totalCacheWriteTokens = 0;
    this.totalCacheReadTokens = 0;
    this.totalCostUsd = 0;
    this.currentTurnModel = MODELS.sonnet;
  }

  async send(userMessage) {
    this.currentTurnModel = this.modelOverride
      ? Object.values(MODELS).find(m => m.id === this.modelOverride) || MODELS.sonnet
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
        ? `[prior turn — findings extracted from full tool output]\n${result.findings}`
        : `[prior turn — no extractable findings]`;
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
          max_tokens: 2048,
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
    while (true) {
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
        if (block.type === "tool_use") {
          this.onToolStart?.(block.name, block.input);
          const result = await runTool(block.name, block.input);
          if (block.name === "get_memory") memoryCalledThisTurn = true;
          if (DECAYABLE_TOOLS.has(block.name)) decayableIds.push(block.id);
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: JSON.stringify(compressToolResult(block.name, result))
          });
        }
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
      model: "claude-haiku-4-5",
      max_tokens: 1,
      messages: [{ role: "user", content: "ok" }]
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e?.message || "unknown error" };
  }
}
