import { query } from "./max_bridge.js";

const MEMORY_KEY_PREFIX = "mixingengineer_memory:";

async function getMemoryStorageKey() {
  const r = await query("get_project_path");
  const path = (r && r.path) || "";
  if (!path) return null;
  return MEMORY_KEY_PREFIX + path;
}

async function readMemory() {
  const key = await getMemoryStorageKey();
  if (!key) return { content: "", noProject: true, note: "Live set unsaved — save the set first to enable memory." };
  try {
    const content = localStorage.getItem(key) || "";
    return { content, key };
  } catch (e) {
    return { content: "", error: "localStorage read failed: " + e.message };
  }
}

async function writeMemory(content) {
  const key = await getMemoryStorageKey();
  if (!key) return { ok: false, error: "Live set unsaved — save the set first to enable memory." };
  try {
    localStorage.setItem(key, content);
    return { ok: true, key, bytes: content.length };
  } catch (e) {
    return { ok: false, error: "localStorage write failed: " + e.message };
  }
}

export const tools = [
  {
    name: "list_tracks",
    description: "Returns every track in the Live set with name, type (audio/midi/group), mute, solo, volume (raw + dB display), pan, sends, frozen/armed/playing state, plus session tempo. Call this first to orient yourself.",
    input_schema: { type: "object", properties: {}, required: [] }
  },
  {
    name: "get_track_devices",
    description: "Returns the device chain for a specific track by name (case-insensitive). Recursively walks into Effect Rack / Instrument Rack chains so nested devices appear flat with chain_path showing the rack/chain location. Each device returns name, class, active state, can_have_chains, plus snapshot gain_reduction_db on dynamics devices that expose it.",
    input_schema: {
      type: "object",
      properties: { track_name: { type: "string", description: "Track name (fuzzy matched)" } },
      required: ["track_name"]
    }
  },
  {
    name: "get_device_params",
    description: "Returns all parameters of a specific device with value, display value (e.g. '-3.0 dB'), min, max, is_quantized, automation_state, and value_items (enum labels). CRITICAL: Call this whenever you're about to describe what a device is actually doing — never describe a device's behavior (drive, dry/wet, threshold, frequency, etc.) without first inspecting its parameters.",
    input_schema: {
      type: "object",
      properties: {
        track: { type: "string", description: 'Track name, or "master" for the master chain' },
        device_index: { type: "integer", description: "Index of the device in the chain (from get_track_devices or get_master_chain)" }
      },
      required: ["track", "device_index"]
    }
  },
  {
    name: "get_session_overview",
    description: "Top-level session info: tempo, time signature, track/return/scene/locator counts, playing state, current arrangement position, groove, metronome, transport loop. Cheap, useful to call early.",
    input_schema: { type: "object", properties: {}, required: [] }
  },
  {
    name: "get_track_routing",
    description: "Output/input routing, monitoring state, group, and all send levels (with dB display values) for one track. Use for investigating sidechain routing or send/return relationships.",
    input_schema: {
      type: "object",
      properties: { track_name: { type: "string" } },
      required: ["track_name"]
    }
  },
  {
    name: "get_returns",
    description: "All return tracks with names, volumes, and device chains. Use when investigating reverbs/delays or anything routed through sends.",
    input_schema: { type: "object", properties: {}, required: [] }
  },
  {
    name: "get_memory",
    description: "Reads the persistent memory for this project. Use at the start of conversations to recall context. Returns the saved markdown content, or empty string if no memory yet.",
    input_schema: { type: "object", properties: {}, required: [] }
  },
  {
    name: "save_memory",
    description: "Writes/overwrites the persistent memory for this project. Memory is for DURABLE INTENT ONLY — vibe and targets that the user wants the track to embody. Save: genre, intended mood/feel, reference tracks, target loudness/dynamics goal, intentional creative choices the user wants preserved. NEVER save: implemented changes, settings applied, measurements (all expire and are re-queryable from Live), track lists (queryable via list_tracks), debugging notes. If the only thing you have to save is what was done in this session, don't call save_memory. HARD LIMITS: 200 chars max, 40 chars per line, 5 words per line. Comma-separated terms under one-line section headers.",
    input_schema: {
      type: "object",
      properties: {
        content: { type: "string", description: "Full markdown content to save. Replaces existing memory entirely." }
      },
      required: ["content"]
    }
  },
  {
    name: "analyze_section",
    description: "Single audio entry point. Captures audio between two locators (or from current position) and analyzes it. Optionally analyzes specific 'focus' tracks in parallel via routed taps (no soloing, no transport disruption) — up to 8 tracks at full FFT/peak/RMS/time_series/automation/gain_reduction. Optionally compares mix to the sidechain-routed reference.",
    input_schema: {
      type: "object",
      properties: {
        start_locator: { type: "string", description: "Locator name (fuzzy matched), OR 'here' for current transport position." },
        end_locator: { type: "string", description: "Optional. Locator name; if omitted, the next locator after start_locator is used. Ignored when start_locator='here'." },
        seconds: { type: "number", description: "Capture duration when start_locator='here'. Default 10. Ignored when using locators." },
        focus_tracks: { type: "array", items: { type: "string" }, description: "Optional. Up to 8 track names (fuzzy matched) to analyze in parallel. Hard cap at 8." },
        reference: { type: "boolean", description: "Optional. When true, also captures and analyzes the sidechain-routed reference track in parallel." }
      },
      required: ["start_locator"]
    }
  },
];

