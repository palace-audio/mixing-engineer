// validateApiKey is imported lazily (only when the user picks Anthropic) so this
// module — loaded at boot via mountSettings — never pulls anthropic.js / the esm.sh
// SDK on the local/OpenRouter path. validateProvider lives in the SDK-free openai.js.
import { validateProvider } from "./openai.js";

// One stored config for every provider: {provider, baseUrl, model, apiKey}.
// app.js reads it via getStoredConfig() and the factory picks the session class.
const CONFIG_KEY = "mix_provider_config";
const LEGACY_KEY = "anthropic_api_key";   // pre-provider-abstraction Anthropic-only key

// Provider catalog for the settings overlay. baseUrl = preset endpoint;
// baseUrlEditable lets the user override it (local + custom); needsModel shows
// the model field (all except Anthropic, which auto-routes Haiku/Opus itself);
// keyRequired gates Save; local flips the CORS note + the cost display. `help`
// is the bottom line: what to DO for this provider, including what the Model
// field expects. No cost/privacy editorializing.
const PROVIDERS = {
  anthropic: {
    label: "Anthropic (Claude)", local: false, baseUrl: "", baseUrlEditable: false,
    needsModel: false, keyRequired: true, keyHint: "sk-ant-...",
    help: "Get your key at console.anthropic.com"
  },
  openrouter: {
    label: "OpenRouter", local: false, baseUrl: "https://openrouter.ai/api/v1", baseUrlEditable: false,
    needsModel: true, keyRequired: true, keyHint: "sk-or-v1-...", modelHint: "deepseek/deepseek-v4-flash",
    help: "Get a key and add credit at openrouter.ai. Model = an OpenRouter slug like deepseek/deepseek-v4-flash."
  },
  ollama: {
    label: "Ollama (local · free)", local: true, baseUrl: "http://localhost:11434/v1", baseUrlEditable: true,
    needsModel: true, keyRequired: false, modelHint: "qwen2.5:7b",
    help: "Pull a model with `ollama pull <name>`, then enter <name> as the Model.",
    cors: "Set OLLAMA_ORIGINS={origin} so the browser can connect."
  },
  lmstudio: {
    label: "LM Studio (local · free)", local: true, baseUrl: "http://localhost:1234/v1", baseUrlEditable: true,
    needsModel: true, keyRequired: false, modelHint: "loaded model id",
    help: "Load a model in LM Studio's server, then enter its id as the Model.",
    cors: "Enable CORS in LM Studio's server settings."
  },
  custom: {
    label: "Custom (OpenAI-compatible)", local: false, baseUrl: "", baseUrlEditable: true,
    needsModel: true, keyRequired: false, keyHint: "optional", modelHint: "model id",
    help: "Enter the server base URL (…/v1) and a model it serves."
  }
};
const DEFAULT_PROVIDER = "";  // no pre-selection — user must choose

// Returns the stored config, migrating a legacy Anthropic-only key on first read.
export function getStoredConfig() {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (raw) {
      const cfg = JSON.parse(raw);
      if (cfg && cfg.provider) return cfg;
    }
    const legacy = localStorage.getItem(LEGACY_KEY);
    if (legacy) {
      const cfg = { provider: "anthropic", baseUrl: "", model: "", apiKey: legacy };
      localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
      localStorage.removeItem(LEGACY_KEY);
      return cfg;
    }
    return null;
  } catch {
    return null;
  }
}

function setStoredConfig(cfg) {
  try { localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg)); }
  catch (e) { console.warn("[settings] config write failed:", e); }
}

function clearStoredConfig() {
  try { localStorage.removeItem(CONFIG_KEY); localStorage.removeItem(LEGACY_KEY); }
  catch (e) { console.warn("[settings] config clear failed:", e); }
}

