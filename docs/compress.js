// Restructures verbose tool results into denser shapes for the model context.
// Information-lossless: only drops fields that are noise (sample counts, raw
// 0..1 values shadowed by display_value, redundant metadata) and reshapes
// verbose object-per-entry arrays into parallel-array form.
//
// Per-tool dispatcher. Errors pass through unchanged. Unknown tools pass
// through unchanged so adding a new tool never silently corrupts its output.

export function compressToolResult(name, result) {
  if (!result || typeof result !== "object" || result.error) return result;
  switch (name) {
    case "analyze_section":      return compressAnalyzeSection(result);
    case "list_tracks":          return compressListTracks(result);
    case "get_track_devices":    return compressTrackDevices(result);
    case "get_device_params":    return compressDeviceParams(result);
    case "get_session_overview": return compressSessionOverview(result);
    case "get_track_routing":    return compressTrackRouting(result);
    case "get_returns":          return compressReturns(result);
    default: return result;
  }
}

// ============================================================================
// Helpers
// ============================================================================

function r1(v) { return v == null ? null : Math.round(v * 10) / 10; }

function isSilent(...vals) {
  for (const v of vals) {
    if (v != null && v > -119) return false;
  }
  return true;
}

function dropEmpty(o) {
  if (!o || typeof o !== "object") return o;
  for (const k of Object.keys(o)) {
    const v = o[k];
    if (v === null || v === undefined) delete o[k];
    else if (Array.isArray(v) && v.length === 0) delete o[k];
    else if (typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0) delete o[k];
  }
  return o;
}

// Spectrum: [{hz, m, sm}, ...] → {hz:[...], m:[...], sm:[...]}
// Idempotent: if Max already emits the parallel-array form (current default),
// pass through unchanged. The array-of-objects form was the legacy shape.
function compactSpectrum(spectrum) {
  if (!spectrum) return spectrum;
  if (!Array.isArray(spectrum)) return spectrum; // already parallel-array form
  if (spectrum.length === 0) return spectrum;
  const hz = [], m = [], sm = [];
  for (const b of spectrum) {
    hz.push(b.hz);
    m.push(b.m);
    sm.push(b.sm);
  }
  return { hz, m, sm };
}

// Master / focus time_series both come from Max as {t:[...], l:[...], r:[...]}
// — variable-rate parallel arrays (post-RDP). Pass through unchanged. The
// legacy reshape paths are kept as no-ops for any older capture data.
function compactTimeSeriesObjects(ts) { return ts; }
function compactTimeSeriesTuples(ts) { return ts; }

// Master: peak_left/right/rms_left/right → peak:[L,R], rms:[L,R] (peak is a real
// time-domain sample peak). Focus (isFocus): there is NO true peak — both numbers
// come from the FFT-frame RMS, so they're labeled rms_max:[L,R] (loudest frame)
// and rms_avg:[L,R] (mean frame) to avoid implying a sample peak.
// Mutates the passed object in place. Drops sample_count (noise for Claude).
function compactPackPair(obj, isFocus) {
  const pl = obj.peak_left, pr = obj.peak_right, rl = obj.rms_left, rr = obj.rms_right;
  const maxKey = isFocus ? "rms_max" : "peak";
  const avgKey = isFocus ? "rms_avg" : "rms";
  if (pl || pr) {
    obj[maxKey] = [pl ? r1(pl.max_db) : null, pr ? r1(pr.max_db) : null];
  }
  if (rl || rr) {
    obj[avgKey] = [rl ? r1(rl.mean_db) : null, rr ? r1(rr.mean_db) : null];
  }
  delete obj.peak_left; delete obj.peak_right;
  delete obj.rms_left;  delete obj.rms_right;
  return obj;
}

// LUFS sub-object: keep canonical field names (system prompt references
// integrated_lufs and lra_lu by name). Just drop block-count diagnostics
// which are noise for the model.
function compactLufs(lufs) {
  if (!lufs) return lufs;
  const out = {};
  if (lufs.integrated_lufs != null)    out.integrated_lufs    = lufs.integrated_lufs;
  if (lufs.momentary_max_lufs != null) out.momentary_max_lufs = lufs.momentary_max_lufs;
  if (lufs.short_term_max_lufs != null) out.short_term_max_lufs = lufs.short_term_max_lufs;
  if (lufs.lra_lu != null)             out.lra_lu             = lufs.lra_lu;
  if (lufs.sr_note != null)            out.sr_note            = lufs.sr_note;
  return out;
}

// ============================================================================
// Per-tool compressors
// ============================================================================

