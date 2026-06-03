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

// Master time_series: [{t, l, r}, ...] → {t0, dt, l:[...], r:[...]}
// Idempotent: if already in parallel-array form, pass through.
function compactTimeSeriesObjects(ts) {
  if (!ts) return ts;
  if (!Array.isArray(ts)) return ts; // already parallel-array form
  if (ts.length === 0) return ts;
  const l = [], r = [];
  for (const f of ts) { l.push(f.l); r.push(f.r); }
  return { t0: ts[0].t, dt: 0.1, l, r };
}

// Focus time_series: [[t, l, r], ...] → {t0, dt, l:[...], r:[...]}
// Idempotent: if already in parallel-array form, pass through.
function compactTimeSeriesTuples(ts) {
  if (!ts) return ts;
  if (!Array.isArray(ts)) return ts; // already parallel-array form
  if (ts.length === 0) return ts;
  const l = [], r = [];
  for (const f of ts) { l.push(f[1]); r.push(f[2]); }
  return { t0: ts[0][0], dt: 0.1, l, r };
}

// peak_left/peak_right/rms_left/rms_right → peak:[L,R], rms:[L,R]
// Mutates the passed object in place. Drops sample_count (noise for Claude).
function compactPackPair(obj) {
  const pl = obj.peak_left, pr = obj.peak_right, rl = obj.rms_left, rr = obj.rms_right;
  if (pl || pr) {
    obj.peak = [pl ? r1(pl.max_db) : null, pr ? r1(pr.max_db) : null];
  }
  if (rl || rr) {
    obj.rms = [rl ? r1(rl.mean_db) : null, rr ? r1(rr.mean_db) : null];
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
  if (lufs.integrated_lufs != null) out.integrated_lufs = lufs.integrated_lufs;
  if (lufs.momentary_lufs != null)  out.momentary_lufs  = lufs.momentary_lufs;
  if (lufs.short_term_lufs != null) out.short_term_lufs = lufs.short_term_lufs;
  if (lufs.lra_lu != null)          out.lra_lu          = lufs.lra_lu;
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
    for (const key of Object.keys(r.focus)) {
      if (key === "diagnostic") continue;
      const v = { ...r.focus[key] };
      if (v.spectrum) v.spectrum = compactSpectrum(v.spectrum);
      if (v.time_series) v.time_series = compactTimeSeriesTuples(v.time_series);
      compactPackPair(v);
      delete v.frames_averaged;
      dropEmpty(v);
      focusOut[key] = v;
    }
    out.focus = focusOut;
  }

  if (r.focus_routing) {
    out.focus_routing = r.focus_routing.map(fr => {
      const o = { track: fr.track, voice: fr.voice };
      if (fr.ok === false || fr.error) o.failed = fr.error || true;
      return o;
    });
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
    return o;
  });
  return out;
}

function compressTrackDevices(r) {
  if (!r.devices) return r;
  return {
    devices: r.devices.map(d => {
      const o = { i: d.index, name: d.name, class: d.class_name };
      if (d.chain_path) o.chain_path = d.chain_path;
      if (d.is_active === false) o.off = true;
      if (d.can_have_chains) o.rack = true;
      if (d.gain_reduction_db != null) o.gr_db = d.gain_reduction_db;
      return o;
    })
  };
}

function compressDeviceParams(r) {
  if (!r.params) return r;
  const out = { name: r.name, class: r.class_name };
  out.params = r.params.map(p => {
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
    // Drop falsy defaults (false booleans, 0 counts that mean "none", nulls).
    if (v === null || v === undefined || v === false) continue;
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
