import { query } from "./max_bridge.js";

// Legacy key prefix — used only for one-time migration of existing localStorage entries.
const LEGACY_MEMORY_PREFIX = "mixingengineer_memory:";

async function readMemory() {
  const r = await query("read_memory_file");
  if (r && r.noProject) return { content: "", noProject: true, note: "Live set unsaved — save the set first to enable memory." };
  if (r && r.error && !r.content) return { content: "", error: r.error };
  let content = (r && r.content) || "";
  // One-time migration: if the file is empty, check localStorage for a legacy entry
  // and promote it to file storage so the next read finds it in the file.
  if (!content && r && r.project_path) {
    try {
      const legacyKey = LEGACY_MEMORY_PREFIX + r.project_path;
      const legacy = localStorage.getItem(legacyKey) || "";
      if (legacy) {
        content = legacy;
        await query("write_memory_file", encodeURIComponent(legacy));
      }
    } catch (e) {}
  }
  return { content, key: r && (r.mem_file || r.project_path) };
}

async function writeMemory(content) {
  const r = await query("write_memory_file", encodeURIComponent(content));
  if (r && r.noProject) return { ok: false, error: "Live set unsaved — save the set first to enable memory." };
  if (!r) return { ok: false, error: "No response from write_memory_file" };
  return r;
}

// The intent log — a second persistent store next to the .als, separate from memory.
// Same file plumbing as memory (read/modify/write the whole text), different policy:
// memory is the deliberate, curated project identity; this is the running, provisional
// record of what the user wants each element to do ("the mixing intent gathered so far").
async function readIntent() {
  const r = await query("read_intent_file");
  if (r && r.noProject) return { content: "", noProject: true, note: "Live set unsaved — save the set first to enable the intent log." };
  if (r && r.error && !r.content) return { content: "", error: r.error };
  return { content: (r && r.content) || "", key: r && (r.intent_file || r.project_path) };
}

async function writeIntent(content) {
  const r = await query("write_intent_file", encodeURIComponent(content));
  if (r && r.noProject) return { ok: false, error: "Live set unsaved — save the set first to enable the intent log." };
  if (!r) return { ok: false, error: "No response from write_intent_file" };
  return r;
}