export function mountSettings({ onSaved, onCleared }) {
  const overlay      = document.getElementById("settings-overlay");
  const providerSel  = document.getElementById("settings-provider");
  const baseUrlRow   = document.getElementById("settings-baseurl-row");
  const baseUrlInput = document.getElementById("settings-baseurl");
  const modelRow     = document.getElementById("settings-model-row");
  const modelInput   = document.getElementById("settings-model");
  const keyLabel     = document.getElementById("settings-key-label");
  const keyInput     = document.getElementById("settings-key-input");
  const corsHint     = document.getElementById("settings-cors-hint");
  const saveBtn      = document.getElementById("settings-save");
  const cancelBtn    = document.getElementById("settings-cancel");
  const errEl        = document.getElementById("settings-error");
  const helpText     = document.getElementById("settings-help-text");
  const gear         = document.getElementById("settings-gear");
  const menu         = document.getElementById("settings-menu");
  const menuChange   = document.getElementById("settings-change");
  const menuClear    = document.getElementById("settings-clear");

  const phOpt = document.createElement("option");
  phOpt.value = ""; phOpt.textContent = "Select a provider…"; phOpt.disabled = true;
  providerSel.appendChild(phOpt);
  for (const [id, p] of Object.entries(PROVIDERS)) {
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = p.label;
    providerSel.appendChild(opt);
  }

  // Show/hide and relabel fields to match the selected provider.
  function applyProviderUI() {
    const p = PROVIDERS[providerSel.value] || {};
    baseUrlRow.classList.toggle("hidden", !p.baseUrlEditable);
    if (!p.baseUrlEditable) baseUrlInput.value = p.baseUrl || "";
    else if (!baseUrlInput.value) baseUrlInput.value = p.baseUrl || "";
    baseUrlInput.placeholder = p.baseUrl || "https://…/v1";

    modelRow.classList.toggle("hidden", !p.needsModel);
    modelInput.placeholder = p.modelHint || "model id";

    keyLabel.textContent = p.keyRequired ? "API key" : "API key (optional)";
    keyInput.placeholder = p.keyHint || "";

    // {origin} → the literal origin this page is served from (localhost in dev,
    // the github.io URL in prod), since that's exactly what OLLAMA_ORIGINS must allow.
    if (p.cors) { corsHint.textContent = p.cors.replace("{origin}", location.origin); corsHint.classList.remove("hidden"); }
    else corsHint.classList.add("hidden");

    if (helpText) helpText.textContent = p.help || "";
  }

  function showOverlay(prefill) {
    const cfg = prefill || {};
    providerSel.value = (cfg.provider && PROVIDERS[cfg.provider]) ? cfg.provider : "";
    baseUrlInput.value = cfg.baseUrl || "";
    modelInput.value = cfg.model || "";
    keyInput.value = "";   // never prefill the secret
    errEl.textContent = "";
    applyProviderUI();
    // Editing an existing config: blank key keeps the stored one.
    if (cfg.apiKey) keyInput.placeholder = "leave blank to keep current key";
    overlay.classList.remove("hidden");
    cancelBtn.classList.toggle("hidden", !getStoredConfig());
    setTimeout(() => providerSel.focus?.(), 50);
  }

  function hideOverlay() { overlay.classList.add("hidden"); }
  function hideMenu() { menu.classList.add("hidden"); }

  async function trySave() {
    const provider = providerSel.value;
    if (!provider || !PROVIDERS[provider]) { errEl.textContent = "Select a provider."; return; }
    const p = PROVIDERS[provider];
    const baseUrl = p.baseUrlEditable ? (baseUrlInput.value || "").trim() : (p.baseUrl || "");
    const model = p.needsModel ? (modelInput.value || "").trim() : "";
    let apiKey = (keyInput.value || "").trim();

    // Blank key on edit → reuse the stored key for the same provider.
    if (!apiKey) {
      const existing = getStoredConfig();
      if (existing && existing.provider === provider && existing.apiKey) apiKey = existing.apiKey;
    }

    if (p.needsModel && !model) { errEl.textContent = "Enter a model id for this provider."; return; }
    if (p.baseUrlEditable && !baseUrl) { errEl.textContent = "Enter the server base URL (…/v1)."; return; }
    if (p.keyRequired && !apiKey) { errEl.textContent = "Enter your API key."; return; }
    if (provider === "anthropic" && apiKey && !apiKey.startsWith("sk-")) {
      errEl.textContent = "Anthropic keys start with 'sk-ant-'."; return;
    }

    saveBtn.disabled = true; saveBtn.textContent = "Validating…"; errEl.textContent = "";
    const result = provider === "anthropic"
      ? await (await import("./anthropic.js")).validateApiKey(apiKey)
      : await validateProvider({ provider, baseUrl, apiKey });
    saveBtn.disabled = false; saveBtn.textContent = "Save";

    if (result.ok) {
      const cfg = { provider, baseUrl, model, apiKey };
      setStoredConfig(cfg);
      hideOverlay();
      onSaved?.(cfg);
    } else {
      errEl.textContent = result.error || "Validation failed.";
    }
  }

  providerSel.addEventListener("change", applyProviderUI);
  saveBtn.addEventListener("click", trySave);
  cancelBtn.addEventListener("click", hideOverlay);
  keyInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); trySave(); } });
  modelInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); trySave(); } });

  gear.addEventListener("click", (e) => { e.stopPropagation(); menu.classList.toggle("hidden"); });
  document.addEventListener("click", hideMenu);

  menuChange.addEventListener("click", (e) => {
    e.preventDefault(); hideMenu();
    showOverlay(getStoredConfig());
  });
  menuClear.addEventListener("click", (e) => {
    e.preventDefault(); hideMenu();
    if (confirm("Clear provider settings? The device returns to setup.")) {
      clearStoredConfig();
      onCleared?.();
      showOverlay(null);
    }
  });

  return { showOverlay, hideOverlay };
}