function compressAnalyzeSection(r) {
  const out = { section: r.section };

  if (r.master) {
    const m = { ...r.master };
    delete m.fft_meta;
    if (m.spectrum) m.spectrum = compactSpectrum(m.spectrum);
    if (m.time_series) m.time_series = compactTimeSeriesObjects(m.time_series);
    if (m.lufs) m.lufs = compactLufs(m.lufs);
    compactPackPair(m);
    dropEmpty(m);
    out.master = m;
  }

  if (r.focus) {
    const focusOut = {};
    // Drop diagnostic entirely — it's per-voice debug, not mixing data.
    // Expose diagnostic so AI can report what actually happened inside
    // each voice (peak counts, spec frames) — critical for focus tap debugging.
    if (r.focus.diagnostic) out.focus_diagnostic = r.focus.diagnostic;
    for (const key of Object.keys(r.focus)) {
      if (key === "diagnostic") continue;
      const v = { ...r.focus[key] };
      if (v.spectrum) v.spectrum = compactSpectrum(v.spectrum);
      if (v.time_series) v.time_series = compactTimeSeriesTuples(v.time_series);
      compactPackPair(v, true);
      delete v.frames_averaged;
      // Keep transients only when non-empty bands exist.
      if (v.transients && Object.keys(v.transients).length === 0) delete v.transients;
      dropEmpty(v);
      focusOut[key] = v;
    }
    out.focus = focusOut;
  }

  if (r.focus_routing) {
    out.focus_routing = r.focus_routing.map(fr => {
      const o = { track: fr.track, voice: fr.voice };
      if (fr.ok === false || fr.error) o.failed = fr.error || true;
      // Detect captured-but-silent voices: routing succeeded structurally but
      // the tap recorded only noise floor (-120 dB) throughout. Distinct from
      // routing failure — separates "tap broke" from "track was muted /
      // sidechained dead / not playing / wrong source picked".
      if (!o.failed && out.focus && out.focus[fr.track]) {
        const v = out.focus[fr.track];
        if (v.rms_max && v.rms_max[0] != null && v.rms_max[1] != null &&
            v.rms_max[0] <= -119 && v.rms_max[1] <= -119) {
          o.silent = true;
        }
      }
      // Routing identifier/channel diagnostics are dev-only scaffolding — they
      // shipped to the model on every focus query for no decision value. Keep
      // only track/voice/failed/silent (the states the model actually reasons on).
      return o;
    });
  }

  if (r.focus_group_chains) {
    const fgc = {};
    for (const [trackName, gc] of Object.entries(r.focus_group_chains)) {
      fgc[trackName] = {
        parent: gc.parent,
        devices: (gc.devices || []).map(d => {
          const o = { i: d.index, name: d.name, class: d.class_name };
          const { native, class_inferred } = classifyDevice(d.class_name, d.name);
          if (!native) o.native = false;
          o.class_inferred = class_inferred;
          if (d.is_active === false) o.off = true;
          if (d.gain_reduction_db != null) o.gr_db = d.gain_reduction_db;
          // EQ filter corners inline → AI reasons about what the chain filters
          // without a get_device_params round-trip.
          if (d.eq_bands_active) o.eq = d.eq_bands_active;
          return o;
        })
      };
    }
    out.focus_group_chains = fgc;
  }

  if (r.pairwise_masking) {
    // Emit only pairs with ACTUAL masking (≥1 masked band). Complementing,
    // non-overlapping (cooccur-gated), and all-clear pairs are dropped — absence
    // of a pair means no significant masking between those two elements. Pairwise
    // is O(N²) so this is the single biggest cost cut at high voice counts.
    const pm = {};
    for (const k of Object.keys(r.pairwise_masking)) {
      const p = r.pairwise_masking[k];
      if (p && p.masked_bands && p.masked_bands.length > 0) pm[k] = p;
    }
    if (Object.keys(pm).length > 0) out.pairwise_masking = pm;
  }

  if (r.reference) {
    const ref = { ...r.reference };
    delete ref.fft_meta;
    if (ref.spectrum) ref.spectrum = compactSpectrum(ref.spectrum);
    if (ref.lufs) ref.lufs = compactLufs(ref.lufs);
    compactPackPair(ref);
    dropEmpty(ref);
    out.reference = ref;
  }

  if (r.tracks) {
    // Drop silent tracks (no signal in this section) and redundant booleans.
    out.tracks = r.tracks
      .filter(t => !isSilent(t.peak_db_l, t.peak_db_r))
      .map(t => {
        const o = { name: t.name, l: t.peak_db_l, r: t.peak_db_r };
        if (t.mute) o.mute = true;
        if (t.is_group) o.group = true;
        if (t.kind === "return") o.return = true;
        return o;
      });
  }

  return out;
}