export const tools = [
  {
    name: "list_tracks",
    description: "Returns every track in the Live set with name, type (audio/midi/group), mute, solo, volume (raw + dB display), pan, sends, frozen/armed/playing state, plus session tempo. Call this first to orient yourself. Pass with_clips:true to also get per-track clip lists (slot index, name, bars) — needed when forming a Session-View query against specific clips.",
    input_schema: {
      type: "object",
      properties: {
        with_clips: { type: "boolean", description: "Include clips per track (slot index, name, length in bars). Default false — only set true when building a session-view query." }
      },
      required: []
    }
  },
  {
    name: "get_track_devices",
    description: "Returns the device chain for a specific track by name (case-insensitive). Recursively walks into Effect Rack / Instrument Rack chains so nested devices appear flat with chain_path showing the rack/chain location. STRUCTURE ONLY: each device returns its index, name, class, inferred class (native devices only), enabled state (off / bypassed), and a rack flag. To read a device's actual settings (EQ corners, comp threshold/ratio, etc.) call get_device_params once a finding implicates it. Gain reduction is NOT here — it's a per-device time series in the analyze_section capture.",
    input_schema: {
      type: "object",
      properties: { track_name: { type: "string", description: "Track name (fuzzy matched)" } },
      required: ["track_name"]
    }
  },
  {
    name: "get_device_params",
    description: "Returns a device's parameters — each with its index, name, and display value (e.g. '-3.0 dB'); min/max when not normalized; enum option labels and a quantized flag where applicable; and automation state. Also reports the device's enabled state (off / bypassed). CRITICAL: Call this whenever you're about to describe what a device is actually doing — never describe a device's behavior (drive, dry/wet, threshold, frequency, etc.) without first inspecting its parameters.",
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
    name: "get_sample_rate",
    description: "Returns the live DSP sample rate: {sample_rate, expected_sample_rate:48000, matches_expected}. The device's K-weighting/LUFS windows and FFT bin→Hz mapping are calibrated for 48 kHz, so any other rate detunes every frequency and loudness number. Call this BEFORE reporting any frequency or loudness figure (spectrum/masking Hz, centroid, transient bands, LUFS/true-peak); if matches_expected is false, warn the user the numbers are affected and to switch Live to 48 kHz. Cheap; call freely.",
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
    name: "get_arrangement_clips",
    description: "Returns the arrangement clips on a single track: each clip's name, start_beat, end_beat, length_beats, muted flag. Use this BEFORE comparing two elements that may not co-occur in the same window, to find each track's active range and take the intersection. Also use to answer 'when does X enter / leave' and 'is anything playing in this gap' without a capture. Cheap — call freely.",
    input_schema: {
      type: "object",
      properties: { track_name: { type: "string", description: "Track name (fuzzy matched)" } },
      required: ["track_name"]
    }
  },
  {
    name: "get_memory",
    description: "Reads the persistent memory for this project. Memory is the project-specific narrowing context — the genre/intent/references that condition every threshold and verdict to THIS track. Without memory, your training has no project anchor; with memory, all your interpretation is conditioned on the user's stated direction. Returns the saved markdown content, or empty string if no memory yet (in which case qualify verdicts or ask the user once).",
    input_schema: { type: "object", properties: {}, required: [] }
  },
  {
    name: "save_memory",
    description: "Writes/overwrites the persistent memory for this project. Memory is the project-conditioning layer — genre, delivery platform, a reference label or track, intended mood/feel, intentional creative choices — that bridge general mixing knowledge to THIS track and are preserved across sessions. NEVER save: implemented changes, settings applied, measurements (expire, re-queryable from Live), track lists (queryable via list_tracks), debugging notes. Durable intent only; if the only thing you have to save is what was done in this session, don't call save_memory.",
    input_schema: {
      type: "object",
      properties: {
        content: { type: "string", description: "Full markdown content to save. Replaces existing memory entirely." }
      },
      required: ["content"]
    }
  },
  {
    name: "get_intent",
    description: "Reads the intent log for this project — the running record of what the user wants specific elements to do, accumulated across this and previous sessions. This is 'the mixing intent gathered so far': load it before judging deviations, because a trait is a problem only against what its element is meant to do. Distinct from get_memory (the durable project identity): this is the provisional, granular, element-level layer. Returns the log text, or empty string if nothing is noted yet.",
    input_schema: { type: "object", properties: {}, required: [] }
  },
  {
    name: "note_intent",
    description: "Updates the intent log — the working record of what the user wants specific elements to do, captured as they reveal it (e.g. 'hats: keep tight', 'bass: aggressive', 'vocal: up front'). Note a hint the MOMENT it surfaces in conversation, proactively, without waiting to be asked or for confirmation. Read get_intent first, then write back the full revised log: add new intents, supersede ones the user has changed, drop what's stale — keep it terse, one intent per line, element-tagged. Persists across sessions. NOT for: durable project identity (genre / references / delivery target → save_memory), measurements, or applied changes. Promote an intent to save_memory only once it proves stable and project-defining.",
    input_schema: {
      type: "object",
      properties: {
        content: { type: "string", description: "Full updated intent log. Replaces the existing log entirely." }
      },
      required: ["content"]
    }
  },
  {
    name: "ask_user_choice",
    description: "Pause and ask the user to pick from concrete options only when context can't be resolved by qualifying inline. Two cases: (1) spatial — section not named with multiple matches, clip names collide, track or locator fuzzy-match is low-confidence; (2) intent fork — intended role or delivery target, only when the two readings prescribe opposite actions. For intent-fork asks, always include one option labeled 'remember for this project'; when the user picks it, call save_memory with the resolved intent so the fork closes permanently. Pre-filter to 2–4 options; max 6. If you cannot narrow to under 6, prefer a text question.",
    input_schema: {
      type: "object",
      properties: {
        question: { type: "string", description: "Short, direct question. One sentence." },
        options: {
          type: "array",
          minItems: 2,
          maxItems: 6,
          items: {
            type: "object",
            properties: {
              label: { type: "string", description: "Short label shown on the button (≤30 chars)." },
              description: { type: "string", description: "Optional one-line hint about what choosing this means." }
            },
            required: ["label"]
          }
        }
      },
      required: ["question", "options"]
    }
  },
  {
    name: "analyze_section",
    description: "Single audio entry point for both Arrangement and Session views. Captures audio for a section, then analyzes it. Active launch: pauses transport, jumps/fires the target, captures, stops. Optionally captures up to 8 focus tracks in parallel via routed taps (no soloing, no transport disruption). Optionally captures the sidechain-routed reference. Arrangement starter = start_locator OR start_beat; Session starter = start_scene. If NO section is given at all, defaults to 8 bars from the arrangement start (beat 0). Default capture length when no end is given is 8 bars. A vague section reference the user named but you can't resolve ('the loud part', colliding names) → ask via ask_user_choice; nothing named → just use the default.",
    input_schema: {
      type: "object",
      properties: {
        start_locator: { type: "string", description: "Arrangement-view starter. Locator name (case-sensitive exact match preferred, else fuzzy). If two locators share a name it is ambiguous — use start_beat instead." },
        start_beat: { type: "number", description: "Arrangement-view starter by absolute beat (0 = arrangement start). Use to start at an exact position or to disambiguate duplicate locator names (read each one's beat from get_session_overview/locators). Alternative to start_locator." },
        end_locator: { type: "string", description: "Arrangement-view only. Optional locator name marking the end. If omitted, capture length defaults to 8 bars from the start (NOT the next locator)." },
        start_scene: { description: "Session-view starter. Scene name (fuzzy matched) OR 1-based integer scene index. Top scene = 1.", oneOf: [{ type: "string" }, { type: "integer" }] },
        focus_clips: {
          type: "array",
          description: "Session-view only. Fire specific clips by track + 1-based slot index instead of the whole scene. Up to 8.",
          items: {
            type: "object",
            properties: {
              track: { type: "string" },
              slot: { type: "integer", description: "1-based slot index from list_tracks(with_clips:true)" }
            },
            required: ["track", "slot"]
          }
        },
        bars: { type: "number", description: "Optional explicit capture length in bars. Overrides the default (Arrangement: 8 bars, or the start→end_locator span if end_locator given; Session: longest clip in the scene). Long captures are allowed." },
        beats: { type: "number", description: "Optional explicit capture length in beats. Mutually exclusive with bars." },
        focus_tracks: { type: "array", items: { type: "string" }, description: "Optional. Up to 8 track names (fuzzy matched) to analyze in parallel." },
        reference: { type: "boolean", description: "Optional. Also capture the sidechain-routed reference track." }
      },
      required: []
    }
  },
  {
    name: "query_stored_findings",
    description: "Session archive lookup. After every analyze_section the device archives synthesized per-voice findings (benign + malign, including what the main response omitted) AND raw data stripped from the default payload (spectrum, time_series, phase_deg, per-band image_pos_bands — image_pos_bands under 'levels'). Call with no args for the index. aspect= filters: all / masking / transients / levels / spectrum / time_series. Two special voice keys always present after a focus capture: '__master__' returns archived master spectrum (sm + full {hz,m,sm}) and time_series; '__phase__' returns full phase_cancellation WITH phase_deg — use it for clip-nudge math: (phase_deg/360) × (1000/hz_center) ms. Batch form: pass queries=[{voice?,aspect?}] to fetch multiple voice/aspect pairs in one call; returns {\"voice:aspect\": result}. Single-call form (voice+aspect) also kept. Cache wiped each new capture; no_data → re-run analyze_section.",
    input_schema: {
      type: "object",
      properties: {
        voice: { type: "string", description: "Track name or '__master__' or '__phase__'. Omit to return the index." },
        aspect: { type: "string", enum: ["all", "masking", "transients", "levels", "spectrum", "time_series"], description: "Return only a sub-section. Default: all." },
        queries: { type: "array", items: { type: "object", properties: { voice: { type: "string" }, aspect: { type: "string", enum: ["all", "masking", "transients", "levels", "spectrum", "time_series"] } }, required: [] }, description: "Batch form: array of {voice?, aspect?} pairs. Returns object keyed by 'voice:aspect'." }
      },
      required: []
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
  const cand = String(candidate).trim();
  // Case-SENSITIVE exact match first — distinguishes "DROP" from "drop" when both
  // exist (lowercasing first would collapse them and always pick whichever sorts first).
  let i = knownNames.findIndex(n => n === cand);
  if (i !== -1) return knownNames[i];
  const lower = cand.toLowerCase();
  const lowerNames = knownNames.map(n => (n || "").toLowerCase());
  i = lowerNames.findIndex(n => n === lower);
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
      return await query("list_tracks", input.with_clips ? 1 : 0);
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
    case "get_sample_rate":
      return await query("get_sample_rate");
    case "get_track_routing": {
      const idx = await trackIndexByName(input.track_name);
      if (idx === null) return { error: `No track named "${input.track_name}".` };
      return await query("get_track_routing", idx);
    }
    case "get_returns":
      return await query("get_returns");
    case "get_arrangement_clips": {
      const idx = await trackIndexByName(input.track_name);
      if (idx === null) return { error: `No track named "${input.track_name}". Call list_tracks first.` };
      return await query("get_arrangement_clips", idx);
    }
    case "get_memory":
      return await readMemory();
    case "save_memory": {
      const content = input.content || "";
      return await writeMemory(content);
    }
    case "get_intent":
      return await readIntent();
    case "note_intent": {
      const content = input.content || "";
      return await writeIntent(content);
    }
    case "analyze_section": {
      // Mode resolution. Arrangement starter = start_locator OR start_beat; Session
      // starter = start_scene / focus_clips. If nothing concrete is named, default to
      // 8 bars from the arrangement start (beat 0) instead of erroring.
      const hasLocator = input.start_locator != null && String(input.start_locator).trim().length > 0;
      const hasStartBeat = input.start_beat != null && !isNaN(Number(input.start_beat));
      const hasScene = input.start_scene != null && String(input.start_scene).trim().length > 0;
      const focusClipsArg = Array.isArray(input.focus_clips) ? input.focus_clips.slice(0, 8) : [];
      const hasFocusClips = focusClipsArg.length > 0;
      if ((hasLocator || hasStartBeat) && hasScene) {
        return { error: "pass an Arrangement starter (start_locator/start_beat) OR start_scene, not both" };
      }

      const focusTracks = (input.focus_tracks || []).slice(0, 8);
      const includeReference = !!input.reference;
      const sessionMode = hasScene || hasFocusClips;
      // Arrangement is the default whenever Session wasn't requested.
      const arrangementMode = !sessionMode;
      const DEFAULT_CAPTURE_BARS = 8;

      // Read tempo + signature once — both modes need them for bars/beats math.
      const overview = await query("get_session_overview");
      const tempo = overview?.tempo;
      const sigNum = overview?.signature_numerator || 4;
      if (!tempo) return { error: "could not read tempo" };

      // Length override: bars/beats are mutually exclusive. Convert to seconds.
      let overrideSec = null;
      if (input.bars != null && input.beats != null) {
        return { error: "pass bars OR beats, not both" };
      }
      if (input.bars != null) overrideSec = Number(input.bars) * sigNum * 60 / tempo;
      else if (input.beats != null) overrideSec = Number(input.beats) * 60 / tempo;

      // Default capture length = 8 bars. Explicit bars/beats or an end_locator override it;
      // there is no infinite default (a missing end no longer records until the user stops).
      const defaultSec = DEFAULT_CAPTURE_BARS * sigNum * 60 / tempo;

      // Arrangement start descriptor: the beat to seek to, an optional cue index (a named
      // locator can use the cheaper exact jump_to_cue), and a human label for the result.
      let startBeatVal = 0, startCueIndex = null, startLabel = null, endLoc = null, sec = 0;
      let sceneIdx = -1, sceneLabel = null;
      let resolvedFocusClips = [];

      if (arrangementMode) {
        if (hasLocator) {
          const locData = await query("get_locators");
          if (!locData || !locData.locators || !locData.locators.length) return { error: "no locators found — pass start_beat instead" };
          const sorted = locData.locators.slice().sort((a, b) => a.time_beat - b.time_beat);
          const locNames = sorted.map(l => l.name || "");
          const resolvedStart = fuzzyResolve(input.start_locator, locNames);
          // Duplicate-name guard: if the resolved name matches more than one locator it is
          // genuinely ambiguous (e.g. two "DROP"s) — surface their beats so the AI re-calls with start_beat.
          const matches = resolvedStart ? sorted.filter(l => l.name === resolvedStart) : [];
          if (matches.length === 0) return { error: `locator '${input.start_locator}' not found. Available: ${locNames.join(", ")}` };
          if (matches.length > 1) {
            const positions = matches.map(m => `beat ${m.time_beat}`).join(", ");
            return { error: `locator '${resolvedStart}' is ambiguous — ${matches.length} locators share that name (at ${positions}). Pass start_beat to pick one.` };
          }
          startBeatVal = matches[0].time_beat;
          startCueIndex = matches[0].cue_index;
          startLabel = matches[0].name;
          if (input.end_locator) {
            const resolvedEnd = fuzzyResolve(input.end_locator, locNames);
            endLoc = resolvedEnd ? sorted.find(l => l.name === resolvedEnd && l.time_beat > startBeatVal) : null;
            if (!endLoc) return { error: `end_locator '${input.end_locator}' not found after the start. Available: ${locNames.join(", ")}` };
            const span = (endLoc.time_beat - startBeatVal) * 60 / tempo;
            sec = overrideSec != null ? Math.min(span, overrideSec) : span;
          } else {
            // No end → default 8 bars from the start (NOT span-to-next-locator, NOT infinite).
            sec = overrideSec != null ? overrideSec : defaultSec;
          }
        } else {
          // Explicit start_beat, or nothing named → 8 bars from the arrangement start (beat 0).
          startBeatVal = hasStartBeat ? Number(input.start_beat) : 0;
          startCueIndex = null;
          startLabel = hasStartBeat ? `beat ${startBeatVal}` : "arrangement start";
          sec = overrideSec != null ? overrideSec : defaultSec;
        }
      } else if (hasScene) {
        // Resolve scene by name OR 1-based integer. Live's API is 0-based,
        // so we subtract 1 after resolution.
        const sceneArg = input.start_scene;
        const allScenes = await query("resolve_scene");
        const total = allScenes?.scene_count || 0;
        if (typeof sceneArg === "number" || /^\d+$/.test(String(sceneArg).trim())) {
          const oneBased = Number(sceneArg);
          if (oneBased < 1 || oneBased > total) return { error: `scene index ${oneBased} out of range (1..${total})` };
          sceneIdx = oneBased - 1;
          sceneLabel = String(oneBased);
        } else {
          const namedNames = (allScenes?.named_scenes || []).map(s => s.n);
          const resolved = fuzzyResolve(String(sceneArg), namedNames);
          if (!resolved) return { error: `scene '${sceneArg}' not found. Named scenes: ${namedNames.join(", ") || "(none — use scene index 1..N)"}` };
          const match = allScenes.named_scenes.find(s => s.n === resolved);
          sceneIdx = match.i;
          sceneLabel = resolved;
        }
        // Default duration = longest clip in the scene (in beats → seconds).
        // If overrideSec given, use that instead.
        const info = await query("get_scene_info", sceneIdx);
        if (!info?.has_clips) return { error: `scene ${sceneLabel} has no clips` };
        const sceneSec = info.max_length_beats * 60 / tempo;
        sec = overrideSec != null ? overrideSec : sceneSec;
      } else if (hasFocusClips) {
        // focus_clips drives the section: no scene fire, just per-clip fires.
        // Duration MUST be explicit via bars/beats when there's no scene.
        if (overrideSec == null) return { error: "focus_clips without a scene needs an explicit bars or beats" };
        sec = overrideSec;
      }

      // Resolve focus_clips track names → indices, and validate slot has a clip.
      const allTracksRes = await query("list_tracks", 0);
      const allTrackNames = (allTracksRes && allTracksRes.tracks) ? allTracksRes.tracks.map(t => t.name || "") : [];

      if (hasFocusClips) {
        for (const fc of focusClipsArg) {
          const trackResolved = fuzzyResolve(fc.track, allTrackNames);
          const trackIdx = trackResolved ? allTrackNames.indexOf(trackResolved) : -1;
          if (trackIdx === -1) return { error: `focus_clips: track '${fc.track}' not found` };
          if (fc.slot == null || fc.slot < 1) return { error: `focus_clips: invalid slot ${fc.slot} on track '${fc.track}'` };
          resolvedFocusClips.push({ trackIdx, slotIdx: fc.slot - 1, track: trackResolved, slot: fc.slot });
        }
      }

      const focusTracksFinal = focusTracks.slice();
      // When focus_clips is used, fold its tracks into focus_tracks so the AI
      // gets per-voice analysis on the clips being fired.
      for (const rc of resolvedFocusClips) {
        if (focusTracksFinal.indexOf(rc.track) === -1) focusTracksFinal.push(rc.track);
      }
      const resolvedFocus = focusTracksFinal.slice(0, 8).map(n => fuzzyResolve(n, allTrackNames) || n);

      const routingResults = [];
      for (let i = 0; i < resolvedFocus.length; i++) {
        const r = await query("set_focus_routing", i + 1, resolvedFocus[i]);
        routingResults.push({ track: resolvedFocus[i], voice: i + 1, ...r });
      }

      try {
        // Pre-pause: stop transport BEFORE jumping/firing so the capture
        // doesn't include whatever was playing before. Per user direction we
        // do NOT restore prior transport state in finally — just stop and end.
        // Arrangement captures touch ZERO session API. (stop_all_clips puts
        // tracks into session-override mode as a side effect, which then
        // greys out arrangement clips — only call it in session mode, where
        // we deliberately entered that state by firing.)
        await query("call_transport", "stop_playing");
        await new Promise(r => setTimeout(r, 80));

        if (arrangementMode) {
          // Named locator → exact jump_to_cue; otherwise seek the playhead to the beat.
          if (startCueIndex != null) await query("jump_to_cue", startCueIndex);
          else await query("set_transport", "current_song_time", startBeatVal);
          await new Promise(r => setTimeout(r, 50));
        } else if (hasScene) {
          await query("fire_scene", sceneIdx);
          await new Promise(r => setTimeout(r, 30));
        } else if (hasFocusClips) {
          for (const rc of resolvedFocusClips) {
            await query("fire_clip", rc.trackIdx, rc.slotIdx);
          }
          await new Promise(r => setTimeout(r, 30));
        }

        await query("call_transport", "start_playing");
        await new Promise(r => setTimeout(r, 200));
        const ctxLabel = arrangementMode ? startLabel : (hasScene ? sceneLabel : "clips");
        await query("start_record", ctxLabel);
        // Poll transport every 500ms instead of one big sleep. If the user
        // stops playback mid-capture, abort immediately rather than burning
        // the full capture window and sending a partial result to the API.
        const captureStart = Date.now();
        const captureMs = sec * 1000;
        let cancelled = false;
        while (Date.now() - captureStart < captureMs) {
          await new Promise(r => setTimeout(r, 500));
          const transportState = await query("get_transport_state");
          if (!transportState.is_playing) {
            cancelled = true;
            break;
          }
        }
        await query("stop_record");
        if (cancelled) {
          // The user stopped transport mid-capture. Report it and stop — do NOT
          // restart the capture (no "re-run" hint; auto-restarting on stop was a bug).
          return { status: "capture_stopped", message: "Transport was stopped during recording, so the capture is stopped. Nothing was analyzed. Tell the user the capture is stopped; do not re-run unless they ask." };
        }
        await query("call_transport", "stop_playing");
        // Session-mode captures touched session state (fire_scene / fire_clip
        // set back_to_arranger=1 on Song + tracks). Clean it up so the user's
        // next Arrangement playback follows the arrangement.
        // Arrangement captures never touch session state — they behave exactly
        // as they did before the session-view feature was added.
        if (sessionMode) {
          await query("stop_all_clips");
          await query("session_to_arrangement");
        }
        await new Promise(r => setTimeout(r, 100));

        const master = await query("analyze_audio");
        // Internal FFT→dBFS calibration offset — consume it here and strip it so
        // it never reaches the model. Passed to analyze_focus to calibrate focus
        // voice levels/spectra onto the master's dBFS scale.
        const fftCalDb = (master && typeof master.fft_calibration_db === "number") ? master.fft_calibration_db : 0;
        if (master) delete master.fft_calibration_db;

        let sectionInfo;
        if (arrangementMode) {
          sectionInfo = {
            start: startLabel,
            duration_seconds: Math.round(sec * 10) / 10,
            start_beat: startBeatVal,
            ...(endLoc ? { end: endLoc.name, end_beat: endLoc.time_beat } : {})
          };
        } else if (hasScene) {
          sectionInfo = { mode: "scene", scene: sceneLabel, scene_index: sceneIdx + 1, duration_seconds: Math.round(sec * 10) / 10 };
        } else {
          sectionInfo = { mode: "clips", clips: resolvedFocusClips.map(c => ({ track: c.track, slot: c.slot })), duration_seconds: Math.round(sec * 10) / 10 };
        }
        const result = { section: sectionInfo, master: master };

        if (resolvedFocus.length > 0) {
          // Pass master LUFS as loudness anchor for masking signal floor.
          const lufsAnchor = master?.lufs?.integrated_lufs ?? -14;
          const focus = await query("analyze_focus", lufsAnchor, fftCalDb);
          result.focus = {};
          // Attach the per-voice diagnostic (active_voices, spec_frames,
          // time_series_points). compress.js reads r.focus.diagnostic and
          // surfaces it as focus_diagnostic. Without this line it was dropped,
          // making every focus-tap diagnostic blind.
          if (focus && focus.diagnostic) result.focus.diagnostic = focus.diagnostic;
          // Fresh per-capture mute/solo state — attached ONLY when abnormal (muted / muted-by-solo),
          // so a normal track adds zero bytes. Reuses the list_tracks already fetched above: no new
          // query, no payload growth in the common case. Grounds the model on THIS capture's state
          // instead of a stale earlier list_tracks (B5).
          const anySolo = (allTracksRes?.tracks || []).some(t => t.solo);
          if (focus && focus.voices) {
            for (let i = 0; i < resolvedFocus.length; i++) {
              const v = focus.voices[i + 1];
              if (!v) continue;
              const trackIdx = allTrackNames.indexOf(resolvedFocus[i]);
              const tEntry = (allTracksRes?.tracks || [])[trackIdx];
              if (tEntry) {
                if (tEntry.mute) v.track_state = "muted";
                else if (anySolo && !tEntry.solo) v.track_state = "muted_via_solo";
              }
              // The focus tap is post-this-track's-own-devices (pre-group-chain), so that
              // chain is what shaped the signal. It is NOT folded into the capture anymore:
              // shipping it per voice on every capture cost tokens and fed device-first
              // reasoning. The AI pulls get_track_devices FRESH (live, current) only when a
              // finding implicates a device — same on-demand discipline as get_device_params.
              // (The parent group chain stays in focus_group_chains — post-tap, harder to
              // derive, and a caveat the AI can't reconstruct from a later query.)
              result.focus[resolvedFocus[i]] = v;
            }
          }
          if (focus && focus.pairwise_masking) result.pairwise_masking = focus.pairwise_masking;
          if (focus && focus.phase_cancellation) result.phase_cancellation = focus.phase_cancellation;
          result.focus_routing = routingResults;

          // For grouped focus tracks, auto-fetch parent group device chain.
          // The focus tap captures child Post Mixer (pre-group-chain); exposing
          // the group devices lets the AI caveat its spectral analysis correctly.
          // Walk each focused child UP its bus tree to the root. Each unique group is captured ONCE
          // (deduped) with a `parent` pointer to its enclosing group, so the map is the full
          // child→…→master tree, not just one level — a grandparent bus (e.g. a CLIP group above
          // KICKBASS) is no longer invisible. getGroupChain(X) returns X's immediate parent group +
          // that parent's devices ("a group is also a track"), so feeding the parent back in climbs one
          // level; stop when a node has no parent group, or when the parent is already mapped (dedup).
          const groupChains = {};   // group name → { devices, parent? }
          const voiceGroup = {};    // focus track → its immediate parent group
          for (const trackName of resolvedFocus) {
            let node = trackName, isVoice = true;
            while (true) {
              const gc = await query("get_group_chain", node);
              if (!gc || !gc.grouped || !gc.parent) break;   // node is top-level (directly under master)
              const parent = gc.parent;
              if (isVoice) voiceGroup[trackName] = parent;
              else if (groupChains[node]) groupChains[node].parent = parent;  // node is a group → record its parent
              const seen = !!groupChains[parent];
              if (!seen) groupChains[parent] = { devices: gc.devices || [] };
              node = parent;
              isVoice = false;
              if (seen) break;   // parent + its ancestry already mapped — stop climbing
            }
          }
          if (Object.keys(groupChains).length > 0) {
            result.focus_group_chains = groupChains;
            result.focus_voice_group = voiceGroup;
          }
        }

        if (includeReference) {
          result.reference = await query("analyze_sidechain");
        }

        const meters = await query("get_all_track_meters");
        if (meters && meters.tracks) result.tracks = meters.tracks;

        return result;
      } finally {
        await query("clear_focus_routing");
        // Belt-and-suspenders for session-mode only: if the capture threw
        // before reaching the normal cleanup, do it here too. Idempotent.
        if (sessionMode) {
          await query("stop_all_clips");
          await query("session_to_arrangement");
        }
      }
    }
    case "query_stored_findings": {
      if (input.queries && Array.isArray(input.queries)) {
        const results = {};
        for (const q of input.queries) {
          results[`${q.voice || "index"}:${q.aspect || "all"}`] =
            await query("query_stored_findings", q.voice || null, q.aspect || "all");
        }
        return results;
      }
      return await query("query_stored_findings", input.voice || null, input.aspect || "all");
    }
    default:
      return { error: `Unknown tool: ${name}` };
  }
}
