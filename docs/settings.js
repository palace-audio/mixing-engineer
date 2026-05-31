import { validateApiKey } from "./anthropic.js";

const STORAGE_KEY = "anthropic_api_key";

export function getStoredKey() {
  try { return localStorage.getItem(STORAGE_KEY) || ""; }
  catch { return ""; }
}

function setStoredKey(key) {
  try { localStorage.setItem(STORAGE_KEY, key); }
  catch (e) { console.warn("[settings] localStorage write failed:", e); }
}

function clearStoredKey() {
  try { localStorage.removeItem(STORAGE_KEY); }
  catch (e) { console.warn("[settings] localStorage clear failed:", e); }
}

function maskKey(key) {
  if (!key) return "";
  if (key.length <= 10) return key;
  return key.slice(0, 7) + "…" + key.slice(-5);
}

export function mountSettings({ onSaved, onCleared }) {
  const overlay = document.getElementById("settings-overlay");
  const input = document.getElementById("settings-key-input");
  const saveBtn = document.getElementById("settings-save");
  const cancelBtn = document.getElementById("settings-cancel");
  const errEl = document.getElementById("settings-error");
  const gear = document.getElementById("settings-gear");
  const menu = document.getElementById("settings-menu");
  const menuChange = document.getElementById("settings-change");
  const menuClear = document.getElementById("settings-clear");
  const whyLink = document.getElementById("settings-why");
  const whyText = document.getElementById("settings-why-text");

  function showOverlay(prefill) {
    input.value = "";
    input.placeholder = prefill ? maskKey(prefill) : "sk-ant-...";
    errEl.textContent = "";
    overlay.classList.remove("hidden");
    cancelBtn.classList.toggle("hidden", !prefill);
    setTimeout(() => input.focus(), 50);
  }

  function hideOverlay() {
    overlay.classList.add("hidden");
  }

  function hideMenu() { menu.classList.add("hidden"); }

  async function trySave() {
    const key = (input.value || "").trim();
    if (!key) {
      errEl.textContent = "Paste your Anthropic API key first.";
      return;
    }
    if (!key.startsWith("sk-")) {
      errEl.textContent = "Key looks malformed — should start with 'sk-ant-'.";
      return;
    }
    saveBtn.disabled = true;
    saveBtn.textContent = "Validating…";
    errEl.textContent = "";
    const result = await validateApiKey(key);
    saveBtn.disabled = false;
    saveBtn.textContent = "Save";
    if (result.ok) {
      setStoredKey(key);
      hideOverlay();
      onSaved?.(key);
    } else {
      errEl.textContent = "Key rejected: " + (result.error || "unknown error");
    }
  }

  saveBtn.addEventListener("click", trySave);
  cancelBtn.addEventListener("click", hideOverlay);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); trySave(); }
  });

  whyLink.addEventListener("click", (e) => {
    e.preventDefault();
    whyText.classList.toggle("hidden");
  });

  gear.addEventListener("click", (e) => {
    e.stopPropagation();
    menu.classList.toggle("hidden");
  });
  document.addEventListener("click", hideMenu);

  menuChange.addEventListener("click", (e) => {
    e.preventDefault();
    hideMenu();
    showOverlay(getStoredKey());
  });

  menuClear.addEventListener("click", (e) => {
    e.preventDefault();
    hideMenu();
    if (confirm("Clear stored API key? The device will return to setup.")) {
      clearStoredKey();
      onCleared?.();
      showOverlay("");
    }
  });

  return { showOverlay, hideOverlay };
}
