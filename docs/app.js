// Provider sessions are loaded lazily (dynamic import in initSession) so picking a
// local/OpenRouter model never evaluates anthropic.js — which is the only module that
// pulls the Anthropic SDK from esm.sh. See loadSessionClass below.
import { query } from "./max_bridge.js";

// Config persists to a project-adjacent file (mixingengineer_config.json next to the
// .als) so it survives localStorage clears (cache wipes, Max updates, project moves).
// localStorage is still written on save for fast synchronous reads; the file is the
// durable fallback. Storing the API key to a local file has the same security posture
// as localStorage — cleartext, local only.
async function readConfigFromFile() {
  try {
    const r = await query("read_config_file");
    if (r && r.content) {
      const cfg = JSON.parse(r.content);
      if (cfg && cfg.provider) return cfg;
    }
  } catch { }
  return null;
}

async function saveConfigToFile(cfg) {
  try { await query("write_config_file", encodeURIComponent(JSON.stringify(cfg || {}))); }
  catch { }
}
import { mountSettings, getStoredConfig } from "./settings.js";
import { runTool } from "./tools.js";

// Cost readout policy by provider. Local inference → "free"; Anthropic (computed
// from token prices) and OpenRouter (real spend returned in usage.cost) → live
// "$x.xxx"; any other compat server doesn't report cost → "$—" (tokens always shown).
const LOCAL_PROVIDERS = new Set(["ollama", "lmstudio"]);
const COST_TRACKED_PROVIDERS = new Set(["anthropic", "openrouter"]);

const messagesEl = document.getElementById("messages");
const inputEl = document.getElementById("input");
const sendBtn = document.getElementById("send");
const statusEl = document.getElementById("status");
const statusTextEl = document.getElementById("status-text");
const costEl = document.getElementById("cost");
const tokEl = document.getElementById("tok");

let session = null;
let turnInFlight = false;   // true while a turn is streaming/running tools — guards against concurrent send()
let currentAssistantEl = null;
let currentAssistantText = "";
let thinkingEl = null;

let metricsStatus = "Offline";
let metricsCost = 0;
let metricsTokens = 0;
let costMode = "usd";   // "usd" | "free" (local) | "untracked" (cost not computed)

function costText(decimals) {
  if (costMode === "free") return "free";
  if (costMode === "untracked") return "$—";
  return "$" + metricsCost.toFixed(decimals);
}

function applyMetrics() {
  if (statusEl) {
    statusEl.classList.remove("connected", "disconnected", "thinking");
    if (metricsStatus === "Offline") statusEl.classList.add("disconnected");
    else if (metricsStatus === "Thinking") statusEl.classList.add("thinking");
    else statusEl.classList.add("connected");
  }
  if (statusTextEl) statusTextEl.textContent = metricsStatus;
  if (costEl) costEl.textContent = costText(3);
  if (tokEl) {
    tokEl.textContent = metricsTokens >= 1000
      ? (metricsTokens / 1000).toFixed(1) + "k tok"
      : metricsTokens + " tok";
  }
  if (window.max && typeof window.max.outlet === "function") {
    const costStr = costText(2);
    const tokStr = metricsTokens >= 1000
      ? (metricsTokens / 1000).toFixed(1) + "k"
      : String(metricsTokens);
    window.max.outlet("metrics", metricsStatus, costStr, tokStr);
  }
}

function showThinking() {
  if (thinkingEl) return;
  thinkingEl = document.createElement("div");
  thinkingEl.className = "msg thinking";
  thinkingEl.innerHTML = '<span class="dots"><span></span><span></span><span></span></span>';
  messagesEl.appendChild(thinkingEl);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  metricsStatus = "Thinking";
  applyMetrics();
}

function hideThinking() {
  if (thinkingEl) { thinkingEl.remove(); thinkingEl = null; }
  if (metricsStatus === "Thinking") {
    metricsStatus = "Ready";
    applyMetrics();
  }
}

function setStatus(connected) {
  sendBtn.disabled = !connected;
  metricsStatus = connected ? "Ready" : "Offline";
  applyMetrics();
}

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderMarkdown(text) {
  let s = escapeHtml(text);
  s = s.replace(/```([\s\S]*?)```/g, (_, code) => `<pre><code>${code.trim()}</code></pre>`);
  s = s.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  s = s.replace(/^---+$/gm, "<hr>");
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
  s = s.replace(/(?:^|\n)((?:- [^\n]+(?:\n|$))+)/g, (_, block) => {
    const items = block.trim().split("\n").map(l => `<li>${l.replace(/^- /, "")}</li>`).join("");
    return `\n<ul>${items}</ul>`;
  });
  s = s.replace(/(?:^|\n)((?:\d+\. [^\n]+(?:\n|$))+)/g, (_, block) => {
    const items = block.trim().split("\n").map(l => `<li>${l.replace(/^\d+\. /, "")}</li>`).join("");
    return `\n<ol>${items}</ol>`;
  });
  s = s.split(/\n\n+/).map(para => {
    if (/^<(ul|ol|pre|h\d)/.test(para.trim())) return para;
    return `<p>${para.replace(/\n/g, "<br>")}</p>`;
  }).join("");
  return s;
}