function compressListTracks(r) {
  const out = { tempo: r.tempo };
  if (!r.tracks) return out;
  out.tracks = r.tracks.map(t => {
    const o = { i: t.index, name: t.name };
    if (t.is_audio) o.audio = true;
    if (t.is_midi)  o.midi = true;
    if (t.is_group) o.group = true;
    if (t.is_grouped) o.grouped = true;
    if (t.is_frozen) o.frozen = true;
    if (t.arm) o.arm = true;
    if (t.mute) o.mute = true;
    if (t.solo) o.solo = true;
    if (t.volume_display) o.vol = t.volume_display;
    if (t.pan_display && t.pan_display !== "C") o.pan = t.pan_display;
    if (t.sends && t.sends.length) {
      const nz = t.sends.filter(s => s.value != null && s.value > 0.001);
      if (nz.length) {
        o.sends = nz.map(s => ({ to: s.return_name, db: s.display_value }));
      }
    }
    if (t.playing_slot_index != null && t.playing_slot_index >= 0) {
      o.playing_slot = t.playing_slot_index;
    }
    // CPU load contribution per track (Live's performance_impact). Only surface
    // when meaningfully non-zero — most tracks idle near 0 and clutter the list.
    if (t.performance_impact != null && t.performance_impact > 0.01) {
      o.cpu = Math.round(t.performance_impact * 100) / 100;
    }
    // clips only appears when the caller asked for session-view context via
    // with_clips. Already pre-compressed Max-side to {s, n?, b} per non-empty slot.
    if (t.clips && t.clips.length) o.clips = t.clips;
    return o;
  });
  return out;
}

// Native Ableton stock devices identified by class_name. Params have stable,
// documented semantics and the AI can reason about them.
const NATIVE_DEVICE_CLASSES = {
  Eq8: "eq", EqThree: "eq", ChannelEq: "eq",
  Compressor2: "comp", GlueCompressor: "comp", MultibandDynamics: "comp",
  Limiter: "limiter", Limiter2: "limiter",
  Gate: "gate",
  AutoFilter: "filter",
  AutoPan: "tremolo", "Phaser-Flanger": "modulation",
  Saturator: "saturation", Overdrive: "saturation",
  DrumBuss: "saturation", Roar: "saturation", Erosion: "saturation",
  Vinyl: "saturation",
  Reverb: "reverb", Reverb2: "reverb", HybridReverb: "reverb",
  Echo: "delay", FilterDelay: "delay", Delay: "delay",
  Utility: "utility",
  AudioEffectGroupDevice: "rack", InstrumentGroupDevice: "rack"
};

// Stock M4L devices that ship with Live Suite. Their class_name is the generic
// MxDeviceAudioEffect / MxDeviceInstrument / MxDeviceMidiEffect wrapper, NOT a
// unique class — so they have to be identified by device NAME instead. Pedal,
// Amp, Cabinet were rewritten as M4L in recent Live versions; LFO, Envelope
// Follower, Shaper, Spectrum, Tuner ship as M4L too.
const NATIVE_M4L_NAMES = {
  "Amp": "saturation",
  "Cabinet": "saturation",
  "Pedal": "saturation",
  "LFO": "modulation",
  "Envelope Follower": "modulation",
  "Shaper": "modulation",
  "Spectrum": "analyzer",
  "Tuner": "analyzer",
  "Microtuner": "utility",
  "Vocoder": "modulation",
  "Note Echo": "midi_effect",
  "Pitch": "midi_effect",
  "Velocity": "midi_effect",
  "Random": "midi_effect",
  "Scale": "midi_effect",
  "Note Length": "midi_effect",
  "Chord": "midi_effect"
};

