import { ClaudeSession } from "./anthropic.js";
import { query } from "./max_bridge.js";
import { mountSettings, getStoredKey } from "./settings.js";
import { runTool } from "./tools.js";

const messagesEl = document.getElementById("messages");
const inputEl = document.getElementById("input");
const sendBtn = document.getElementById("send");
const statusEl = document.getElementById("status");
const statusTextEl = document.getElementById("status-text");
const costEl = document.getElementById("cost");
const tokEl = document.getElementById("tok");

let session = null;
let currentAssistantEl = null;
let currentAssistantText = "";
let thinkingEl = null;

let metricsStatus = "Offline";
let metricsCost = 0;
let metricsTokens = 0;

function applyMetrics() {
  if (statusEl) {
    statusEl.classList.remove("connected", "disconnected", "thinking");
    if (metricsStatus === "Offline") statusEl.classList.add("disconnected");
    else if (metricsStatus === "Thinking") statusEl.classList.add("thinking");
    else statusEl.classList.add("connected");
  }
  if (statusTextEl) statusTextEl.textContent = metricsStatus;
  if (costEl) costEl.textContent = "$" + metricsCost.toFixed(3);
  if (tokEl) {
    tokEl.textContent = metricsTokens >= 1000
      ? (metricsTokens / 1000).toFixed(1) + "k tok"
      : metricsTokens + " tok";
  }
  if (window.max && typeof window.max.outlet === "function") {
    const costStr = "$" + metricsCost.toFixed(2);
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

const OPENER_NEW = `Welcome. I work best when I know what we're mixing.

Before we dig in, tell me:
- **Genre / style** (e.g. melodic techno, dnb, ambient)?
- **Where will this be heard** (club, headphones, car, streaming)?
- **References** — any tracks you want this to sit alongside?
- **What's bugging you right now** — anything specific you want me to look at first?

You don't have to answer all of it. Even one line of context shapes how I read your mix.`;

function renderOpener(memoryText, noProject) {
  if (messagesEl.children.length > 0) return;
  const el = document.createElement("div");
  el.className = "msg assistant opener";
  if (noProject) {
    el.innerHTML = renderMarkdown(`Your Live set isn't saved yet, so I can't store or recall memory for this project. **Save the set** (Cmd+S) and reload this device to enable persistent memory. We can still chat — just nothing carries across sessions.`);
    messagesEl.appendChild(el);
    return;
  }
  const trimmed = (memoryText || "").trim();
  if (trimmed.length < 50) {
    el.innerHTML = renderMarkdown(OPENER_NEW);
  } else {
    const intro = `Here's what I remember about this project from previous sessions. Skim it and tell me what's changed or what's wrong before we dig in — minds change, mixes move.\n\n---\n\n`;
    el.innerHTML = renderMarkdown(intro + trimmed);
  }
  messagesEl.appendChild(el);
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

function initSession(apiKey) {
  session = new ClaudeSession({
    apiKey,
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
      sendBtn.disabled = false;
    },
    onError: (message) => {
      hideThinking();
      addMessage("error", `error: ${message}`);
      currentAssistantEl = null;
      currentAssistantText = "";
      sendBtn.disabled = false;
    },
    onUsage: (u) => {
      metricsCost = u.cost_usd || 0;
      metricsTokens = (u.input || 0) + (u.output || 0);
      applyMetrics();
    }
  });
  setStatus(true);
}

async function send() {
  const text = inputEl.value.trim();
  if (!text || !session) return;
  addMessage("user", text);
  inputEl.value = "";
  sendBtn.disabled = true;
  currentAssistantEl = null;
  showThinking();
  await session.send(text);
}

sendBtn.addEventListener("click", send);
inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
});

const settings = mountSettings({
  onSaved: (apiKey) => {
    initSession(apiKey);
    if (messagesEl.children.length === 0) loadInitialMemory();
  },
  onCleared: () => {
    session = null;
    setStatus(false);
    clearChat();
  }
});

const existingKey = getStoredKey();
if (existingKey) {
  initSession(existingKey);
  loadInitialMemory();
} else {
  setStatus(false);
  settings.showOverlay("");
}
