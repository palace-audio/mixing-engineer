import { runTool } from "./tools.js";
import { compressToolResult } from "./compress.js";

// Only analyze_section produces the multi-KB payloads worth decaying to a
// findings trace on later turns; every other tool is a 1-2KB state query the
// model must be able to re-verify (decaying those makes it double down on stale
// state when challenged). Lives here so every session class decays the same set.
export const DECAYABLE_TOOLS = new Set(["analyze_section"]);

// Provider-agnostic dispatch of ONE tool call the model emitted. Each session
// class normalizes its provider's tool-call block to (name, input) and hands it
// here; the returned `content` is the exact string to embed in that provider's
// own tool-result shape (Anthropic tool_result block, OpenAI role:"tool"
// message — both carry a string). This is the one drift-prone seam worth
// sharing: a second UI-resolved pseudo-tool, or any change to how a tool result
// becomes message content, lands in ONE place instead of in every session class.
//
//   - ask_user_choice never reaches runTool. It pauses the agentic loop,
//     surfaces a picker through onAskUserChoice, and resolves with the user's
//     selection (the cache stays warm because a click is fast vs typing).
//   - every other tool runs against Live via runTool and its raw payload is
//     compressed before it goes back to the model.
//
// `decayable` / `isMemory` are bookkeeping the caller uses for its own
// provider-specific concerns (Anthropic decay backlog + memory cache
// breakpoint); a caller that does neither just ignores them.
export async function dispatchToolCall(name, input, { onToolStart, onAskUserChoice }) {
  if (name === "ask_user_choice") {
    const q = (input && input.question) || "";
    const opts = (input && input.options) || [];
    let picked = "";
    if (onAskUserChoice) {
      try {
        picked = await onAskUserChoice(q, opts);
      } catch (e) {
        picked = "";
      }
    }
    return { content: picked || "(no selection)", decayable: false, isMemory: false };
  }
  onToolStart?.(name, input);
  const result = await runTool(name, input);
  return {
    content: JSON.stringify(compressToolResult(name, result)),
    decayable: DECAYABLE_TOOLS.has(name),
    isMemory: name === "get_memory"
  };
}
