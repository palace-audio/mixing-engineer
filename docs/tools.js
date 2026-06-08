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
    description: "Writes/overwrites the persistent memory for this project. Memory is the project-conditioning layer — the genre/intent/references that bridge general mixing knowledge to THIS track. Save: genre, intended mood/feel, reference tracks, target loudness/dynamics goal, intentional creative choices the user wants preserved across sessions. NEVER save: implemented changes, settings applied, measurements (expire, re-queryable from Live), track lists (queryable via list_tracks), debugging notes. If the only thing you have to save is what was done in this session, don't call save_memory. HARD LIMITS: 200 chars max, 40 chars per line, 5 words per line. Comma-separated terms under one-line section headers.",
    input_schema: {
      type: "object",
      properties: {
        content: { type: "string", description: "Full markdown content to save. Replaces existing memory entirely." }
      },
      required: ["content"]
    }
  },
  {
    name: "ask_user_choice",
    description: "Pause and ask the user to pick from concrete options when a verdict would otherwise depend on a silent assumption. Use when: user didn't name the section but multiple plausible ones exist, clip names collide within a track, the requested target is ambiguous (\"the loud part\"), or genre context is missing and a verdict would default to a convention. Pre-filter options to ones that semantically match the user's intent — show 2-4 options, max 6. If you cannot narrow to under 6, prefer a text question over a long picker. Never silently pick a convention; either ask via this tool or qualify your verdict in the response.",
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
    description: "Single audio entry point for both Arrangement and Session views. Captures audio for a concrete section, then analyzes it. Active launch: pauses transport, jumps/fires the target, captures, stops. Optionally captures up to 8 focus tracks in parallel via routed taps (no soloing, no transport disruption). Optionally captures the sidechain-routed reference. Concrete starters only — pick exactly ONE of start_locator (Arrangement) OR start_scene (Session). No 'here' shortcut: if the user is ambiguous about which section, ask them via ask_user_choice instead of guessing.",
    input_schema: {
      type: "object",
      properties: {
        start_locator: { type: "string", description: "Arrangement-view starter. Locator name (fuzzy matched)." },
        end_locator: { type: "string", description: "Arrangement-view only. Optional locator name marking the end; if omitted, the next locator after start_locator is used." },
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
        bars: { type: "number", description: "Optional explicit capture length in bars. Overrides the default (Arrangement: span between locators; Session: longest clip in the scene)." },
        beats: { type: "number", description: "Optional explicit capture length in beats. Mutually exclusive with bars." },
        focus_tracks: { type: "array", items: { type: "string" }, description: "Optional. Up to 8 track names (fuzzy matched) to analyze in parallel." },
        reference: { type: "boolean", description: "Optional. Also capture the sidechain-routed reference track." }
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
      if (content.length > 200) return { ok: false, error: `memory exceeds 200 chars (got ${content.length}). vibe + intent only — genre, mood, references, target loudness. NO implemented changes, NO measurements, NO track lists.` };
      const lines = content.split("\n");
      for (const line of lines) {
        if (line.length > 40) return { ok: false, error: `line exceeds 40 chars: "${line.slice(0, 8)}...". key terms only.` };
        const wordCount = line.trim().split(/\s+/).length;
        if (wordCount > 5) return { ok: false, error: `line has ${wordCount} words: "${line.slice(0, 8)}...". max 5 words per line.` };
      }
      return await writeMemory(content);
    }
    case "analyze_section": {
      // Mode resolution: exactly one of start_locator (Arrangement) or
      // start_scene (Session) is required. focus_clips implies Session mode and
      // overrides whatever start_scene resolves the section to.
      const hasLocator = input.start_locator != null && String(input.start_locator).trim().length > 0;
      const hasScene = input.start_scene != null && String(input.start_scene).trim().length > 0;
      const focusClipsArg = Array.isArray(input.focus_clips) ? input.focus_clips.slice(0, 8) : [];
      const hasFocusClips = focusClipsArg.length > 0;
      if (!hasLocator && !hasScene && !hasFocusClips) {
        return { error: "ambiguous section — pass start_locator (Arrangement) OR start_scene (Session) OR focus_clips. Use ask_user_choice if the user wasn't specific." };
      }
      if (hasLocator && hasScene) {
        return { error: "pass start_locator OR start_scene, not both" };
      }

      const focusTracks = (input.focus_tracks || []).slice(0, 8);
      const includeReference = !!input.reference;
      const sessionMode = hasScene || hasFocusClips;

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

      let startLoc = null, endLoc = null, sec = 0;
      let sceneIdx = -1, sceneLabel = null;
      let resolvedFocusClips = [];

      if (hasLocator) {
        const locData = await query("get_locators");
        if (!locData || !locData.locators || !locData.locators.length) return { error: "no locators found in the Live set" };
        const sorted = locData.locators.slice().sort((a, b) => a.time_beat - b.time_beat);
        const locNames = sorted.map(l => l.name || "");
        const resolvedStart = fuzzyResolve(input.start_locator, locNames);
        const startIdx = resolvedStart ? sorted.findIndex(l => l.name === resolvedStart) : -1;
        if (startIdx === -1) return { error: `locator '${input.start_locator}' not found. Available: ${locNames.join(", ")}` };
        startLoc = sorted[startIdx];
        if (input.end_locator) {
          const resolvedEnd = fuzzyResolve(input.end_locator, locNames);
          endLoc = resolvedEnd ? sorted.find(l => l.name === resolvedEnd) : null;
          if (!endLoc) return { error: `end_locator '${input.end_locator}' not found. Available: ${locNames.join(", ")}` };
          if (endLoc.time_beat <= startLoc.time_beat) return { error: `end_locator at or before start_locator` };
        } else if (overrideSec == null && focusTracks.length === 0) {
          // Master-only: span to next locator (longer captures fine, no per-voice buffers).
          endLoc = sorted[startIdx + 1];
          if (!endLoc) return { error: `no locator after '${input.start_locator}' — pass end_locator OR bars/beats explicitly` };
        }
        // Focus captures default to 8 bars max — per-voice buffer accumulation
        // degrades on long sections. User can override with bars= or beats=.
        // Master-only captures use the full locator span.
        const focusCapSec = focusTracks.length > 0 ? 8 * sigNum * 60 / tempo : Infinity;
        const locatorSpan = endLoc ? (endLoc.time_beat - startLoc.time_beat) * 60 / tempo : focusCapSec;
        sec = overrideSec != null ? Math.min(locatorSpan, overrideSec) : Math.min(locatorSpan, focusCapSec);
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

        if (hasLocator) {
          await query("jump_to_cue", startLoc.cue_index);
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
        await query("start_record");
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
          return { error: "capture_cancelled", message: "Transport stopped before capture completed. Re-run when ready." };
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
        if (hasLocator) {
          sectionInfo = {
            start: startLoc.name,
            duration_seconds: Math.round(sec * 10) / 10,
            start_beat: startLoc.time_beat,
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
          if (focus && focus.voices) {
            for (let i = 0; i < resolvedFocus.length; i++) {
              const v = focus.voices[i + 1];
              if (v) result.focus[resolvedFocus[i]] = v;
            }
          }
          if (focus && focus.pairwise_masking) result.pairwise_masking = focus.pairwise_masking;
          if (focus && focus.phase_cancellation) result.phase_cancellation = focus.phase_cancellation;
          result.focus_routing = routingResults;

          // For grouped focus tracks, auto-fetch parent group device chain.
          // The focus tap captures child Post Mixer (pre-group-chain); exposing
          // the group devices lets the AI caveat its spectral analysis correctly.
          const groupChains = {};
          for (const trackName of resolvedFocus) {
            const gc = await query("get_group_chain", trackName);
            if (gc && gc.grouped && gc.parent) {
              groupChains[trackName] = { parent: gc.parent, devices: gc.devices || [] };
            }
          }
          if (Object.keys(groupChains).length > 0) result.focus_group_chains = groupChains;
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
    default:
      return { error: `Unknown tool: ${name}` };
  }
}
