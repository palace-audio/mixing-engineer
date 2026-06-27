const pending = new Map();
const chunkBuf = new Map(); // requestId -> { parts: [], total }
let nextId = 1;

// The timer bounds SILENCE, not total duration. It fires only if the Max `js`
// side sends NOTHING — no result chunk, no progress heartbeat — for this long,
// which means it has crashed or hung. It is a liveness bound, not a "how long
// should work take" guess: a long capture (an 8-bar recording is ~15 s of
// wall-clock on its own, and an 8-voice FFT synthesis adds more) never trips it,
// because every chunk and every heartbeat re-arms it. Chosen to comfortably
// exceed any single healthy operation while still surfacing a real hang within a
// tolerable wait. live_query.js emits a `progress <id>` heartbeat the moment it
// starts handling a query (see query() there), so the window starts when work
// begins, not when the request was sent — transit/queue never eat into it.
const SILENCE_MS = 20000;

// (Re)arm the silence timer for a request. Called once when the query is sent,
// and again on every sign of life (chunk or heartbeat) from the Max side.
function rearm(key) {
  const r = pending.get(key);
  if (!r) return;
  clearTimeout(r.timer);
  r.timer = setTimeout(() => {
    if (pending.has(key)) {
      pending.delete(key);
      chunkBuf.delete(key);
      r.resolve({ error: "LiveAPI query timed out (no response from Max): " + r.queryName });
    }
  }, SILENCE_MS);
}

// Results arrive chunked: live_query.js splits the encoded JSON into N atoms and
// sends each as "result <requestId> <index> <total> <chunk>". Reassemble here,
// then decode + parse once all chunks for a requestId are in.
//
// HEARTBEAT: live_query.js also emits a sentinel "result <id> -1 -1 ''" the moment
// it starts handling a query (before a long synchronous synthesis that streams no
// chunks until done). It travels the exact same routed path as a real chunk, so it
// needs no Max-patch change; here it just re-arms the silence window and returns.
function handleMaxResult(requestId, chunkIndex, total, chunkData) {
  const key = String(requestId);
  const r = pending.get(key);
  if (!r) return;   // already resolved or timed out — a late chunk; nothing to do.
  rearm(key);       // any inbound atom (chunk OR heartbeat) is proof of life.
  if (Number(total) < 1 || Number(chunkIndex) < 0) return;  // heartbeat sentinel — not data.
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
    pending.set(id, { resolve, queryName, timer: null });
    rearm(id);   // arm the silence timer
    if (window.max && typeof window.max.outlet === "function") {
      window.max.outlet("query", queryName, id, ...params);
    } else {
      const r = pending.get(id);
      if (r) clearTimeout(r.timer);
      pending.delete(id);
      resolve({ error: "not running inside Max — LiveAPI unavailable" });
    }
  });
}

export const isLiveMode = (window.max && typeof window.max.outlet === "function");
