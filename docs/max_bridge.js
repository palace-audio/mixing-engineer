const pending = new Map();
const chunkBuf = new Map(); // requestId -> { parts: [], total }
let nextId = 1;

// Results arrive chunked: live_query.js splits the encoded JSON into N atoms and
// sends each as "result <requestId> <index> <total> <chunk>". Reassemble here,
// then decode + parse once all chunks for a requestId are in.
function handleMaxResult(requestId, chunkIndex, total, chunkData) {
  const key = String(requestId);
  const r = pending.get(key);
  if (!r) return;
  let buf = chunkBuf.get(key);
  if (!buf) { buf = { parts: [], total: Number(total) }; chunkBuf.set(key, buf); }
  buf.parts[Number(chunkIndex)] = chunkData;
  let have = 0;
  for (let i = 0; i < buf.total; i++) if (typeof buf.parts[i] === "string") have++;
  if (have < buf.total) return; // wait for remaining chunks
  chunkBuf.delete(key);
  pending.delete(key);
  clearTimeout(r.timer);
  try {
    const jsonStr = decodeURIComponent(buf.parts.join(""));
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
        chunkBuf.delete(id);
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