function editDistance(a, b) {
  a = (a || "").toLowerCase();
  b = (b || "").toLowerCase();
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const prev = new Array(b.length + 1);
  const curr = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return prev[b.length];
}

function fuzzyResolve(candidate, knownNames) {
  if (!candidate || !knownNames || !knownNames.length) return null;
  const lower = candidate.toLowerCase().trim();
  const lowerNames = knownNames.map(n => (n || "").toLowerCase());
  let i = lowerNames.findIndex(n => n === lower);
  if (i !== -1) return knownNames[i];
  i = lowerNames.findIndex(n => n.includes(lower) || lower.includes(n));
  if (i !== -1) return knownNames[i];
  let best = -1, bestDist = Infinity;
  for (let k = 0; k < lowerNames.length; k++) {
    const d = editDistance(lower, lowerNames[k]);
    if (d < bestDist) { bestDist = d; best = k; }
  }
  if (best === -1) return null;
  const tolerance = Math.max(1, Math.floor(Math.max(lower.length, lowerNames[best].length) * 0.3));
  return bestDist <= tolerance ? knownNames[best] : null;
}

async function trackIndexByName(name) {
  const data = await query("list_tracks");
  if (!data || !data.tracks) return null;
  const names = data.tracks.map(x => x.name || "");
  const resolved = fuzzyResolve(name, names);
  if (!resolved) return null;
  const t = data.tracks.find(x => x.name === resolved);
  return t ? t.index : null;
}