// Project-level setup. Two fields anchor every read (genre, delivery) and two
// optional recall anchors (label, track). The form writes memory DIRECTLY via
// runTool("save_memory") — a local localStorage write, no model call — so both
// first-time onboarding AND later edits are costless: revising the canonical
// fields never spends an inference turn. Genre and platform are free of
// derivable filler; the rest the AI reads from the set and the conversation.
const ONBOARD_PLATFORMS = ["streaming", "club / DJ", "vinyl", "film / TV / sync", "broadcast"];

function onboardTextField(labelText, placeholder, value) {
  const row = document.createElement("div");
  row.className = "onboard-row";
  const label = document.createElement("label");
  label.className = "onboard-label";
  label.textContent = labelText;
  const input = document.createElement("input");
  input.type = "text";
  input.className = "onboard-input";
  input.placeholder = placeholder;
  if (value) input.value = value;
  row.appendChild(label);
  row.appendChild(input);
  return { row, input };
}

// Lenient parse of stored memory back into the four setup fields so the edit
// form can prefill. Handles the canonical inline form ("genre: …", "heard on: …")
// and best-effort the older header-then-value form ("## GENRE\n<value>") so an
// edit + save migrates a legacy project onto the clean shape.
function parseSetupFields(text) {
  const out = { genre: "", platforms: [], label: "", track: "" };
  const assign = (key, val) => {
    key = key.trim().toLowerCase();
    val = val.trim();
    if (!val) return;
    if (key === "genre" && !out.genre) out.genre = val;
    else if ((key === "heard on" || key === "platform" || key === "delivery") && !out.platforms.length)
      out.platforms = val.split(",").map((s) => s.trim()).filter(Boolean);
    else if (key === "label" && !out.label) out.label = val;
    else if (key === "track" && !out.track) out.track = val;
  };
  let header = "";
  for (const raw of (text || "").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const hdr = line.match(/^#{1,6}\s*(.+)$/);
    if (hdr) { header = hdr[1].trim(); continue; }
    const colon = line.indexOf(":");
    if (colon > 0 && colon < 20) { assign(line.slice(0, colon), line.slice(colon + 1)); header = ""; continue; }
    if (header) { assign(header, line); }
  }
  return out;
}

function renderOnboardingForm(prefill, isEdit) {
  prefill = prefill || { genre: "", platforms: [], label: "", track: "" };
  const wrap = document.createElement("div");
  wrap.className = "msg assistant onboard";

  const intro = document.createElement("div");
  intro.className = "onboard-intro";
  intro.innerHTML = renderMarkdown(isEdit
    ? "Editing project setup. Change what's moved — this overwrites what I remember."
    : "New project. Two things anchor how I read every measurement — the rest I catch from your set and as we talk.");
  wrap.appendChild(intro);

  const genre = onboardTextField("Genre / subgenre", "melodic techno, liquid dnb, ambient…", prefill.genre);
  wrap.appendChild(genre.row);

  const platLabel = document.createElement("label");
  platLabel.className = "onboard-label";
  platLabel.textContent = "Where will it be heard?";
  wrap.appendChild(platLabel);
  const chips = document.createElement("div");
  chips.className = "onboard-chips";
  const selected = new Set();
  ONBOARD_PLATFORMS.forEach((p) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "onboard-chip";
    chip.textContent = p;
    if (prefill.platforms && prefill.platforms.includes(p)) { selected.add(p); chip.classList.add("selected"); }
    chip.addEventListener("click", () => {
      if (selected.has(p)) { selected.delete(p); chip.classList.remove("selected"); }
      else { selected.add(p); chip.classList.add("selected"); }
      updateSaveState();
    });
    chips.appendChild(chip);
  });
  wrap.appendChild(chips);

  const label = onboardTextField("Label you're chasing (optional)", "Drumcode, Anjunadeep…", prefill.label);
  wrap.appendChild(label.row);
  const track = onboardTextField("Track you're chasing (optional)", "artist – title", prefill.track);
  wrap.appendChild(track.row);

  const hint = document.createElement("div");
  hint.className = "onboard-hint";
  hint.textContent = "A well-known label or track works best — I reason from what I recognize.";
  wrap.appendChild(hint);

  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.className = "onboard-save";
  saveBtn.textContent = isEdit ? "Update" : "Save & start";
  wrap.appendChild(saveBtn);

  function updateSaveState() {
    saveBtn.disabled = !(genre.input.value.trim() && selected.size > 0);
  }
  genre.input.addEventListener("input", updateSaveState);
  updateSaveState();

  saveBtn.addEventListener("click", async () => {
    saveBtn.disabled = true;
    const lines = [
      `genre: ${genre.input.value.trim()}`,
      `heard on: ${Array.from(selected).join(", ")}`,
    ];
    if (label.input.value.trim()) lines.push(`label: ${label.input.value.trim()}`);
    if (track.input.value.trim()) lines.push(`track: ${track.input.value.trim()}`);
    const r = await runTool("save_memory", { content: lines.join("\n") });
    wrap.remove();
    if (r && r.ok) {
      const verb = isEdit ? "Updated" : "Saved";
      addMessage("assistant", `${verb} — **${genre.input.value.trim()}**, for ${Array.from(selected).join(", ")}. Tell me what to look at, or just play the section.`);
    } else {
      addMessage("assistant", `Couldn't save that — ${(r && r.error) || "unknown error"}. We can still work; I just won't carry it across sessions.`);
    }
  });

  messagesEl.appendChild(wrap);
}

