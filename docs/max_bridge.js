const pending = new Map();
let nextId = 1;

function handleMaxResult(requestId, payload) {
  const r = pending.get(String(requestId));
  if (!r) return;
  pending.delete(String(requestId));
  clearTimeout(r.timer);
  try {
    // Payload is URL-encoded JSON: Max splits messages on whitespace, so
    // raw JSON would fragment into multiple atoms across the patchcord.
    const jsonStr = decodeURIComponent(payload);
    r.resolve(JSON.parse(jsonStr));
  } catch (e) {
    r.resolve({ error: "parse error: " + e.message });
  }
}

if (window.max && typeof window.max.bindInlet === "function") {
  window.max.bindInlet("onMaxResult", handleMaxResult);
}

export function query(queryName, ...params) {
  const id = String(nextId++);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        resolve({ error: "LiveAPI query timeout: " + queryName });
      }
    }, 15000);
    pending.set(id, { resolve, timer });
    if (window.max && typeof window.max.outlet === "function") {
      window.max.outlet("query", queryName, id, ...params);
    } else {
      pending.delete(id);
      clearTimeout(timer);
      resolve({ error: "not running inside Max — LiveAPI unavailable" });
    }
  });
}

export const isLiveMode = (window.max && typeof window.max.outlet === "function");