// Infer the broad class (eq/comp/limiter/...) of a device. For native devices
// the class_name is authoritative. For non-native (PluginDevice / MxDevice*),
// scan the user-facing name for category keywords. Returns "unknown" only when
// neither path matches — the device exists but its class can't be inferred.
function classifyDevice(className, deviceName) {
  if (className && NATIVE_DEVICE_CLASSES[className]) {
    return { native: true, class_inferred: NATIVE_DEVICE_CLASSES[className] };
  }
  // Stock M4L devices: only match the name table if class_name is actually a
  // M4L wrapper class — otherwise a third-party VST coincidentally named "Amp"
  // would get classified as native.
  const isM4L = className && className.startsWith("MxDevice");
  if (isM4L && deviceName && NATIVE_M4L_NAMES[deviceName]) {
    return { native: true, class_inferred: NATIVE_M4L_NAMES[deviceName] };
  }
  const n = String(deviceName || "").toLowerCase();
  const pairs = [
    ["ducker", "sidechain_comp"], ["sidechain", "sidechain_comp"],
    ["maximizer", "limiter"], ["limiter", "limiter"],
    ["clipper", "clipper"],
    ["multiband", "multiband_comp"],
    ["compressor", "comp"], [" comp", "comp"],
    ["pro-q", "eq"], ["equalizer", "eq"], [" eq", "eq"],
    ["reverb", "reverb"], ["verb", "reverb"],
    ["echo", "delay"], ["delay", "delay"],
    ["saturator", "saturation"], ["saturation", "saturation"],
    ["distortion", "saturation"], ["overdrive", "saturation"], ["fuzz", "saturation"],
    ["chorus", "modulation"], ["flanger", "modulation"], ["phaser", "modulation"],
    ["gate", "gate"],
    ["utility", "utility"], ["analyzer", "analyzer"], ["meter", "analyzer"],
    ["filter", "filter"]
  ];
  for (const [needle, cls] of pairs) {
    if (n.indexOf(needle) !== -1) return { native: false, class_inferred: cls };
  }
  return { native: false, class_inferred: "unknown" };
}

function compressTrackDevices(r) {
  if (!r.devices) return r;
  return {
    devices: r.devices.map(d => {
      const o = { i: d.index, name: d.name, class: d.class_name };
      const { native, class_inferred } = classifyDevice(d.class_name, d.name);
      // Absence of `native` means native (default — saves tokens). Emit only
      // when third-party so the AI sees an explicit opaque-params signal.
      if (!native) o.native = false;
      o.class_inferred = class_inferred;
      if (d.chain_path) o.chain_path = d.chain_path;
      if (d.is_active === false) o.off = true;
      if (d.can_have_chains) o.rack = true;
      if (d.gain_reduction_db != null) o.gr_db = d.gain_reduction_db;
      if (d.eq_bands_active) o.eq = d.eq_bands_active;
      return o;
    })
  };
}

function compressDeviceParams(r) {
  if (!r.params) return r;
  const out = { name: r.name, class: r.class_name };
  // EQ Eight: the 8×~5 per-band params are huge and fully summarized by
  // eq_bands_active — drop them, keep only globals (output gain, mode, scale).
  // Band param names start with a digit ("1 Frequency A", "2 Filter On A", …).
  const src = r.eq_bands_active ? r.params.filter(p => !/^\d+\s/.test(p.name)) : r.params;
  out.params = src.map(p => {
    const o = { i: p.index, name: p.name, val: p.display_value };
    // Drop raw 0..1 value (shadowed by display_value), drop min/max when normalized.
    if (p.min != null && p.max != null && (p.min !== 0 || p.max !== 1)) {
      o.min = p.min;
      o.max = p.max;
    }
    if (p.value_items) o.options = p.value_items;
    if (p.automation_state) o.auto = p.automation_state;
    if (p.is_quantized) o.quantized = true;
    return o;
  });
  if (r.eq_bands_active) out.eq_bands_active = r.eq_bands_active;
  if (r.note) out.note = r.note;
  return out;
}

function compressSessionOverview(r) {
  const out = {};
  for (const k of Object.keys(r)) {
    const v = r[k];
    if (v === null || v === undefined || v === false) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    out[k] = v;
  }
  return out;
}

function compressTrackRouting(r) {
  const out = { name: r.name };
  if (r.output_routing_type) out.out = r.output_routing_type;
  if (r.input_routing_type)  out.in  = r.input_routing_type;
  if (r.monitoring_state != null && r.monitoring_state !== 0) out.monitoring = r.monitoring_state;
  if (r.group_track) out.group = r.group_track;
  if (r.sends && r.sends.length) {
    const nz = r.sends.filter(s => s.value != null && s.value > 0.001);
    if (nz.length) out.sends = nz.map(s => ({ i: s.index, db: s.display_value }));
  }
  return out;
}

function compressReturns(r) {
  if (!r.returns) return r;
  return {
    returns: r.returns.map(ret => {
      const o = { i: ret.index, name: ret.name };
      if (ret.volume_display) o.vol = ret.volume_display;
      if (ret.devices && ret.devices.length) {
        o.devices = ret.devices.map(d => ({
          i: d.index, name: d.name, class: d.class_name
        }));
      }
      return o;
    })
  };
}