export async function runTool(name, input) {
  switch (name) {
    case "list_tracks":
      return await query("list_tracks");
    case "get_track_devices": {
      const idx = await trackIndexByName(input.track_name);
      if (idx === null) return { error: `No track named "${input.track_name}". Call list_tracks first.` };
      return await query("get_track_devices", idx);
    }
    case "get_device_params": {
      const trackArg = String(input.track || "");
      if (trackArg.toLowerCase() === "master") {
        return await query("get_device_params", "master", input.device_index);
      }
      const idx = await trackIndexByName(trackArg);
      if (idx === null) return { error: `No track named "${trackArg}".` };
      return await query("get_device_params", idx, input.device_index);
    }
    case "get_session_overview":
      return await query("get_session_overview");
    case "get_track_routing": {
      const idx = await trackIndexByName(input.track_name);
      if (idx === null) return { error: `No track named "${input.track_name}".` };
      return await query("get_track_routing", idx);
    }
    case "get_returns":
      return await query("get_returns");
    case "get_memory":
      return await readMemory();
    case "save_memory": {
      const content = input.content || "";
      if (content.length > 200) return { ok: false, error: `memory exceeds 200 chars (got ${content.length}). vibe + intent only — genre, mood, references, target loudness. NO implemented changes, NO measurements, NO track lists.` };
      const lines = content.split("\n");
      for (const line of lines) {
        if (line.length > 40) return { ok: false, error: `line exceeds 40 chars: "${line.slice(0, 30)}...". key terms only.` };
        const wordCount = line.trim().split(/\s+/).length;
        if (wordCount > 5) return { ok: false, error: `line has ${wordCount} words: "${line.slice(0, 30)}...". max 5 words per line.` };
      }
      return await writeMemory(content);
    }
    case "analyze_section": {
      const startName = (input.start_locator || "").toLowerCase().trim();
      const endName = input.end_locator ? input.end_locator.toLowerCase().trim() : null;
      const focusTracks = (input.focus_tracks || []).slice(0, 8);
      const includeReference = !!input.reference;
      if (!startName) return { error: "start_locator is required" };

      const hereMode = startName === "here";
      let startLoc = null, endLoc = null, sec = 0;

      if (hereMode) {
        sec = Math.max(2, Math.min(30, input.seconds || 10));
      } else {
        const locData = await query("get_locators");
        if (!locData || !locData.locators || !locData.locators.length) return { error: "no locators found in the Live set" };
        const sorted = locData.locators.slice().sort((a, b) => a.time_beat - b.time_beat);
        const locNames = sorted.map(l => l.name || "");
        const resolvedStart = fuzzyResolve(input.start_locator, locNames);
        const startIdx = resolvedStart ? sorted.findIndex(l => l.name === resolvedStart) : -1;
        if (startIdx === -1) return { error: `locator '${input.start_locator}' not found. Available: ${locNames.join(", ")}` };
        startLoc = sorted[startIdx];
        if (endName) {
          const resolvedEnd = fuzzyResolve(input.end_locator, locNames);
          endLoc = resolvedEnd ? sorted.find(l => l.name === resolvedEnd) : null;
          if (!endLoc) return { error: `end_locator '${input.end_locator}' not found. Available: ${locNames.join(", ")}` };
          if (endLoc.time_beat <= startLoc.time_beat) return { error: `end_locator at or before start_locator` };
        } else {
          endLoc = sorted[startIdx + 1];
          if (!endLoc) return { error: `no locator after '${input.start_locator}' — specify end_locator explicitly` };
        }
        const overview = await query("get_session_overview");
        const tempo = overview?.tempo;
        if (!tempo) return { error: "could not read tempo" };
        sec = (endLoc.time_beat - startLoc.time_beat) * 60 / tempo;
      }

      const transport = await query("get_transport_state");
      const wasPlaying = transport?.is_playing;
      const priorSongTime = transport?.song_time;
      const priorLoop = transport?.loop;
      const priorLoopStart = transport?.loop_start;
      const priorLoopLength = transport?.loop_length;

      const allTracks = await query("list_tracks");
      const allTrackNames = (allTracks && allTracks.tracks) ? allTracks.tracks.map(t => t.name || "") : [];
      const resolvedFocus = focusTracks.map(n => fuzzyResolve(n, allTrackNames) || n);

      const routingResults = [];
      for (let i = 0; i < resolvedFocus.length; i++) {
        const r = await query("set_focus_routing", i + 1, resolvedFocus[i]);
        routingResults.push({ track: resolvedFocus[i], requested: focusTracks[i], voice: i + 1, ...r });
      }

      try {
        if (priorLoop) await query("set_transport", "loop", 0);
        if (wasPlaying) {
          await query("call_transport", "stop_playing");
          await new Promise(r => setTimeout(r, 50));
        }
        if (!hereMode) {
          await query("jump_to_cue", startLoc.cue_index);
          await new Promise(r => setTimeout(r, 50));
        }
        await query("call_transport", "start_playing");
        await new Promise(r => setTimeout(r, 200));
        await query("start_record");
        await new Promise(r => setTimeout(r, sec * 1000));
        await query("stop_record");
        await query("call_transport", "stop_playing");
        await new Promise(r => setTimeout(r, 100));

        const master = await query("analyze_audio");
        const result = {
          section: hereMode
            ? { mode: "here", duration_seconds: Math.round(sec * 10) / 10 }
            : { start: startLoc.name, end: endLoc.name, duration_seconds: Math.round(sec * 10) / 10, start_beat: startLoc.time_beat, end_beat: endLoc.time_beat },
          master: master
        };

        if (resolvedFocus.length > 0) {
          const focus = await query("analyze_focus");
          result.focus = {};
          if (focus && focus.voices) {
            for (let i = 0; i < resolvedFocus.length; i++) {
              const v = focus.voices[i + 1];
              if (v) result.focus[resolvedFocus[i]] = v;
            }
          }
          if (focus && focus.diagnostic) result.focus.diagnostic = focus.diagnostic;
          result.focus_routing = routingResults;
        }

        if (includeReference) {
          result.reference = await query("analyze_sidechain");
        }

        const meters = await query("get_all_track_meters");
        if (meters && meters.tracks) result.tracks = meters.tracks;

        return result;
      } finally {
        await query("clear_focus_routing");
        if (priorLoopStart !== undefined && priorLoopStart !== null) await query("set_transport", "loop_start", priorLoopStart);
        if (priorLoopLength !== undefined && priorLoopLength !== null) await query("set_transport", "loop_length", priorLoopLength);
        if (priorLoop) await query("set_transport", "loop", 1);
        if (priorSongTime !== undefined && priorSongTime !== null) {
          await query("set_transport", "current_song_time", priorSongTime);
        }
        if (wasPlaying) await query("call_transport", "start_playing");
      }
    }
    default:
      return { error: `Unknown tool: ${name}` };
  }
}