function renderOpener(memoryText, noProject) {
  if (messagesEl.children.length > 0) return;
  if (noProject) {
    const el = document.createElement("div");
    el.className = "msg assistant opener";
    el.innerHTML = renderMarkdown(`Your Live set isn't saved yet, so I can't store or recall memory for this project. **Save the set** (Cmd+S) and reload this device to enable persistent memory. We can still chat — just nothing carries across sessions.`);
    messagesEl.appendChild(el);
    return;
  }
  const trimmed = (memoryText || "").trim();
  if (trimmed.length === 0) {
    renderOnboardingForm();
    return;
  }
  const el = document.createElement("div");
  el.className = "msg assistant opener";
  const intro = `Here's what I remember about this project from previous sessions. Skim it and tell me what's changed or what's wrong before we dig in — minds change, mixes move.\n\n---\n\n`;
  el.innerHTML = renderMarkdown(intro + trimmed);
  messagesEl.appendChild(el);

  // Costless edit path: revising the canonical setup fields shouldn't cost an
  // inference any more than first-time onboarding did. Opens the same form,
  // prefilled, writing straight to memory on save.
  const editBtn = document.createElement("button");
  editBtn.type = "button";
  editBtn.className = "onboard-edit-link";
  editBtn.textContent = "Edit setup";
  editBtn.addEventListener("click", () => {
    el.remove();
    editBtn.remove();
    renderOnboardingForm(parseSetupFields(trimmed), true);
  });
  messagesEl.appendChild(editBtn);
}

function addMessage(role, text) {
  const el = document.createElement("div");
  el.className = `msg ${role}`;
  if (role === "assistant") el.innerHTML = renderMarkdown(text);
  else el.textContent = text;
  messagesEl.appendChild(el);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return el;
}

// Tracks an open picker so a free-form user message (typed instead of clicked)
// can resolve the pending tool_use cleanly. Without this, typing past a picker
// leaves the tool_use dangling and the Anthropic API rejects the next turn
// with "tool_use ids were found without tool_result blocks immediately after".
let pendingPickerResolver = null;

// Render the ask_user_choice picker inline in the message stream. Returns a
// Promise that resolves with the selected label when the user clicks OR with
// the typed text when the user bypasses the buttons by sending a regular
// message. Buttons disable on resolution so the same picker can't be answered
// twice.
function renderPicker(question, options) {
  return new Promise((resolve) => {
    const wrap = document.createElement("div");
    wrap.className = "msg assistant picker";
    const q = document.createElement("div");
    q.className = "picker-question";
    q.textContent = question;
    wrap.appendChild(q);
    const btnRow = document.createElement("div");
    btnRow.className = "picker-options";
    let resolved = false;
    const finish = (value, viaClick) => {
      if (resolved) return;
      resolved = true;
      pendingPickerResolver = null;
      Array.from(btnRow.children).forEach(b => {
        b.disabled = true;
        if (!viaClick || b.dataset.label !== value) b.classList.add("picker-unchosen");
      });
      if (viaClick) {
        const chosenBtn = Array.from(btnRow.children).find(b => b.dataset.label === value);
        if (chosenBtn) { chosenBtn.classList.remove("picker-unchosen"); chosenBtn.classList.add("picker-chosen"); }
        addMessage("user", value);
      }
      resolve(value);
    };
    options.forEach((opt) => {
      const btn = document.createElement("button");
      btn.className = "picker-btn";
      btn.type = "button";
      const label = (opt && opt.label) || "";
      btn.dataset.label = label;
      const desc = opt && opt.description;
      btn.innerHTML = `<span class="picker-label">${label}</span>` + (desc ? `<span class="picker-desc">${desc}</span>` : "");
      btn.addEventListener("click", () => finish(label, true));
      btnRow.appendChild(btn);
    });
    wrap.appendChild(btnRow);
    messagesEl.appendChild(wrap);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    // Expose a resolver the send() flow can call when the user types past the picker.
    pendingPickerResolver = (typedText) => finish(typedText, false);
  });
}

