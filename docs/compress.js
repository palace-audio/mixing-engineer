// Restructures verbose tool results into denser shapes for the model context.
// Information-lossless: only drops fields that are noise (sample counts, raw
// 0..1 values shadowed by display_value, redundant metadata) and reshapes
// verbose object-per-entry arrays into parallel-array form.
//
// Per-tool dispatcher. Errors pass through unchanged. Unknown tools pass
// through unchanged so adding a new tool never silently corrupts its output.

export function compressToolResult(name, result) {
  if (!result || typeof result !== "object" || result.error) return result;
  let out;
  switch (name) {
    case "analyze_section":      out = compressAnalyzeSection(result); break;
    case "list_tracks":          out = compressListTracks(result); break;
    case "get_track_devices":    out = compressTrackDevices(result); break;
    case "get_device_params":    out = compressDeviceParams(result); break;
    case "get_session_overview": out = compressSessionOverview(result); break;
    case "get_track_routing":    out = compressTrackRouting(result); break;
    case "get_returns":          out = compressReturns(result); break;
    default:                     out = result;
  }
  return out;
}

// Masking: how many of the worst bands per pair ship in the DEFAULT payload. The rest
// stay in the sessionFindings archive (pull via query_stored_findings, aspect 'masking').
// `masked` is sorted worst-first, so the leading bands still reveal whether the damage
// is one cluster around a frequency or scattered across the spectrum.
const MASK_TOP_BANDS = 5;

// Pair-relevance gate: drop a masking pair whose DEEPEST band is shallower than one loudness-halving
// (~10 dB ≈ ½ perceived loudness, Stevens). The masking-depth window is [-3, -30] in live_query.js
// (-3 = per-band audibility gate, -30 = saturation), so -10 keeps every substantial collision and
// sends only the mild -3..-10 tail to the archive. Not hand-picked — the canonical loudness-halving step.
const MASK_PAIR_DEPTH_DB = -10;
// signal_vs_own_peak_db carries info only when the masked band is within a loudness-halving of the
// signal's OWN spectral peak (its body); below that it's tail — omit (null). Same anchor as above.
const SVOP_BODY_DB = -10;

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

// Ducking dip array-of-objects → parallel arrays.
// trigger[] preserves track-name strings (name encoding runs after this).
// null entries in trigger[] mark unattributed dips.
function compressDucking(ducking) {
  const beat = [], depth_db = [], recovery_beats = [], trigger = [];
  let hasTrigger = false;
  for (const dip of ducking) {
    beat.push(dip.beat);
    depth_db.push(dip.depth_db);
    recovery_beats.push(dip.recovery_beats);
    if (dip.trigger != null) { trigger.push(dip.trigger); hasTrigger = true; }
    else trigger.push(null);
  }
  const out = { beat, depth_db, recovery_beats };
  if (hasTrigger) out.trigger = trigger;
  return out;
}

// Short-symbol name encoding: derive codes from voice names (first uppercase letter
// per space/hyphen-delimited word, leading digits stripped; counter suffix on collision).
// Returns {codes:{name→sym}, decode:{sym→name}}.
function buildNameCodes(names) {
  const codes = {}, decode = {};
  const used = new Set();
  for (const name of names) {
    const words = name.split(/[\s\-_]+/).filter(Boolean)
      .map(w => w.replace(/^\d+/, ''));
    let base = words.map(w => w[0] ? w[0].toUpperCase() : '').join('') || name[0].toUpperCase();
    let sym = base, n = 2;
    while (used.has(sym)) sym = base + (n++);
    used.add(sym);
    codes[name] = sym;
    decode[sym] = name;
  }
  return { codes, decode };
}