function clearChat() {
  messagesEl.innerHTML = "";
  currentAssistantEl = null;
  currentAssistantText = "";
}

async function loadInitialMemory() {
  const r = await runTool("get_memory", {});
  if (r && r.noProject) renderOpener("", true);
  else renderOpener(r?.content || "", false);
}

// Load only the session class the chosen provider needs. anthropic.js carries the
// Anthropic SDK (esm.sh) and its Haiku extraction path; the local/OpenRouter path
// must never trigger that fetch, so the import is dynamic and provider-gated.
async function loadSessionClass(provider) {
  if (provider === "anthropic") {
    return (await import("./anthropic.js")).ClaudeSession;
  }
  return (await import("./openai.js")).OpenAICompatSession;
}

async function initSession(config) {
  const callbacks = {
    onText: (delta) => {
      hideThinking();
      if (!currentAssistantEl) {
        currentAssistantText = "";
        currentAssistantEl = addMessage("assistant", "");
      }
      currentAssistantText += delta;
      currentAssistantEl.innerHTML = renderMarkdown(currentAssistantText);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    },
    onToolStart: () => {
      showThinking();
      currentAssistantEl = null;
      currentAssistantText = "";
    },
    onDone: () => {
      hideThinking();
      currentAssistantEl = null;
      currentAssistantText = "";
      turnInFlight = false;
      sendBtn.disabled = false;
    },
    onError: (message) => {
      hideThinking();
      addMessage("error", `error: ${message}`);
      currentAssistantEl = null;
      currentAssistantText = "";
      turnInFlight = false;
      sendBtn.disabled = false;
    },
    onUsage: (u) => {
      metricsCost = u.cost_usd || 0;
      metricsTokens = (u.input || 0) + (u.output || 0);
      applyMetrics();
    },
    onAskUserChoice: async (question, options) => {
      hideThinking();
      currentAssistantEl = null;
      currentAssistantText = "";
      const picked = await renderPicker(question, options);
      showThinking();
      return picked;
    }
  };
  // Same callback contract for either provider; the config decides the class.
  const SessionClass = await loadSessionClass(config.provider);
  session = config.provider === "anthropic"
    ? new SessionClass({ apiKey: config.apiKey, ...callbacks })
    : new SessionClass({ ...config, ...callbacks });
  costMode = LOCAL_PROVIDERS.has(config.provider) ? "free"
    : COST_TRACKED_PROVIDERS.has(config.provider) ? "usd"
    : "untracked";
  setStatus(true);
}

async function send() {
  const text = inputEl.value.trim();
  if (!text || !session) return;
  // If a picker is awaiting a response, route the typed text as its
  // answer instead of opening a brand-new turn. That keeps every
  // tool_use paired with a tool_result so the API doesn't reject the
  // next message.
  if (pendingPickerResolver) {
    addMessage("user", text);
    inputEl.value = "";
    pendingPickerResolver(text);
    return;
  }
  // Guard against a second turn while one is still streaming. The Enter handler
  // bypasses the disabled button, and starting a new send() mid-turn injected a
  // user message between a tool_use and its tool_result → the API rejected the
  // next request and the chat had to be restarted. Ignore the input (keep the
  // typed text so the user can resend) until the current turn finishes.
  if (turnInFlight) return;
  addMessage("user", text);
  inputEl.value = "";
  sendBtn.disabled = true;
  turnInFlight = true;
  currentAssistantEl = null;
  showThinking();
  await session.send(text);
}

sendBtn.addEventListener("click", send);
inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
});

const settings = mountSettings({
  onSaved: (config) => {
    saveConfigToFile(config);  // durable file backup (fire-and-forget; localStorage already written)
    initSession(config);
    if (messagesEl.children.length === 0) loadInitialMemory();
  },
  onCleared: () => {
    saveConfigToFile({});  // clear the file too (empty object → next boot reads null)
    session = null;
    setStatus(false);
    clearChat();
  }
});

// Boot: localStorage first (fast sync), then file fallback (survives localStorage clears).
// getStoredConfig migrates any legacy Anthropic-only key on first read.
(async () => {
  let storedConfig = getStoredConfig();
  if (!storedConfig) storedConfig = await readConfigFromFile();
  if (storedConfig) {
    initSession(storedConfig);
    loadInitialMemory();
  } else {
    setStatus(false);
    settings.showOverlay();
  }
})();