// Replace all voice-name occurrences in the compressed payload with their symbols.
// Touches: focus keys, focus_routing track fields, focus_group_chains keys,
// pairwise_masking pair keys, phase_cancellation pair keys, ducking trigger arrays.
function applyNameCodes(out, codes) {
  const sub = k => codes[k] || k;
  const remapKey = (k, sep) => {
    const i = k.indexOf(sep);
    return i < 0 ? k : sub(k.slice(0, i)) + sep + sub(k.slice(i + sep.length));
  };
  if (out.focus) {
    const f = {};
    for (const [k, v] of Object.entries(out.focus)) f[sub(k)] = v;
    out.focus = f;
    for (const v of Object.values(out.focus)) {
      if (v.ducking && v.ducking.trigger) {
        v.ducking.trigger = v.ducking.trigger.map(t => t != null ? sub(t) : null);
      }
    }
  }
  if (out.focus_routing) {
    for (const fr of out.focus_routing) { if (fr.track) fr.track = sub(fr.track); }
  }
  if (out.focus_group_chains) {
    const fgc = {};
    for (const [k, v] of Object.entries(out.focus_group_chains)) fgc[sub(k)] = v;
    out.focus_group_chains = fgc;
  }
  if (out.focus_voice_group) {
    // keys = focus tracks (encode); values = group names (leave as-is)
    const fvg = {};
    for (const [k, v] of Object.entries(out.focus_voice_group)) fvg[sub(k)] = v;
    out.focus_voice_group = fvg;
  }
  if (out.pairwise_masking) {
    const pm = {};
    for (const [k, v] of Object.entries(out.pairwise_masking)) pm[remapKey(k, '→')] = v;
    out.pairwise_masking = pm;
  }
  if (out.phase_cancellation) {
    const pc = {};
    for (const [k, v] of Object.entries(out.phase_cancellation)) pc[remapKey(k, '↔')] = v;
    out.phase_cancellation = pc;
  }
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
// and rms_avg:[L,R] (true RMS across frames) to avoid implying a sample peak.
// The avg slot reads rms_db (power mean = sqrt(mean(x^2))), NOT mean_db (arithmetic
// mean of amplitude), so it's a real RMS — see timeStats/pack in live_query.js.
// Mutates the passed object in place. Drops sample_count (noise for Claude).
function compactPackPair(obj, isFocus) {
  const pl = obj.peak_left, pr = obj.peak_right, rl = obj.rms_left, rr = obj.rms_right;
  const maxKey = isFocus ? "rms_max" : "peak";
  const avgKey = isFocus ? "rms_avg" : "rms";
  if (pl || pr) {
    obj[maxKey] = [pl ? r1(pl.max_db) : null, pr ? r1(pr.max_db) : null];
  }
  if (rl || rr) {
    obj[avgKey] = [rl ? r1(rl.rms_db) : null, rr ? r1(rr.rms_db) : null];
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

// One compact device representation, shared by the per-voice focus chain, the
// parent group chain, and get_track_devices — so the AI sees ONE device shape
// everywhere. Raw listDevices entry → {i, name, class, class_inferred, native?,
// off?, gr_db?, eq?, chain_path?}. Key params ride inline (eq corners, snapshot
// GR) so reading the chain never needs a get_device_params round-trip.
// On/off + chain topology, shared by both device-compaction paths so they never diverge.
// own_on is the device's own switch (null ⇒ unreadable → fall back to is_active). off = the
// device itself is switched off. bypassed = switch ON but the device is effectively inactive
// because an enclosing rack/chain mutes or zones it out (is_active 0) — is_active alone
// conflates the two. chains = the rack's chain topology, incl. empty/dry pass-through chains.
function applyDeviceState(o, d) {
  const own = d.own_on != null ? d.own_on : d.is_active;
  if (own === false) o.off = true;
  else if (d.is_active === false) o.bypassed = true;
  if (d.chains) o.chains = d.chains;
}

function compactDeviceEntry(d) {
  const o = { i: d.index, name: d.name, class: d.class_name };
  const { native, class_inferred } = classifyDevice(d.class_name, d.name);
  if (!native) o.native = false;
  o.class_inferred = class_inferred;
  applyDeviceState(o, d);
  if (d.gain_reduction_db != null) o.gr_db = d.gain_reduction_db;
  if (d.eq_bands_active) o.eq = d.eq_bands_active;
  if (d.chain_path) o.chain_path = d.chain_path;
  return o;
}

function compressAnalyzeSection(r) {
  const out = { section: r.section };

  if (r.master) {
    const m = { ...r.master };
    delete m.fft_meta;
    if (m.spectrum) {
      m.spectrum = compactSpectrum(m.spectrum);
      delete m.spectrum.hz;   // fixed grid in system prompt (hz-master)
      delete m.spectrum.sm;   // archived in __master__ sessionFindings
    }
    delete m.time_series;     // archived in __master__ sessionFindings
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
      // spectrum, time_series, and the per-band image_pos_bands are archived in sessionFindings;
      // pull via query_stored_findings. Default payload keeps only the broadband image_pos scalar.
      delete v.spectrum;
      delete v.time_series;
      delete v.image_pos_bands;
      compactPackPair(v, true);
      delete v.frames_averaged;
      // transients is now a per-band onset-DENSITY scalar map (onsets/beat) — already compact;
      // dropEmpty below removes it when no band fired.
      if (v.ducking && v.ducking.length > 0) v.ducking = compressDucking(v.ducking);
      // The per-voice own device chain is NO LONGER shipped — tools.js stopped fetching it, and we
      // strip it unconditionally here as enforcement. The AI pulls get_track_devices FRESH on demand
      // when a finding implicates a device (lighter payload + signal-first, not device-first, reasoning).
      delete v.devices;
      dropEmpty(v);
      // Parallel-array reshape: resonances
      if (v.resonances && v.resonances.length > 0) {
        const lo = [], hi = [], prom = [], decay = [], ring = [];
        for (const res of v.resonances) {
          lo.push(res.lo_hz);
          hi.push(res.hi_hz);
          prom.push(res.prominence_db);
          decay.push(typeof res.decay_ms === "number" ? res.decay_ms : res.decay_ms === "sustained" ? "s" : null);
          ring.push(typeof res.ring_prominence === "number" ? res.ring_prominence : null);
        }
        v.resonances = { lo, hi, prom, decay };
        if (ring.some(x => x !== null)) v.resonances.ring = ring;
      }
      // Parallel-array reshape: transient_impact
      if (v.transient_impact && typeof v.transient_impact === "object") {
        const BANDS = ["sub", "low_mid", "high_mid", "high"];
        const crest3 = [], crest30 = [], env = [], cons = [];
        for (const band of BANDS) {
          const b = v.transient_impact[band];
          crest3.push(b && b.crest_curve && b.crest_curve["3"] != null ? b.crest_curve["3"] : null);
          crest30.push(b && b.crest_curve && b.crest_curve["30"] != null ? b.crest_curve["30"] : null);
          env.push(b && b.envelope_crest_db != null ? b.envelope_crest_db : null);
          cons.push(b && b.consistency != null ? b.consistency : null);
        }
        v.transient_impact = { crest3, crest30, env };
        if (cons.some(x => x !== null)) v.transient_impact.cons = cons;
      }
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
    // Keyed by GROUP name (deduped upstream): a shared bus appears once, not once per child.
    // focus_voice_group maps each focus track → its immediate parent group so the chain stays
    // attributable per voice.
    const fgc = {};
    for (const [groupName, gc] of Object.entries(r.focus_group_chains)) {
      fgc[groupName] = { devices: (gc.devices || []).map(compactDeviceEntry) };
      if (gc.parent) fgc[groupName].parent = gc.parent;   // enclosing group (tree pointer); absent at root
    }
    out.focus_group_chains = fgc;
    if (r.focus_voice_group) out.focus_voice_group = r.focus_voice_group;
  }

  if (r.pairwise_masking) {
    // Reshape per-pair band data to parallel arrays; drop worst_depth_db (= depth_db[0]
    // after the existing sort — derived). cooccur → ordinal: 2=always/1=sometimes/0=rarely.
    const pm = {};
    for (const k of Object.keys(r.pairwise_masking)) {
      const p = r.pairwise_masking[k];
      if (!p || !p.masked || p.masked.length === 0) continue;
      // Pair-relevance gate: skip pairs whose DEEPEST band (masked is worst-first → masked[0]) is
      // shallower than a loudness-halving. Mild overlap, not an actionable collision — stays in the
      // archive (query_stored_findings 'masking', built from the raw result), so it's still pullable.
      if (p.masked[0].depth_db > MASK_PAIR_DEPTH_DB) continue;
      // Ship only the worst MASK_TOP_BANDS bands (masked is worst-first); the rest are
      // in the archive. n_masked carries the true count so the AI knows how many were dropped.
      const top = p.masked.slice(0, MASK_TOP_BANDS);
      const hz = [], depth_db = [], cooccur = [], signal_vs_own_peak_db = [];
      let anyBody = false;
      for (const b of top) {
        hz.push(b.hz);
        depth_db.push(b.depth_db);
        cooccur.push(b.cooccur === "always" ? 2 : b.cooccur === "sometimes" ? 1 : 0);
        // Only ship signal_vs_own_peak_db for body bands (within a loudness-halving of own peak);
        // tail bands → null, and the whole array is dropped when no band is in the body.
        const sv = (b.signal_vs_own_peak_db != null && b.signal_vs_own_peak_db >= SVOP_BODY_DB)
          ? b.signal_vs_own_peak_db : null;
        if (sv != null) anyBody = true;
        signal_vs_own_peak_db.push(sv);
      }
      const masked = { hz, depth_db, cooccur };
      if (anyBody) masked.signal_vs_own_peak_db = signal_vs_own_peak_db;
      pm[k] = { masked };
      if (p.masked.length > top.length) pm[k].n_masked = p.masked.length;
    }
    if (Object.keys(pm).length > 0) out.pairwise_masking = pm;
  }

  if (r.phase_cancellation) {
    // Between-element phase cancellation. Shape: {bands:[...], delay_samples_est?}.
    // phase_deg archived under __phase__ sessionFindings (pull for clip-nudge: (phase_deg/360)×(1000/hz) ms).
    // Default payload: hz + cancel_db + p_value per band + delay_samples_est when present.
    const pc = {};
    for (const k of Object.keys(r.phase_cancellation)) {
      const p = r.phase_cancellation[k];
      const bands = p && p.bands;
      if (bands && bands.length > 0) {
        const entry = { bands: bands.map(e => ({ hz: e.hz, cancel_db: e.cancel_db, p_value: e.p_value })) };
        if (p.delay_samples_est !== undefined) entry.delay_samples_est = p.delay_samples_est;
        pc[k] = entry;
      }
    }
    if (Object.keys(pc).length > 0) out.phase_cancellation = pc;
  }

  if (r.reference) {
    const ref = { ...r.reference };
    delete ref.fft_meta;
    if (ref.spectrum) {
      ref.spectrum = compactSpectrum(ref.spectrum);
      delete ref.spectrum.hz;  // fixed grid in system prompt (hz-master)
    }
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

  // Encode track names to short symbols; ship decode table as out.codes.
  if (out.focus && Object.keys(out.focus).length > 0) {
    const { codes, decode } = buildNameCodes(Object.keys(out.focus));
    out.codes = decode;
    applyNameCodes(out, codes);
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
  Compressor2: "comp", GlueCompressor: "comp", MultibandDynamics: "multiband_comp",
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
      applyDeviceState(o, d);
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
