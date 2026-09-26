/* ==========================================================================
   NC engine: G-code parser, tool model, swept-tool stock removal
   Pure JS, no DOM, so it can be unit-tested outside the browser.
   All internal units are millimetres. Z is up, tool position = tool tip.
   ========================================================================== */
const NC = (() => {
  'use strict';
  const RAPID_MMPM = 24000;
  const CC_NOTE = 'Cutter compensation (G41/G42) is treated as wear compensation: the programmed path is the tool centre, and offset values are not applied.';          // assumed rapid rate for time estimates
  // Undercut-shaped tools (wider cutting profile than the neck behind it) cannot be represented by a
  // one-height-per-column height field - see docs/NOTES.md. Detected by name only; stock removal for
  // these is skipped (toolpath shown, nothing cut) rather than simulated wrong.
  const UNDERCUT_RE = /T[- ]?SLOT|SLOT MILL|DOVETAIL|WOODRUFF|KEYSEAT|LOLLIPOP|UNDERCUT|BACK[- ]?CHAMFER|BACK[- ]?COUNTERBORE|BACK[- ]?SPOT/i;
  // Which undercut shape a name describes (see undercutProfile). "SLOT MILL" is what the posted
  // .setup file calls Fusion's slot-mill (T-slot) tool type.
  function undercutKind(name) {
    const s = String(name || '').toUpperCase();
    if (/LOLLIPOP/.test(s)) return 'lollipop';
    if (/DOVETAIL|BACK[- ]?CHAMFER/.test(s)) return 'dovetail';
    return 'slot';
  }

  /* ---------- tool model ---------- */
  function typeFromText(s) {
    s = String(s || '').toUpperCase();
    if (/BALL/.test(s)) return 'ball';
    if (/BULL|CORNER RAD/.test(s)) return 'bull';
    if (/CHAMFER|ENGRAV|SPOT|COUNTERSINK|CSINK/.test(s)) return 'chamfer';
    if (/DRILL|CENTER/.test(s)) return 'drill';
    return 'flat';
  }

  // Fill in anything missing so every tool is drawable and simulatable.
  function completeTool(t) {
    t.undercut = !!t.undercut;
    t.D = t.D > 0 ? t.D : 6;
    if (!t.type) t.type = 'flat';
    if (t.type === 'flat' && t.rc > 0) t.type = t.rc >= t.D / 2 - 1e-6 ? 'ball' : 'bull';
    if (t.type === 'ball') t.rc = t.D / 2;
    if (t.type === 'bull') t.rc = Math.min(Math.max(t.rc || 0.5, 0.05), t.D / 2);
    if (t.type === 'drill' && !(t.tip > 0)) t.tip = 118;
    if (t.type === 'chamfer' && !(t.tip > 0)) t.tip = 90;
    if (!(t.tipD >= 0)) t.tipD = 0;
    const T = simTool(t);
    const tipH = T.kind === 3 ? (T.R - T.r0) * T.slope : (T.kind === 1 ? T.R : 0);
    if (!(t.flute > 0)) t.flute = Math.max(2.5 * t.D, 8);
    t.flute = Math.max(t.flute, tipH + 1);
    if (!(t.stick > 0)) t.stick = t.flute + 10;
    t.stick = Math.max(t.stick, t.flute + 2);
    if (!(t.holderD > 0)) t.holderD = Math.max(32, t.D + 16);
    if (!(t.holderH > 0)) t.holderH = 55;
    if (t.undercut) {
      t.ucType = t.ucType || undercutKind(t.name);
      // The neck is what makes it an undercut tool, and older posted files don't carry it (the
      // .setup's "SD" is just the cutting diameter again - see post v2.7.2). Without a real one, a
      // clearly-labelled guess: close enough to show roughly what the tool reaches, never exact.
      if (t.neckGuess || !(t.neckD > 0 && t.neckD < t.D)) { t.neckD = t.D * (t.ucType === 'lollipop' ? 0.6 : 0.5); t.neckGuess = true; }
      if (t.headGuess || !(t.headH > 0)) { t.headH = t.ucType === 'lollipop' ? t.D : Math.max(t.D * 0.25, 0.5); if (t.ucType !== 'lollipop') t.headGuess = true; }
      if (!(t.flank > 0)) t.flank = 45;
      if (t.ucType === 'lollipop') t.headH = t.D;
    }
    return t;
  }

  // Simulation tool: the profile function prof(d) is the height of the tool
  // surface above the tip at horizontal distance d from the axis.
  function simTool(t) {
    const R = (t.D || 6) / 2, undercut = !!t.undercut;
    if (undercut && t.ucType && t.neckD > 0) {
      const ucProf = undercutProfile(t);
      return { R, kind: 0, rc: 0, r0: R, slope: 0, undercut, ucProf, Rmax: Math.max(...ucProf.map(p => p[1])) };
    }
    if (t.type === 'ball') return { R, kind: 1, rc: R, r0: 0, slope: 0, undercut };
    if (t.type === 'bull') { const rc = Math.min(t.rc || 0.5, R); return { R, kind: 2, rc, r0: R - rc, slope: 0, undercut }; }
    if (t.type === 'drill' || t.type === 'chamfer') {
      const half = ((t.tip || (t.type === 'drill' ? 118 : 90)) / 2) * Math.PI / 180;
      return { R, kind: 3, rc: 0, r0: Math.min(Math.max((t.tipD || 0) / 2, 0), R * 0.95), slope: 1 / Math.tan(half), undercut };
    }
    return { R, kind: 0, rc: 0, r0: R, slope: 0, undercut };
  }

  function prof(T, d) {
    switch (T.kind) {
      case 0: return 0;
      case 1: { const q = T.R * T.R - d * d; return T.R - Math.sqrt(q > 0 ? q : 0); }
      case 2: { const e = d - T.r0; if (e <= 0) return 0; const q = T.rc * T.rc - e * e; return T.rc - Math.sqrt(q > 0 ? q : 0); }
      default: { const e = d - T.r0; return e > 0 ? e * T.slope : 0; }
    }
  }

  function holderSegments(t) {
    if (t.holderSegs && t.holderSegs.length) return t.holderSegs;
    const nose = Math.max(t.D + 6, 16);
    const body = Math.max(t.holderD, nose + 2);
    const taper = Math.min(22, Math.max(t.holderH * 0.35, 8));
    return [{ h: taper, d0: nose, d1: body }, { h: Math.max(1, t.holderH - taper), d0: body, d1: body }];
  }

  /* ---------- Fusion tool library (best effort) ---------- */
  function applyLibrary(json, tools) {
    const arr = Array.isArray(json) ? json : (json && Array.isArray(json.data) ? json.data : []);
    let matched = 0;
    for (const e of arr) {
      const no = e && e['post-process'] && e['post-process'].number;
      if (no == null) continue;
      const t = tools.find(x => x.no === no);
      if (!t) continue;
      const g = e.geometry || {};
      const k = /inch/i.test(e.unit || '') ? 25.4 : 1;
      if (g.DC > 0) t.D = g.DC * k;
      t.type = typeFromText(e.type);
      if (UNDERCUT_RE.test(String(e.type || '') + ' ' + String(e.description || ''))) t.undercut = true;
      t.rc = t.type === 'bull' && g.RE > 0 ? g.RE * k : 0;
      t.tip = t.type === 'drill' ? (g.SIG > 0 ? g.SIG : 118) : (t.type === 'chamfer' ? (g.TA > 0 ? g.TA * 2 : 90) : undefined);
      t.tipD = t.type === 'chamfer' && g['tip-diameter'] > 0 ? g['tip-diameter'] * k : 0;
      t.flute = g.LCF > 0 ? g.LCF * k : 0;
      t.stick = g.LB > 0 ? g.LB * k : (g['shoulder-length'] > 0 ? g['shoulder-length'] * k : 0);
      if (e.description) t.name = String(e.description);
      const segs = e.holder && Array.isArray(e.holder.segments) ? e.holder.segments : null;
      if (segs && segs.length) {
        const kh = /inch/i.test((e.holder && e.holder.unit) || e.unit || '') ? 25.4 : 1;
        t.holderName = e.holder.description || t.holderName;
        t.holderSegs = segs.map(s => ({ h: (s.height || 0) * kh, d0: (s['lower-diameter'] || 0) * kh, d1: (s['upper-diameter'] || 0) * kh }));
        t.holderD = Math.max(...t.holderSegs.map(s => Math.max(s.d0, s.d1)));
        t.holderH = t.holderSegs.reduce((a, s) => a + s.h, 0);
      }
      t.defaulted = false; t.fromLib = true;
      completeTool(t);
      matched++;
    }
    return matched;
  }

  /* ---------- helpers for real-world job files ---------- */
  // Guess units when a program has no G20/G21 (Brother controls default from a parameter).
  function guessInch(stripped) {
    let mx = 0, n = 0; const fs = [];
    const re = /([XYF])\s*(-?\d*\.?\d+)/g; let m;
    while ((m = re.exec(stripped))) {
      const v = Math.abs(parseFloat(m[2]));
      if (m[1] === 'F') fs.push(v); else { n++; if (v > mx) mx = v; }
    }
    if (!n) return false;
    fs.sort((a, b) => a - b);
    return mx < 40 && (fs.length ? fs[fs.length >> 1] : 1e9) < 250;
  }

  // Read diameter, corner radius and point angle out of a tool name such as
  // "1/8  BULL .025R 3/16LOC 4FL" or ".1575 4MM DRILL 140 DEG TSC".
  function guessFromName(t, name, inch) {
    const s = String(name).toUpperCase(), sc = inch ? 25.4 : 1;
    t.type = typeFromText(s);
    if (UNDERCUT_RE.test(s)) t.undercut = true;
    // Numbered/lettered drill convention (e.g. "25 .1496 140DEG CARB DRILL TSC", a real APW
    // name): a bare leading integer followed by a decimal is the drill's index, not its size -
    // the decimal right after it is the real diameter. Without this, "25 ..." reads as 25 inches.
    const idxThenSize = /^\s*\d+\s+(\d*\.\d+)\b/.exec(s);
    const lead = idxThenSize || /^\s*(?:(\d+)\/(\d+)|(\d*\.\d+)|(\d+))\s*(MM)?/.exec(s);
    if (lead) {
      if (idxThenSize) t.D = +lead[1] * sc;
      else { const v = lead[1] ? +lead[1] / +lead[2] : (lead[3] ? +lead[3] : +lead[4]); t.D = lead[5] ? v : v * sc; }
    }
    const cr = /(\d*\.\d+)\s*R\b/.exec(s);
    if (cr && t.type === 'bull') t.rc = +cr[1] * sc;
    const ang = /(\d+)\s*DEG/.exec(s);
    if (ang && (t.type === 'drill' || t.type === 'chamfer')) t.tip = +ang[1];
    t.guessed = true;
  }

  function parseCsvRows(text) {
    const rows = []; let row = [], f = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
      // A quote only opens a quoted field at the very start of that field. Real tool names carry
      // bare inch marks mid-field (O1138.csv: `2.5" Dodeka Kenn Face Mill`), and treating those as
      // a quote swallowed the following row whole - 64 ops read instead of 66.
      else if (c === '"' && f === '') q = true;
      else if (c === ',') { row.push(f); f = ''; }
      else if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; }
      else if (c !== '\r') f += c;
    }
    if (f !== '' || row.length) { row.push(f); rows.push(row); }
    return rows;
  }

  // Setup sheet CSV exported from the CAM post: stock size, cycle time, and one row per operation.
  function parseSetupCsv(text) {
    const rows = parseCsvRows(String(text).replace(/^\uFEFF/, ''));
    const hi = rows.findIndex(r => /^Seq/i.test((r[0] || '').trim()));
    if (hi < 0) return null;
    const out = { stock: null, cycleSec: null, machine: '', unit: 'in', ops: [], tools: [] };
    for (const r of rows.slice(hi + 1)) {
      if (r.length < 8) continue;
      const desc = r[1] || '';
      if (/STOCK:/i.test(desc) || parseFloat(r[0]) === 0) {
        const sm = /STOCK:\s*X\s*=\s*([\d.]+)\s*(\w+)\s*\|\s*Y\s*=\s*([\d.]+)\s*\w+\s*\|\s*Z\s*=\s*([\d.]+)/i.exec(desc);
        if (sm) { out.unit = /^in/i.test(sm[2]) ? 'in' : 'mm'; const k = out.unit === 'in' ? 25.4 : 1; out.stock = { x: +sm[1] * k, y: +sm[3] * k, z: +sm[4] * k }; }
        const cm = /Cycle Time:\s*(\d+):(\d+):(\d+)/i.exec(desc); if (cm) out.cycleSec = +cm[1] * 3600 + +cm[2] * 60 + +cm[3];
        const mm = /Machine:\s*([^|]+)/i.exec(desc); if (mm) out.machine = mm[1].trim();
        continue;
      }
      const g = /T\s*(\d+)/i.exec(r[3] || ''); if (!g) continue;
      const no = +g[1], k = out.unit === 'in' ? 25.4 : 1;
      // Column 8 ("Diameter control dim") holds "D<n> = DIM ..." when the operation-comment
      // note started with DIM (see the post's getDimNote()) - pull out just the DIM... part.
      const dimM = /DIM.*/i.exec(r[8] || '');
      // Strip the setup prefix ("OP50  |", "OP61M B SIDE R650 |") - everything up to the first "|".
      out.ops.push({ label: String(desc).replace(/^\s*OP\d[^|]*\|\s*/i, '').trim(), tool: no, dim: dimM ? dimM[0].trim() : '', seq: (r[0] || '').trim() });
      if (!out.tools.find(t => t.no === no)) out.tools.push({ no, ooh: parseFloat(r[4]) * k, holder: (r[5] || '').trim(), cutD: parseFloat(r[9]) * k, tipRaw: (r[11] || '').trim(), name: (r[12] || '').trim() });
    }
    return out;
  }

  // Fallback tool sizes from the setup sheet when no tool library is loaded.
  function applyCsvTools(tools, csv) {
    if (!csv) return 0;
    let n = 0; const k = csv.unit === 'in' ? 25.4 : 1;
    for (const c of csv.tools) {
      const t = tools.find(x => x.no === c.no); if (!t || t.fromLib) continue;
      if (UNDERCUT_RE.test(c.name || '')) t.undercut = true;
      if (c.cutD > 0) t.D = c.cutD;
      if (c.ooh > 0) t.stick = c.ooh;
      if (c.holder) t.holderName = c.holder;
      const tp = c.tipRaw || '';
      if (/°|deg/i.test(tp)) { const a = parseFloat(tp); if (a > 0) t.tip = t.type === 'chamfer' ? a * 2 : a; }
      else if (parseFloat(tp) > 0 && (t.type === 'flat' || t.type === 'bull')) { t.rc = parseFloat(tp) * k; t.type = t.rc >= t.D / 2 - 1e-6 ? 'ball' : 'bull'; }
      t.flute = 0; t.guessed = false; t.defaulted = false; t.fromCsv = true;
      completeTool(t); n++;
    }
    return n;
  }

  // A Fusion .tools file is a zip holding tools.json.
  async function unzipText(buf) {
    const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf), dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    let e = -1;
    for (let i = b.length - 22; i >= Math.max(0, b.length - 66000); i--) if (dv.getUint32(i, true) === 0x06054b50) { e = i; break; }
    if (e < 0) throw new Error('That is not a zip file');
    const n = dv.getUint16(e + 10, true); let p = dv.getUint32(e + 16, true);
    for (let k = 0; k < n; k++) {
      if (dv.getUint32(p, true) !== 0x02014b50) break;
      const method = dv.getUint16(p + 10, true), csz = dv.getUint32(p + 20, true), nl = dv.getUint16(p + 28, true), el = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true), lo = dv.getUint32(p + 42, true);
      const name = new TextDecoder().decode(b.subarray(p + 46, p + 46 + nl));
      p += 46 + nl + el + cl;
      if (!/\.json$/i.test(name)) continue;
      const start = lo + 30 + dv.getUint16(lo + 26, true) + dv.getUint16(lo + 28, true), data = b.subarray(start, start + csz);
      if (method === 0) return new TextDecoder().decode(data);
      if (method === 8) return await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).text();
      throw new Error('Unsupported zip compression');
    }
    throw new Error('No JSON found inside the .tools file');
  }

  /* ---------- CIMCO scanning cascading post: real stock/fixture/tool data -------------------
     Fusion's built-in "CIMCO scanning" cascading post writes a `.setup` text file plus binary
     STL files (STOCK/PART/FIXTURE) next to the NC/CSV. Real stock and fixture geometry, and a
     tool+holder database sourced from Fusion's own tool numbers rather than parsed out of NC
     comments (the NC-comment path misread a tap's "8-32" thread size as an 8 inch diameter -
     this format reads the same tool's real 0.164in diameter correctly). See docs/plan/NOTES.md
     for the real sample this was built and tested against. */

  // Binary STL only (80-byte header, uint32 triangle count, 50 bytes/triangle: normal + 3
  // vertices as 4-byte floats, +2-byte attribute). Same {pos,idx} shape meshFromHeightArray/
  // fuseTriDexel already return so downstream code treats every mesh source uniformly. No vertex
  // welding - fine for rendering (computeVertexNormals works per-face without shared vertices).
  function parseStlBinary(buf) {
    const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    if (b.length < 84) throw new Error('Not a binary STL file (too short)');
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const n = dv.getUint32(80, true), expected = 84 + n * 50;
    if (b.length !== expected) {
      const head = new TextDecoder().decode(b.subarray(0, Math.min(80, b.length)));
      if (/^\s*solid\b/i.test(head)) throw new Error('ASCII STL is not supported here, only binary STL');
      throw new Error(`STL file size does not match its triangle count (expected ${expected} bytes for ${n} triangles, got ${b.length})`);
    }
    const pos = new Float32Array(n * 9);
    let off = 84, w = 0;
    for (let i = 0; i < n; i++) {
      off += 12; // skip the stored normal - recomputed on load, not trusted from the file
      for (let v = 0; v < 3; v++) { pos[w++] = dv.getFloat32(off, true); pos[w++] = dv.getFloat32(off + 4, true); pos[w++] = dv.getFloat32(off + 8, true); off += 12; }
      off += 2; // attribute byte count
    }
    const idx = new Uint32Array(n * 3);
    for (let i = 0; i < idx.length; i++) idx[i] = i;
    return { pos, idx };
  }

  // Line-based parser for the `.setup` text format. Real grammar (confirmed against a real
  // posted sample, not guessed): `WCS ID1 X0 Y0 Z0 A0 B0 C0`; `STOCK STL PATH="..." X.. Y.. Z..
  // A.. B.. C.. UI`; `WORKPIECE ID1 "..." X.. Y.. Z.. A.. B.. C.. UI RGB=r,g,b` (PART, same shape
  // for FIXTURE); `TOOL <no> "<name>" HOLDER=H<no> KEY=value KEY=value ...`; `HOLDER BEGIN H<no>
  // "<holder name>" UI` then N lines of `upperDia, lowerDia, length` then `HOLDER END`.
  // Unrecognized lines are ignored (forward-compatible with post fields this reader doesn't use).
  function parseCimcoSetup(text) {
    const out = { wcs: null, stockRef: null, partRef: null, fixtureRef: null, tools: [], holders: new Map() };
    let curHolder = null;
    for (const raw of String(text).split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      let m;
      if ((m = /^WCS\s+ID(\d+)\s+X(-?[\d.]+)\s+Y(-?[\d.]+)\s+Z(-?[\d.]+)\s+A(-?[\d.]+)\s+B(-?[\d.]+)\s+C(-?[\d.]+)/i.exec(line))) {
        out.wcs = { id: +m[1], x: +m[2], y: +m[3], z: +m[4], a: +m[5], b: +m[6], c: +m[7] };
        continue;
      }
      if ((m = /^STOCK\s+STL\s+PATH="([^"]*)"\s+X(-?[\d.]+)\s+Y(-?[\d.]+)\s+Z(-?[\d.]+)\s+A(-?[\d.]+)\s+B(-?[\d.]+)\s+C(-?[\d.]+)\s+(UI|UM)/i.exec(line))) {
        out.stockRef = { path: m[1], x: +m[2], y: +m[3], z: +m[4], a: +m[5], b: +m[6], c: +m[7], unit: m[8].toUpperCase() };
        continue;
      }
      if ((m = /^(WORKPIECE|FIXTURE)\s+ID(\d+)\s+"([^"]*)"\s+X(-?[\d.]+)\s+Y(-?[\d.]+)\s+Z(-?[\d.]+)\s+A(-?[\d.]+)\s+B(-?[\d.]+)\s+C(-?[\d.]+)\s+(UI|UM)/i.exec(line))) {
        const ref = { path: m[3], x: +m[4], y: +m[5], z: +m[6], a: +m[7], b: +m[8], c: +m[9], unit: m[10].toUpperCase() };
        if (/^WORKPIECE$/i.test(m[1])) out.partRef = ref; else out.fixtureRef = ref;
        continue;
      }
      if ((m = /^HOLDER\s+BEGIN\s+(\S+)\s+"([^"]*)"\s+(UI|UM)/i.exec(line))) {
        curHolder = { name: m[2], unit: m[3].toUpperCase(), segments: [] };
        out.holders.set(m[1], curHolder);
        continue;
      }
      if (/^HOLDER\s+END/i.test(line)) { curHolder = null; continue; }
      if (curHolder && (m = /^(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*$/.exec(line))) {
        curHolder.segments.push({ upperDia: +m[1], lowerDia: +m[2], length: +m[3] });
        continue;
      }
      // Post v2.7.2+: every candidate source of the tool's real neck size (see that post's notes).
      if ((m = /^TOOLGEOM\s+(\d+)\s+(.*)$/i.exec(line))) {
        const fields = {};
        for (const tok of m[2].split(/\s+/)) { const eq = tok.indexOf('='); if (eq > 0) fields[tok.slice(0, eq)] = tok.slice(eq + 1); }
        out.toolGeom = out.toolGeom || new Map(); out.toolGeom.set(+m[1], fields);
        continue;
      }
      if ((m = /^TOOL\s+(\d+)\s+"([^"]*)"\s+(.*)$/i.exec(line))) {
        const fields = {};
        for (const tok of m[3].split(/\s+/)) { const eq = tok.indexOf('='); if (eq > 0) fields[tok.slice(0, eq)] = tok.slice(eq + 1); }
        out.tools.push({ no: +m[1], name: m[2], holderId: fields.HOLDER || null, fields });
        continue;
      }
    }
    return out;
  }

  // Fills tool fields from the CIMCO setup's own tool database, matched by tool number - mirrors
  // applyLibrary's contract (fills already-NC-parsed tool objects, doesn't replace them). More
  // reliable than NC-comment guessing for the fields it covers: sourced from Fusion's own tool
  // numbers, not text parsing (see the module header comment for the tap-diameter bug this fixes).
  function applyCimcoTools(parsed, tools) {
    let matched = 0;
    for (const ct of parsed.tools) {
      const t = tools.find(x => x.no === ct.no);
      if (!t) continue;
      const f = ct.fields, k = f.US === 'UI' ? 25.4 : 1;
      const num = key => (f[key] !== undefined && f[key] !== '') ? parseFloat(f[key]) : undefined;
      t.type = typeFromText(ct.name);
      if (f.EMCT === 'BEM') t.type = 'ball'; else if (f.EMCT === 'BNEM') t.type = 'bull'; else if (f.EMCT === 'FEM') t.type = 'flat';
      if (f.CHTYPE) t.type = 'chamfer';
      if (UNDERCUT_RE.test(ct.name || '')) t.undercut = true;
      const D = num('D'); if (D > 0) t.D = D * k;
      const FL = num('FL'); if (FL > 0) t.flute = FL * k;
      if (t.type === 'bull') { const CR = num('CR'); if (CR > 0) t.rc = CR * k; }
      const BL = num('BL'); if (BL > 0) t.stick = BL * k;
      if (t.type === 'drill') { const TA = num('TA'); if (TA > 0) t.tip = TA; }
      else if (t.type === 'chamfer') {
        // "A=" is the post's own tool.taperAngle in radians. INFERRED, not doc-verified: treating
        // it as the half-angle from the tool axis, because the one real sample (A=0.7854rad =
        // 45deg) doubles to exactly this engine's own default full included angle (90deg) for an
        // unspecified chamfer - a strong but single-data-point match, not a checked API fact.
        const A = num('A'); if (A > 0) t.tip = A * 180 / Math.PI * 2;
      }
      if (ct.name) t.name = ct.name;
      if (t.undercut) applyUndercutGeometry(t, f, parsed.toolGeom && parsed.toolGeom.get(ct.no), k);
      const holder = ct.holderId ? parsed.holders.get(ct.holderId) : null;
      if (holder && holder.segments.length) {
        const hk = holder.unit === 'UI' ? 25.4 : 1;
        // WITHIN each segment, d0=upperDia/d1=lowerDia (file column order, unchanged) is right:
        // decided by measuring profile continuity on all three real holders in
        // fixtures/cimco/O1224.setup - a real holder is continuous except at genuine shoulders,
        // and this pairing leaves only 6 of 24 junctions broken (real steps, e.g. H85's 1.25in
        // collet nose -> 1.73in nut), where the reverse pairing broke all 24.
        //
        // But the ARRAY ORDER that continuity check couldn't settle: reversing the whole array
        // AND swapping which column is d0/d1 preserves every one of those junctions exactly
        // (it's a mirror, not a rewrite), so continuity alone can't tell tool-end-first from
        // spindle-end-first. The previous version guessed tool-end-first from an unverified read
        // of the post's loop direction. John compared a real posted job's probe holder against
        // Fusion's own render on 2026-09-22 and confirmed that guess was backwards - the holder
        // was mirrored end-to-end (a flange that belongs near the spindle end was rendering next
        // to the tool). Flipped here: array reversed, d0/d1 swapped to match.
        t.holderSegs = holder.segments.slice().reverse().map(s => ({ h: s.length * hk, d0: s.lowerDia * hk, d1: s.upperDia * hk }));
        t.holderName = holder.name;
        t.holderD = Math.max(...t.holderSegs.map(s => Math.max(s.d0, s.d1)));
        t.holderH = t.holderSegs.reduce((a, s) => a + s.h, 0);
      }
      t.defaulted = false; t.fromLib = true; t.fromCimco = true;
      completeTool(t);
      matched++;
    }
    return matched;
  }

  // Undercut tool geometry from a posted .setup: its TOOL line (k = inch/mm factor) and, from post
  // v2.7.2 on, its TOOLGEOM line. Neck diameter, in order of preference: a tool parameter that names
  // it; the first shaft section thinner than the cutter; the TOOL line's shaft diameter AD when
  // thinner than the cutter. None of those -> left for completeTool's labelled guess.
  // UNVERIFIED which of these Fusion actually fills - one real v2.7.2 post settles it.
  function applyUndercutGeometry(t, f, g, k) {
    t.ucType = undercutKind(t.name);
    const n = v => { const x = parseFloat(v); return isFinite(x) && x > 0 ? x : null; };
    const gk = g ? (g.US === 'UM' ? 1 : 25.4) : k, D = t.D;
    const cands = [];
    if (g) {
      cands.push(n(g.P_shoulderDiameter), n(g.P_neckDiameter));
      if (g.SHAFT && g.SHAFT !== 'NA' && g.SHAFT !== 'EMPTY') for (const s of g.SHAFT.split('/')) cands.push(n(s.split(':')[0]));
    }
    const neck = cands.map(v => v && v * gk).find(v => v && v < D - 1e-6) || (n(f.AD) && n(f.AD) * k < D - 1e-6 ? n(f.AD) * k : null);
    if (neck) { t.neckD = neck; t.neckGuess = false; }
    const sh = n(f.AD) || (g && n(g.SHD)); if (sh) t.shankD = sh * (n(f.AD) ? k : gk);
    const sl = n(f.SL) || (g && n(g.SL)); if (sl) t.neckL = sl * (n(f.SL) ? k : gk);
    const fl = n(f.FL) || (g && n(g.FL)); if (fl && t.ucType !== 'lollipop') { t.headH = fl * (n(f.FL) ? k : gk); t.headGuess = false; }
    const a = n(f.A) || (g && n(g.TA)); if (a && t.ucType === 'dovetail') t.flank = a * 180 / Math.PI;
  }

  function cimcoBBox(mesh) {
    let xmin = Infinity, ymin = Infinity, zmin = Infinity, xmax = -Infinity, ymax = -Infinity, zmax = -Infinity;
    for (let i = 0; i < mesh.pos.length; i += 3) {
      const x = mesh.pos[i], y = mesh.pos[i + 1], z = mesh.pos[i + 2];
      if (x < xmin) xmin = x; if (x > xmax) xmax = x;
      if (y < ymin) ymin = y; if (y > ymax) ymax = y;
      if (z < zmin) zmin = z; if (z > zmax) zmax = z;
    }
    return { xmin, xmax, ymin, ymax, zmin, zmax };
  }
  // Ordinary roll-pitch-yaw about FIXED X/Y/Z - deliberately NOT G68.2's Fanuc Z-X-Z convention.
  // This A/B/C describes a CIMCO/Fusion fixture-coordinate-system offset, a different field from
  // a different part of the toolchain, with zero real evidence on its rotation order either way.
  // Only exercised so far by a real sample with A=B=C=0 - unverified at nonzero (see below).
  function cimcoRefMatrix(a, b, c) {
    const d = v => v * Math.PI / 180, ca = Math.cos(d(a || 0)), sa = Math.sin(d(a || 0)), cb = Math.cos(d(b || 0)), sb = Math.sin(d(b || 0)), cc = Math.cos(d(c || 0)), sc = Math.sin(d(c || 0));
    const Rx = [[1, 0, 0], [0, ca, -sa], [0, sa, ca]], Ry = [[cb, 0, sb], [0, 1, 0], [-sb, 0, cb]], Rz = [[cc, -sc, 0], [sc, cc, 0], [0, 0, 1]];
    return matMul3(matMul3(Rz, Ry), Rx);
  }
  function applyCimcoRef(mesh, ref) {
    const k = ref.unit === 'UI' ? 25.4 : 1, M = cimcoRefMatrix(ref.a, ref.b, ref.c);
    const nonzeroRot = Math.abs(ref.a || 0) > 1e-6 || Math.abs(ref.b || 0) > 1e-6 || Math.abs(ref.c || 0) > 1e-6;
    const pos = new Float32Array(mesh.pos.length);
    for (let i = 0; i < mesh.pos.length; i += 3) {
      const x = mesh.pos[i] * k, y = mesh.pos[i + 1] * k, z = mesh.pos[i + 2] * k;
      pos[i] = (ref.x || 0) * k + M[0][0] * x + M[0][1] * y + M[0][2] * z;
      pos[i + 1] = (ref.y || 0) * k + M[1][0] * x + M[1][1] * y + M[1][2] * z;
      pos[i + 2] = (ref.z || 0) * k + M[2][0] * x + M[2][1] * y + M[2][2] * z;
    }
    return { pos, idx: mesh.idx, nonzeroRot };
  }
  // Bridges a parsed .setup + its STL meshes into the SAME floorsim-setup shape the Fusion export
  // add-in already produces (see fixtures/setups/*.floorsim.json) - buildFixtures()/checkSetup()
  // in app.js need zero changes as a result, they only ever cared about the shape, not the
  // source. PART is transformed and returned separately (partMesh) - parsed and stored, not
  // wired into rendering (see docs/plan for why).
  function cimcoToFloorsimSetup(parsed, meshes, programName) {
    const warnings = [];
    // Each mesh's own offset places it in the post's world frame, and the WCS line is where the
    // program's zero sits in that SAME frame - the toolpath is relative to the WCS, so the WCS
    // origin has to come back off every mesh. Units: the WCS line is mm, the mesh offsets carry
    // their own UI/UM flag - inferred from the one real file with a nonzero WCS (O1138: WCS
    // Z120.193 = offset Z4.732in x 25.4 exactly), not documented. Missing this drew a job on a
    // riser 120mm too high, with every tool buried in the fixture. A rotated WCS (nonzero A/B/C)
    // is unverified and warned about rather than guessed at.
    const w = parsed.wcs || { x: 0, y: 0, z: 0, a: 0, b: 0, c: 0 };
    if (Math.abs(w.a || 0) > 1e-6 || Math.abs(w.b || 0) > 1e-6 || Math.abs(w.c || 0) > 1e-6) warnings.push('The .setup file\'s WCS has a nonzero A/B/C rotation - only its position is applied here, check placement carefully.');
    const place = (mesh, ref, label) => {
      const t = applyCimcoRef(mesh, ref);
      if (t.nonzeroRot) warnings.push(`${label} has a nonzero A/B/C rotation in the .setup file - this rotation convention is unverified, check placement carefully.`);
      for (let i = 0; i < t.pos.length; i += 3) { t.pos[i] -= w.x; t.pos[i + 1] -= w.y; t.pos[i + 2] -= w.z; }
      return t;
    };
    let stock = null, fixtures = [], partMesh = null, stockMesh = null;
    // A 2nd op's STOCK.stl is the shape the previous op left (O1247: 82,822 triangles), not a
    // block - keep it so the sim can start from that shape. A plain box (every point a corner of
    // its own outer box) needs no mesh.
    if (meshes.stock && parsed.stockRef) {
      const t = place(meshes.stock, parsed.stockRef, 'STOCK'), b = cimcoBBox(t);
      stock = { xmin: b.xmin, xmax: b.xmax, ymin: b.ymin, ymax: b.ymax, zmin: b.zmin, zmax: b.zmax };
      const e = 1e-3, on = (v, lo, hi) => Math.abs(v - lo) < e || Math.abs(v - hi) < e;
      for (let i = 0; i < t.pos.length; i += 3) if (!on(t.pos[i], b.xmin, b.xmax) || !on(t.pos[i + 1], b.ymin, b.ymax) || !on(t.pos[i + 2], b.zmin, b.zmax)) { stockMesh = t; break; }
    }
    if (meshes.fixture && parsed.fixtureRef) { const t = place(meshes.fixture, parsed.fixtureRef, 'FIXTURE'); fixtures.push({ name: 'FIXTURE', positions: Array.from(t.pos), indices: Array.from(t.idx) }); }
    if (meshes.part && parsed.partRef) partMesh = place(meshes.part, parsed.partRef, 'PART');
    return { setup: { format: 'floorsim-setup', version: 1, units: 'mm', setup: programName, stock, fixtures }, warnings, partMesh, stockMesh };
  }

  /* ---------- tilted work planes (G68.2 / G53.1 / G69) ----------
     3+2 programs tilt to an angle, then cut flat in that plane using X/Y/Z already
     expressed in the tilted plane's own local frame (Tool Center Point Control).
     G68.2 X_ Y_ Z_ I_ J_ K_ defines the plane (I=roll about X, J=pitch about Y,
     K=yaw about Z, degrees, default order I-then-J-then-K per Fanuc's Q123 default -
     unverified against this shop's actual machine kinematics beyond the matrix being
     a proper rotation; confirm visually once oriented rendering exists).
     G53.1 activates it (motion after this point is local to the tilted plane).
     G69 cancels back to the base frame. */
  function deg(a) { return a * Math.PI / 180; }
  function matMul3(A, B) {
    const M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) for (let k = 0; k < 3; k++) M[r][c] += A[r][k] * B[k][c];
    return M;
  }
  // G68.2's I/J/K (P0 default) is Fanuc's intrinsic Z-X-Z Euler convention, NOT roll-pitch-yaw
  // about fixed X/Y/Z: I spins about Z first, J then tilts about the once-rotated X, K spins
  // about the twice-rotated Z last. The equivalent fixed-axis matrix product is Rz(I)*Rx(J)*Rz(K)
  // - confirmed decisively (0mm error on all 7 real tilted planes) against a real job's actual
  // posted stock geometry (see docs/plan and NOTES.md); the previously-assumed Rz(K)*Ry(J)*Rx(I)
  // roll-pitch-yaw order was wrong (only happened to look plausible on single-axis tilts, where
  // rotation order doesn't matter, which is all that had been visually checked before).
  function planeMatrix(I, J, K) {
    const ci = Math.cos(deg(I)), si = Math.sin(deg(I)), cj = Math.cos(deg(J)), sj = Math.sin(deg(J)), ck = Math.cos(deg(K)), sk = Math.sin(deg(K));
    const Rz1 = [[ci, -si, 0], [si, ci, 0], [0, 0, 1]];
    const Rx = [[1, 0, 0], [0, cj, -sj], [0, sj, cj]];
    const Rz2 = [[ck, -sk, 0], [sk, ck, 0], [0, 0, 1]];
    return matMul3(matMul3(Rz1, Rx), Rz2);
  }

  /* ---------- G-code parser ---------- */
  function parseProgram(text, opts) {
    opts = opts || {};
    const lines = String(text).replace(/\r/g, '').split('\n');
    const X = [], Y = [], Z = [], K = [], F = [], S = [], TL = [], CO = [], OP = [], LN = [], PL = [], CC = [], CD = [];
    const ops = [], tools = new Map(), warnings = [], notes = [], warned = new Set();
    const warn = m => { if (!warned.has(m)) { warned.add(m); warnings.push(m); } };
    // planes[0] is always the base (untilted) frame. curPlaneId is which one new moves belong to.
    const planes = [{ id: 0, origin: [0, 0, 0], ijk: [0, 0, 0], matrix: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] }];
    let pendingPlane = null, curPlaneId = 0, sawRotary = false;
    const registerPlane = p => {
      const key = v => Math.round(v * 1e4) / 1e4;
      for (const pl of planes) {
        if (pl === planes[0]) continue;
        if (key(pl.origin[0]) === key(p.ox) && key(pl.origin[1]) === key(p.oy) && key(pl.origin[2]) === key(p.oz) &&
            key(pl.ijk[0]) === key(p.i) && key(pl.ijk[1]) === key(p.j) && key(pl.ijk[2]) === key(p.k)) return pl.id;
      }
      const id = planes.length;
      planes.push({ id, origin: [p.ox, p.oy, p.oz], ijk: [p.i, p.j, p.k], matrix: planeMatrix(p.i, p.j, p.k) });
      return id;
    };

    // Units are often declared after the tool comments, so look ahead.
    const stripped = lines.map(l => l.replace(/\([^)]*\)/g, ' ').replace(/;.*/, '')).join('\n');
    const um = /G\s*(20|21)(?!\d)/.exec(stripped);
    let inch = false;
    if (opts.units === 'inch') inch = true;
    else if (opts.units === 'mm') inch = false;
    else if (um) inch = um[1] === '20';
    else {
      inch = guessInch(stripped);
      notes.push('No G20/G21 in this program, so the units were read as ' + (inch ? 'inches' : 'millimetres') + '. Change this under Stock and resolution if that is wrong.');
    }

    let x = 0, y = 0, z = 0, abs = true, plane = 17, motion = -1, r98 = true;
    let feed = 0, spindle = 0, spinOn = false, coolant = 0, tool = 0, pendingTool = 0;
    let cycleR = 0, cycleZ = 0, cycleInit = 0;
    let pendingLabel = null, forceNewOp = true, init = null;
    let comp = 0, compD = 0; // 0 off, 1 = G41 (left), 2 = G42 (right); compD = the D register named on that same block
    // The N word on the current tool-change block (G100/M6) - the sequence number an operator types
    // to restart the machine at that tool. Every op under one tool change shares it. Other N words
    // (the post's N96001/N99999 length-check macros) are deliberately not tracked.
    let curSeqN = null, pendingSeqN = null;

    const getTool = no => {
      let t = tools.get(no);
      if (!t) { t = { no, name: no ? 'T' + no : 'No tool selected', type: 'flat', D: 6, rc: 0, defaulted: true }; tools.set(no, t); }
      return t;
    };

    const push = (kind, nx, ny, nz, ln) => {
      if (!init) init = { x: nx, y: ny, z: nz };
      if (forceNewOp || pendingLabel !== null || !ops.length) {
        const t = getTool(tool);
        ops.push({ label: pendingLabel || t.name || ('T' + tool), tool, move: X.length, line: ln, comp: 0, compD: 0, dim: '', seqN: curSeqN });
        pendingLabel = null; forceNewOp = false;
      }
      X.push(nx); Y.push(ny); Z.push(nz); K.push(kind); F.push(feed);
      S.push(spinOn ? spindle : 0); TL.push(tool); CO.push(coolant); OP.push(ops.length - 1); LN.push(ln); PL.push(curPlaneId);
      CC.push(comp); CD.push(compD);
      x = nx; y = ny; z = nz;
    };

    const handleComment = (c, own) => {
      let m = /^T\s*(\d+)\s+(.*)$/i.exec(c);
      if (m && /\bD\s*=/i.test(m[2])) {                       // Fusion tool-list comment
        const t = getTool(+m[1]); t.defaulted = false;
        const rest = m[2], sc = inch ? 25.4 : 1;
        const num = re => { const r = re.exec(rest); return r ? parseFloat(r[1]) : null; };
        const D = num(/\bD\s*=\s*([-\d.]+)/i), CR = num(/\bCR\s*=\s*([-\d.]+)/i), TP = num(/TAPER\s*=\s*([-\d.]+)/i);
        if (D != null) t.D = D * sc;
        if (CR != null) t.rc = CR * sc;
        const parts = rest.split(/\s+-\s+/), last = parts[parts.length - 1].trim();
        if (parts.length > 1 && last && !/=/.test(last)) { t.name = last; t.type = typeFromText(last); }
        if (TP != null && TP > 0 && t.type === 'chamfer') t.tip = TP * 2;
        return;
      }
      m = /^T\s*(\d+)\s+-\s+(.+)$/i.exec(c);
      if (m) {                                               // shop style: T57 - NAME - HLDR=.. - OOH=..
        const t = getTool(+m[1]), sc = inch ? 25.4 : 1, parts = m[2].split(/\s+-\s+/);
        t.name = parts[0].trim(); guessFromName(t, t.name, inch); t.defaulted = false;
        for (const p of parts.slice(1)) {
          const kv = /^([A-Z]+)\s*=\s*(.+)$/i.exec(p.trim()); if (!kv) continue;
          const key = kv[1].toUpperCase();
          if (key === 'OOH' && parseFloat(kv[2]) > 0) t.stick = parseFloat(kv[2]) * sc;
          else if (key === 'HLDR') t.holderName = kv[2].trim();
        }
        return;
      }
      if (own && c && !/^FTL-/i.test(c)) pendingLabel = c;   // only stand-alone comment lines name an operation
    };

    // Arcs in any plane. (u,v) is the plane, w the axis that moves helically.
    const arc = (cw, tx, ty, tz, a, ln) => {
      const k = inch ? 25.4 : 1;
      let iu, iv, iw, cuw, cvw;
      if (plane === 17) { iu = 0; iv = 1; iw = 2; cuw = 'I'; cvw = 'J'; }
      else if (plane === 18) { iu = 2; iv = 0; iw = 1; cuw = 'K'; cvw = 'I'; }
      else { iu = 1; iv = 2; iw = 0; cuw = 'J'; cvw = 'K'; }
      const P0 = [x, y, z], P1 = [tx, ty, tz];
      const u0 = P0[iu], v0 = P0[iv], w0 = P0[iw], u1 = P1[iu], v1 = P1[iv], w1 = P1[iw];
      let cu, cv;
      if (cuw in a || cvw in a) { cu = u0 + (a[cuw] || 0) * k; cv = v0 + (a[cvw] || 0) * k; }
      else if ('R' in a) {
        const r = a.R * k, du = u1 - u0, dv = v1 - v0, d = Math.hypot(du, dv);
        if (d < 1e-9) { push(1, tx, ty, tz, ln); return; }
        const hh = Math.sqrt(Math.max(0, r * r - (d / 2) * (d / 2)));
        const sgn = (cw ? -1 : 1) * (r > 0 ? 1 : -1);
        cu = (u0 + u1) / 2 + sgn * hh * (-dv / d); cv = (v0 + v1) / 2 + sgn * hh * (du / d);
      } else { push(1, tx, ty, tz, ln); return; }
      const rad = Math.hypot(u0 - cu, v0 - cv);
      const a0 = Math.atan2(v0 - cv, u0 - cu), a1 = Math.atan2(v1 - cv, u1 - cu);
      let da = a1 - a0;
      if (cw) { if (da >= -1e-9) da -= 2 * Math.PI; } else { if (da <= 1e-9) da += 2 * Math.PI; }
      const step = rad > 0.01 ? 2 * Math.acos(Math.max(-1, 1 - 0.004 / rad)) : Math.PI / 4;
      const n = Math.max(2, Math.min(4000, Math.ceil(Math.abs(da) / step)));
      for (let s = 1; s <= n; s++) {
        if (s === n) { push(1, tx, ty, tz, ln); continue; }
        const ang = a0 + da * s / n, pt = [0, 0, 0];
        pt[iu] = cu + rad * Math.cos(ang); pt[iv] = cv + rad * Math.sin(ang); pt[iw] = w0 + (w1 - w0) * s / n;
        push(1, pt[0], pt[1], pt[2], ln);
      }
    };

    const block = (words, ln) => {
      const g = [], mc = [], a = {};
      let nWord = null;
      for (const [c, v] of words) {
        if (c === 'G') g.push(v);
        else if (c === 'M') mc.push(Math.round(v));
        else if (c === 'N') nWord = v;
        else if ('XYZIJKRQPFSTHDL'.includes(c)) a[c] = v;
        else if ('ABC'.includes(c)) { if (Math.abs(v) > 1e-9) sawRotary = true; }
      }
      const k = () => (inch ? 25.4 : 1);
      let newMotion = null, skip = false, toolChange = false;
      for (const v of g) {
        switch (v) {
          case 20: inch = true; break;
          case 21: inch = false; break;
          case 90: abs = true; break;
          case 91: abs = false; break;
          case 17: plane = 17; break;
          case 18: plane = 18; break;
          case 19: plane = 19; break;
          case 98: r98 = true; break;
          case 99: r98 = false; break;
          case 0: case 1: case 2: case 3: newMotion = v; break;
          case 73: case 81: case 82: case 83: case 84: case 85: case 86: case 87: case 88: case 89: newMotion = v; break;
          case 80: newMotion = -1; break;
          case 4: case 10: case 28: case 30: case 53: case 92: skip = true; break;
          // Tilted work plane (3+2): G68.2 defines it, G53.1 activates it (moves after
          // this point are local to the tilted plane), G69 cancels back to the base frame.
          case 68.2: pendingPlane = { ox: ('X' in a ? a.X * k() : 0), oy: ('Y' in a ? a.Y * k() : 0), oz: ('Z' in a ? a.Z * k() : 0), i: a.I || 0, j: a.J || 0, k: a.K || 0 }; skip = true; break;
          case 53.1: if (pendingPlane) { curPlaneId = registerPlane(pendingPlane); pendingPlane = null; } skip = true; break;
          case 69: curPlaneId = 0; skip = true; break;
          case 100: toolChange = true; break;
          case 40: comp = 0; compD = 0; break;
          case 41: comp = 1; if (!notes.includes(CC_NOTE)) notes.push(CC_NOTE); break;
          case 42: comp = 2; if (!notes.includes(CC_NOTE)) notes.push(CC_NOTE); break;
          default: break;
        }
      }
      // The D word that activates comp is always on the same block as G41/G42 in this shop's
      // programs (verified against O1228.NC and O1224.NC); tying the capture to that specific
      // transition, not "whenever comp happens to be on", avoids picking up an unrelated D word
      // from a tool-change block (G100 also carries its own D, the diameter offset register).
      if ((g.includes(41) || g.includes(42)) && 'D' in a) compD = a.D;
      if ('F' in a) feed = a.F * k();
      if ('S' in a) spindle = a.S;
      if ('T' in a) { pendingTool = Math.round(a.T); pendingSeqN = nWord; }   // "N10 T1" then "M6" on its own line
      for (const m of mc) {
        if (m === 3 || m === 4) spinOn = true;
        else if (m === 5) spinOn = false;
        else if (m === 8) coolant |= 1;
        else if (m === 7) coolant |= 2;
        else if (m === 9) coolant = 0;
        else if (m === 88 || m === 494) coolant |= 4;
        else if (m === 89 || m === 495) coolant &= ~4;
      }
      if (mc.includes(6) || toolChange) { tool = pendingTool; getTool(tool); forceNewOp = true; const sn = nWord !== null ? nWord : pendingSeqN; curSeqN = sn !== null ? Math.round(sn) : null; }
      if (skip) return;

      const hasXY = ('X' in a) || ('Y' in a), hasXYZ = hasXY || ('Z' in a);
      if (newMotion !== null) {
        if (newMotion >= 73 && !(motion >= 73)) cycleInit = z;
        motion = newMotion;
      }
      const tx = 'X' in a ? (abs ? a.X * k() : x + a.X * k()) : x;
      const ty = 'Y' in a ? (abs ? a.Y * k() : y + a.Y * k()) : y;
      const tz = 'Z' in a ? (abs ? a.Z * k() : z + a.Z * k()) : z;
      if (motion === 0 || motion === 1) { if (hasXYZ) push(motion === 0 ? 0 : 1, tx, ty, tz, ln); }
      else if (motion === 2 || motion === 3) { if (hasXYZ) arc(motion === 2, tx, ty, tz, a, ln); }
      else if (motion >= 73) {
        if ('R' in a) cycleR = abs ? a.R * k() : cycleInit + a.R * k();
        if ('Z' in a) cycleZ = abs ? a.Z * k() : cycleR + a.Z * k();
        if (newMotion !== null || hasXY) {
          const cx = 'X' in a ? tx : x, cy = 'Y' in a ? ty : y;
          const retr = r98 ? Math.max(cycleInit, cycleR) : cycleR;
          push(0, cx, cy, z, ln);
          push(0, cx, cy, cycleR, ln);
          push(1, cx, cy, cycleZ, ln);          // peck cycles are simulated as one plunge
          push(0, cx, cy, retr, ln);
        }
      }
    };

    for (let li = 0; li < lines.length; li++) {
      const raw = lines[li];
      if (raw.charCodeAt(0) === 47) continue;                         // block delete
      const comments = [];
      let code = raw.replace(/\(([^)]*)\)/g, (m, c) => { comments.push(c.trim()); return ' '; });
      const sc = code.indexOf(';');
      if (sc >= 0) { comments.push(code.slice(sc + 1).trim()); code = code.slice(0, sc); }
      const own = !code.trim();
      for (const c of comments) if (c) handleComment(c, own);
      const words = [];
      const re = /([A-Za-z])\s*([-+]?(?:\d+\.?\d*|\.\d+))/g;
      let m;
      while ((m = re.exec(code))) words.push([m[1].toUpperCase(), parseFloat(m[2])]);
      if (words.length) block(words, li + 1);
    }

    // Tilted-plane summary: a plain note when G68.2 planes were found (each is simulated in its
    // own frame), otherwise the generic warning for any other unaccounted rotary motion.
    if (planes.length > 1) {
      const tilted = PL.filter(p => p !== 0).length;
      notes.push(`Uses ${planes.length - 1} tilted work plane(s) (G68.2/G53.1) across ${tilted} move(s).`);
    } else if (sawRotary) {
      warn('Rotary axis moves (A/B/C) are ignored');
    }

    const n = X.length;
    const P = {
      n, lines, ops, warnings, notes, init: init || { x: 0, y: 0, z: 0 },
      X: Float32Array.from(X), Y: Float32Array.from(Y), Z: Float32Array.from(Z),
      K: Uint8Array.from(K), F: Float32Array.from(F), S: Float32Array.from(S),
      TL: Uint16Array.from(TL), CO: Uint8Array.from(CO), OP: Uint16Array.from(OP), LN: Uint32Array.from(LN),
      PL: Uint16Array.from(PL), planes, CC: Uint8Array.from(CC), CD: Uint16Array.from(CD),
      inch,
    };
    // tools used by moves must exist
    for (let i = 0; i < n; i++) getTool(P.TL[i]);
    P.tools = [...tools.values()].filter(t => t.no !== 0 || P.TL.includes(0)).sort((a, b) => a.no - b.no);
    P.tools.forEach(completeTool);

    // cumulative time (seconds) and bounds of cutting moves
    P.cumT = new Float64Array(n);
    let tt = 0, px = P.init.x, py = P.init.y, pz = P.init.z;
    const b = { xmin: 1e9, xmax: -1e9, ymin: 1e9, ymax: -1e9, zmin: 1e9, zmax: -1e9 };
    const ball = { xmin: 1e9, xmax: -1e9, ymin: 1e9, ymax: -1e9, zmin: 1e9, zmax: -1e9 };
    const b0 = { xmin: 1e9, xmax: -1e9, ymin: 1e9, ymax: -1e9, zmin: 1e9, zmax: -1e9 };
    const ball0 = { xmin: 1e9, xmax: -1e9, ymin: 1e9, ymax: -1e9, zmin: 1e9, zmax: -1e9 };
    for (let i = 0; i < n; i++) {
      // A move right after a plane switch has no valid "from" point in this move's frame - same
      // reasoning as cutMove's guard. Skip its distance/time contribution rather than measuring
      // a meaningless cross-frame jump; this move's own end point still becomes px/py/pz below.
      const samePlane = !(P.PL && i > 0 && P.PL[i - 1] !== P.PL[i]);
      const d = samePlane ? Math.hypot(P.X[i] - px, P.Y[i] - py, P.Z[i] - pz) : 0;
      const sp = P.K[i] ? (P.F[i] > 0 ? P.F[i] : 500) : RAPID_MMPM;
      tt += d / (sp / 60); P.cumT[i] = tt;
      const bb = P.K[i] ? b : ball;
      bb.xmin = Math.min(bb.xmin, P.X[i]); bb.xmax = Math.max(bb.xmax, P.X[i]);
      bb.ymin = Math.min(bb.ymin, P.Y[i]); bb.ymax = Math.max(bb.ymax, P.Y[i]);
      bb.zmin = Math.min(bb.zmin, P.Z[i]); bb.zmax = Math.max(bb.zmax, P.Z[i]);
      // Same bounds, but base-plane (0) moves only - a program's tilted-plane moves are in
      // unrelated local frames and would otherwise wreck the auto-guessed base stock box.
      if (!P.PL || P.PL[i] === 0) {
        const bb0 = P.K[i] ? b0 : ball0;
        bb0.xmin = Math.min(bb0.xmin, P.X[i]); bb0.xmax = Math.max(bb0.xmax, P.X[i]);
        bb0.ymin = Math.min(bb0.ymin, P.Y[i]); bb0.ymax = Math.max(bb0.ymax, P.Y[i]);
        bb0.zmin = Math.min(bb0.zmin, P.Z[i]); bb0.zmax = Math.max(bb0.zmax, P.Z[i]);
      }
      px = P.X[i]; py = P.Y[i]; pz = P.Z[i];
      // Cutter comp per operation, for the Operations list: first activation wins if an op
      // somehow toggles between G41/G42 more than once (rare, but don't overwrite with the
      // second one - the operator wants to know it's active and which D register, not a history).
      if (P.CC[i] && !P.ops[P.OP[i]].comp) { const o = P.ops[P.OP[i]]; o.comp = P.CC[i]; o.compD = P.CD[i]; }
    }
    P.total = tt;
    // Prefer base-plane-only bounds; fall back to every move only if the base plane somehow has none.
    P.bounds = b0.xmin <= b0.xmax ? b0 : (ball0.xmin <= ball0.xmax ? ball0 : (b.xmin <= b.xmax ? b : ball));
    P.feedBounds = b0.xmin <= b0.xmax || b.xmin <= b.xmax;
    return P;
  }

  /* ---------- stock model: z-dexel height field with swept-tool cutting ---------- */
  function fsw(T, az, dz, L2, uD, uu, t) {
    const d2 = L2 * t * t - 2 * uD * t + uu;
    return az + t * dz + prof(T, Math.sqrt(d2 > 0 ? d2 : 0));
  }

  class HeightSim {
    constructor(box, target) {
      this.box = box;
      const W = box.xmax - box.xmin, H = box.ymax - box.ymin;
      const c = Math.max(W, H) / target;
      this.nx = Math.max(8, Math.round(W / c));
      this.ny = Math.max(8, Math.round(H / c));
      this.dx = W / this.nx; this.dy = H / this.ny;
      this.x0 = box.xmin; this.y0 = box.ymin;
      this.zTop = box.ztop; this.zBot = box.zbot;
      this.h = new Float32Array(this.nx * this.ny);
      this.op = new Uint16Array(this.nx * this.ny);
      this.reset();
    }
    // voids: column index -> [a0, b0, a1, b1, ...], sorted, disjoint pockets of removed material
    // strictly below that column's top h. The column's material is [zBot, h] minus these. Only
    // undercut tools (lollipop, T-slot, dovetail) ever make one - every other cut just lowers h.
    reset() { this.h.fill(this.zTop); this.op.fill(0); this.voids = new Map(); this.markAll(); }
    clearDirty() { this.di0 = 1e9; this.di1 = -1; this.dj0 = 1e9; this.dj1 = -1; }
    markAll() { this.di0 = 0; this.di1 = this.nx - 1; this.dj0 = 0; this.dj1 = this.ny - 1; }
    snapshot() { return { h: this.h.slice(), op: this.op.slice(), voids: new Map([...this.voids].map(([k, v]) => [k, v.slice()])) }; }
    restore(s) { this.h.set(s.h); this.op.set(s.op); this.voids = s.voids ? new Map([...s.voids].map(([k, v]) => [k, v.slice()])) : new Map(); this.markAll(); }
    // The column's top was lowered to hz: pockets now at or above it are open to the air, so the
    // real top drops to the bottom of any pocket the new top reached into.
    settleTop(idx, hz) {
      const v = this.voids.get(idx);
      if (!v) return hz;
      let n = v.length;
      while (n > 0 && v[n - 1] >= hz) { if (v[n - 2] < hz) hz = v[n - 2]; n -= 2; }
      if (n === 0) this.voids.delete(idx); else v.length = n;
      return hz < this.zBot ? this.zBot : hz;
    }
    // Remove [a, b] (local z) from one column: lowers the top if it reaches it, otherwise carves
    // or widens a pocket below it. Returns true if anything changed.
    removeRange(idx, a, b, opId) {
      const h = this.h[idx], zb = this.zBot;
      if (a < zb) a = zb;
      if (b <= a || a >= h) return false;
      if (b >= h) { this.h[idx] = this.settleTop(idx, a); this.op[idx] = opId; return true; }
      let v = this.voids.get(idx);
      if (!v) { this.voids.set(idx, [a, b]); this.op[idx] = opId; return true; }
      const out = []; let placed = false;
      for (let k = 0; k < v.length; k += 2) {
        const c = v[k], d = v[k + 1];
        if (d < a) out.push(c, d);
        else if (c > b) { if (!placed) { out.push(a, b); placed = true; } out.push(c, d); }
        else { if (c < a) a = c; if (d > b) b = d; }
      }
      if (!placed) out.push(a, b);
      this.voids.set(idx, out); this.op[idx] = opId;
      return true;
    }

    // Remove everything the tool sweeps between (ax,ay,az) and (bx,by,bz).
    // Exact for the swept envelope of vertical-axis tools whose profile is
    // convex and non-decreasing (flat, ball, bull-nose, cone).
    cut(ax, ay, az, bx, by, bz, T, opId) {
      const R = T.R, h = this.h, nx = this.nx, ny = this.ny, dx = this.dx, dy = this.dy, x0 = this.x0, y0 = this.y0;
      const zmin = az < bz ? az : bz;
      if (zmin >= this.zTop) return;
      let i0 = Math.floor(((ax < bx ? ax : bx) - R - x0) / dx), i1 = Math.floor(((ax > bx ? ax : bx) + R - x0) / dx);
      let j0 = Math.floor(((ay < by ? ay : by) - R - y0) / dy), j1 = Math.floor(((ay > by ? ay : by) + R - y0) / dy);
      if (i0 < 0) i0 = 0; if (j0 < 0) j0 = 0; if (i1 > nx - 1) i1 = nx - 1; if (j1 > ny - 1) j1 = ny - 1;
      if (i0 > i1 || j0 > j1) return;
      const Dx = bx - ax, Dy = by - ay, dz = bz - az, L2 = Dx * Dx + Dy * Dy, R2 = R * R, kind = T.kind;
      const vertical = L2 < 1e-6, planar = dz > -1e-6 && dz < 1e-6;
      const short = L2 < (R * 0.75) * (R * 0.75);
      const zBot = this.zBot, opa = this.op, vd = this.voids;
      let m0 = 1e9, m1 = -1, n0 = 1e9, n1 = -1;
      for (let j = j0; j <= j1; j++) {
        const uy = y0 + (j + 0.5) * dy - ay, row = j * nx;
        for (let i = i0; i <= i1; i++) {
          const idx = row + i, cur = h[idx];
          if (cur <= zmin) continue;
          const ux = x0 + (i + 0.5) * dx - ax;
          let hz;
          if (vertical) {
            const d2 = ux * ux + uy * uy;
            if (d2 > R2) continue;
            hz = zmin + (kind === 0 ? 0 : prof(T, Math.sqrt(d2)));
          } else {
            const uD = ux * Dx + uy * Dy, uu = ux * ux + uy * uy;
            const disc = uD * uD - L2 * (uu - R2);
            if (disc < 0) continue;
            const sq = Math.sqrt(disc);
            let t1 = (uD - sq) / L2, t2 = (uD + sq) / L2;
            if (t1 < 0) t1 = 0; if (t2 > 1) t2 = 1;
            if (t1 > t2) continue;
            const z1 = az + t1 * dz, z2 = az + t2 * dz;
            const lb = z1 < z2 ? z1 : z2;
            if (lb >= cur) continue;
            if (kind === 0) hz = lb;
            else if (planar) {
              let ts = uD / L2; if (ts < t1) ts = t1; else if (ts > t2) ts = t2;
              const d2 = L2 * ts * ts - 2 * uD * ts + uu;
              hz = az + prof(T, Math.sqrt(d2 > 0 ? d2 : 0));
            } else if (short) {
              let ts = uD / L2; if (ts < t1) ts = t1; else if (ts > t2) ts = t2;
              hz = fsw(T, az, dz, L2, uD, uu, ts);
              const a1 = fsw(T, az, dz, L2, uD, uu, t1); if (a1 < hz) hz = a1;
              const a2 = fsw(T, az, dz, L2, uD, uu, t2); if (a2 < hz) hz = a2;
              const tm = 0.5 * (t1 + t2), a3 = fsw(T, az, dz, L2, uD, uu, tm); if (a3 < hz) hz = a3;
            } else {
              let lo = t1, hi = t2;
              for (let it = 0; it < 18; it++) {
                const m1_ = lo + (hi - lo) / 3, m2_ = hi - (hi - lo) / 3;
                if (fsw(T, az, dz, L2, uD, uu, m1_) < fsw(T, az, dz, L2, uD, uu, m2_)) hi = m2_; else lo = m1_;
              }
              hz = fsw(T, az, dz, L2, uD, uu, 0.5 * (lo + hi));
            }
          }
          if (hz < cur) {
            if (hz < zBot) hz = zBot;
            if (hz < cur) {
              h[idx] = vd.size && vd.has(idx) ? this.settleTop(idx, hz) : hz; opa[idx] = opId;
              if (i < m0) m0 = i; if (i > m1) m1 = i; if (j < n0) n0 = j; if (j > n1) n1 = j;
            }
          }
        }
      }
      if (m1 >= 0) {
        if (m0 < this.di0) this.di0 = m0; if (m1 > this.di1) this.di1 = m1;
        if (n0 < this.dj0) this.dj0 = n0; if (n1 > this.dj1) this.dj1 = n1;
      }
    }

    // An undercut tool (T.ucProf: radius against height above the tip, see undercutProfile). At a
    // column whose centre is a horizontal distance d from the tool axis, the tool body covers the
    // heights where its radius is >= d - usually a band with material left above AND below it. For
    // a flat side pass (what these tools almost always do) d is the column's distance to the move,
    // so the removed set is that band at the move's height - exact. For a straight plunge the band
    // just stretches over the plunge's height range - also exact. A move that changes XY and Z
    // together is split into pieces no taller than 0.05mm and treated the same way (over-cuts by
    // at most that). This is why it's fast: no sampling of tool positions along the move.
    cutUndercut(ax, ay, az, bx, by, bz, T, opId) {
      const R = T.Rmax, nx = this.nx, ny = this.ny, dx = this.dx, dy = this.dy, x0 = this.x0, y0 = this.y0;
      // The band only depends on distance from the axis, so it's tabulated once per tool (512 steps
      // across the tool's radius, ~0.005mm apart on a 5mm cutter) instead of recomputed per column.
      if (!T.bandLUT) { const N = 512, lut = []; for (let k = 0; k < N; k++) lut.push(profileBand(T.ucProf, R * k / (N - 1))); T.bandLUT = lut; }
      const lut = T.bandLUT, lk = (lut.length - 1) / R;
      if (Math.min(az, bz) >= this.zTop) return;
      const pieces = Math.max(1, (bx - ax) * (bx - ax) + (by - ay) * (by - ay) > 1e-6 ? Math.min(400, Math.ceil(Math.abs(bz - az) / 0.05)) : 1);
      let m0 = 1e9, m1 = -1, n0 = 1e9, n1 = -1;
      for (let p = 0; p < pieces; p++) {
        const pax = ax + (bx - ax) * p / pieces, pay = ay + (by - ay) * p / pieces, paz = az + (bz - az) * p / pieces;
        const pbx = ax + (bx - ax) * (p + 1) / pieces, pby = ay + (by - ay) * (p + 1) / pieces, pbz = az + (bz - az) * (p + 1) / pieces;
        const zlo = paz < pbz ? paz : pbz, zhi = paz < pbz ? pbz : paz, Dx = pbx - pax, Dy = pby - pay, L2 = Dx * Dx + Dy * Dy;
        let i0 = Math.floor((Math.min(pax, pbx) - R - x0) / dx), i1 = Math.floor((Math.max(pax, pbx) + R - x0) / dx);
        let j0 = Math.floor((Math.min(pay, pby) - R - y0) / dy), j1 = Math.floor((Math.max(pay, pby) + R - y0) / dy);
        if (i0 < 0) i0 = 0; if (j0 < 0) j0 = 0; if (i1 > nx - 1) i1 = nx - 1; if (j1 > ny - 1) j1 = ny - 1;
        for (let j = j0; j <= j1; j++) {
          const uy = y0 + (j + 0.5) * dy - pay;
          for (let i = i0; i <= i1; i++) {
            const ux = x0 + (i + 0.5) * dx - pax;
            let t = L2 > 1e-12 ? (ux * Dx + uy * Dy) / L2 : 0; if (t < 0) t = 0; else if (t > 1) t = 1;
            const ex = ux - t * Dx, ey = uy - t * Dy, d = Math.sqrt(ex * ex + ey * ey);
            if (d > R) continue;
            const band = lut[Math.round(d * lk)], idx = j * nx + i;
            if (!band.length) continue;
            let hit = false;
            for (let k = 0; k < band.length; k += 2) if (this.removeRange(idx, zlo + band[k], zhi + band[k + 1], opId)) hit = true;
            if (hit) { if (i < m0) m0 = i; if (i > m1) m1 = i; if (j < n0) n0 = j; if (j > n1) n1 = j; }
          }
        }
      }
      if (m1 >= 0) {
        if (m0 < this.di0) this.di0 = m0; if (m1 > this.di1) this.di1 = m1;
        if (n0 < this.dj0) this.dj0 = n0; if (n1 > this.dj1) this.dj1 = n1;
      }
    }
  }

  // Heights above the tip where a piecewise-linear profile [[u, r], ...] has radius >= d, as a flat
  // list [u0, u1, u2, u3, ...] of merged intervals.
  function profileBand(prof, d) {
    const out = [];
    const add = (a, b) => { if (b < a) return; const n = out.length; if (n && a <= out[n - 1] + 1e-9) { if (b > out[n - 1]) out[n - 1] = b; } else out.push(a, b); };
    for (let k = 0; k + 1 < prof.length; k++) {
      const u0 = prof[k][0], r0 = prof[k][1], u1 = prof[k + 1][0], r1 = prof[k + 1][1];
      if (r0 >= d && r1 >= d) add(u0, u1);
      else if (r0 >= d || r1 >= d) {
        const uc = u1 - u0 < 1e-12 ? u0 : u0 + (u1 - u0) * (d - r0) / (r1 - r0);
        if (r0 >= d) add(u0, uc); else add(uc, u1);
      }
    }
    return out;
  }

  // Undercut tool shape as radius against height above the tip, from the tip up through the neck
  // to the shank. The neck is what lets it undercut, and a posted file may not say how thin it is
  // (see t.neckGuess / completeTool).
  //   lollipop: a ball of D, then the neck.
  //   slot (T-slot, woodruff, keyseat): a disk D wide and headH tall, then the neck.
  //   dovetail / back chamfer: a cone from D at the tip narrowing upward over headH at the flank
  //     angle, then the neck. (Angle read as the flank's angle from the tool axis, like a chamfer
  //     mill's - UNVERIFIED against a real posted dovetail.)
  function undercutProfile(t) {
    const R = t.D / 2, rn = Math.min(Math.max(t.neckD / 2, 0.05), R * 0.98), rs = Math.max(t.shankD > 0 ? t.shankD / 2 : R, rn);
    const pts = [];
    if (t.ucType === 'lollipop') {
      const tmax = Math.PI - Math.asin(rn / R);
      for (let k = 0; k <= 16; k++) { const th = tmax * k / 16; pts.push([R - R * Math.cos(th), R * Math.sin(th)]); }
    } else if (t.ucType === 'dovetail') {
      const hH = t.headH, top = Math.max(rn, R - hH * Math.tan((t.flank || 45) * Math.PI / 180));
      pts.push([0, R], [hH, top], [hH, rn]);
    } else pts.push([0, R], [t.headH, R], [t.headH, rn]);
    const neckEnd = Math.max(pts[pts.length - 1][0], t.neckL > 0 ? t.neckL : t.stick);
    pts.push([neckEnd, rn]);
    if (rs > rn && t.stick > neckEnd) pts.push([neckEnd, rs], [t.stick, rs]);
    else if (t.stick > neckEnd) pts.push([t.stick, rn]);
    return pts;
  }

  // cut part f0..f1 of move i (feed moves only; rapids do not cut)
  function cutMove(sim, P, simTools, i, f0, f1) {
    if (!P.K[i] || f1 <= f0) return;
    // A move right after a tilted-plane switch has no valid "from" point in the new plane's own
    // coordinates (P.X[i-1] would still be in whatever frame the previous move was in) - safest is
    // to not cut it rather than draw a bogus segment. In practice this never fires: the shop's
    // programs always rapid into position first, and rapids don't cut anyway.
    if (P.PL && i > 0 && P.PL[i - 1] !== P.PL[i]) return;
    const sx = i > 0 ? P.X[i - 1] : P.init.x, sy = i > 0 ? P.Y[i - 1] : P.init.y, sz = i > 0 ? P.Z[i - 1] : P.init.z;
    const ex = P.X[i], ey = P.Y[i], ez = P.Z[i];
    const T = simTools.get(P.TL[i]);
    if (!T) return;
    const cut = T.undercut ? (T.ucProf ? sim.cutUndercut : null) : sim.cut;
    if (!cut) return;
    cut.call(sim, sx + (ex - sx) * f0, sy + (ey - sy) * f0, sz + (ez - sz) * f0,
            sx + (ex - sx) * f1, sy + (ey - sy) * f1, sz + (ez - sz) * f1, T, P.OP[i] + 1);
  }

  /* ---------- Phase 2 of 3+2 support: one HeightSim per tilted plane ----------
     Each plane's moves are already in that plane's own local coordinates (that's what
     G53.1/TCPC means - see docs/NOTES.md), so cutting is the *same* cutMove/HeightSim.cut
     used everywhere else; the only new part is routing each move to the right sim and
     sizing each tilted plane's box from its own moves (we don't have a real stock shape
     for a tilted face - see the parked cylinder/solid-stock discussion in NOTES.md). */

  // Bounding box (mm) of one plane's own moves, preferring feed moves (tighter, matches
  // how the program's overall P.bounds already prefers feed moves over rapids).
  function boxFromMoves(P, planeId, pad) {
    const b = { xmin: Infinity, xmax: -Infinity, ymin: Infinity, ymax: -Infinity, zmin: Infinity, zmax: -Infinity };
    const any = { xmin: Infinity, xmax: -Infinity, ymin: Infinity, ymax: -Infinity, zmin: Infinity, zmax: -Infinity };
    let hasFeed = false, hasAny = false;
    for (let i = 0; i < P.n; i++) {
      if (P.PL[i] !== planeId) continue;
      hasAny = true;
      any.xmin = Math.min(any.xmin, P.X[i]); any.xmax = Math.max(any.xmax, P.X[i]);
      any.ymin = Math.min(any.ymin, P.Y[i]); any.ymax = Math.max(any.ymax, P.Y[i]);
      any.zmin = Math.min(any.zmin, P.Z[i]); any.zmax = Math.max(any.zmax, P.Z[i]);
      if (P.K[i]) {
        hasFeed = true;
        b.xmin = Math.min(b.xmin, P.X[i]); b.xmax = Math.max(b.xmax, P.X[i]);
        b.ymin = Math.min(b.ymin, P.Y[i]); b.ymax = Math.max(b.ymax, P.Y[i]);
        b.zmin = Math.min(b.zmin, P.Z[i]); b.zmax = Math.max(b.zmax, P.Z[i]);
      }
    }
    if (!hasAny) return null;
    const r = hasFeed ? b : any;
    return { xmin: r.xmin - pad, xmax: r.xmax + pad, ymin: r.ymin - pad, ymax: r.ymax + pad, zbot: r.zmin - pad, ztop: r.zmax + pad };
  }

  // One HeightSim per plane actually used by the program. Plane 0 (the base frame) uses the
  // real stock box (box0, from Fusion or the page's guess, same as always); every tilted plane
  // gets a box fitted to its own move extents, padded by `pad` mm (default a generous amount
  // since we have no real stock shape to go on for a tilted face).
  function buildPlaneSims(P, box0, target, pad, onlyIds) {
    if (pad == null) pad = 5;
    let used = new Set(P.PL);
    if (onlyIds) used = new Set([...used].filter(id => onlyIds.has(id)));
    const sims = new Map();
    for (const id of used) {
      const box = id === 0 ? box0 : boxFromMoves(P, id, pad);
      if (!box) continue;
      sims.set(id, new HeightSim(box, target));
    }
    return sims;
  }

  // Cut move i into whichever plane's sim it belongs to. Moves on a plane with no sim
  // (shouldn't happen - buildPlaneSims covers every plane with moves) are silently skipped.
  function cutMoveMulti(sims, P, simTools, i, f0, f1) {
    const sim = sims.get(P.PL[i]);
    if (sim) cutMove(sim, P, simTools, i, f0, f1);
  }

  /* ---------- tri-dexel: one shared-world-frame stock model for real 3+2 jobs ----------
     buildPlaneSims/cutMoveMulti above give each tilted plane its own disconnected local frame -
     correct, but means the workholding fixture (drawn once, in the base/WCS frame) can never line
     up with a tilted plane's stock without per-plane rotation bookkeeping that doesn't exist. This
     section is the fix: express every ALIGNED plane's moves in one shared world frame and cut them
     into a small set of world-axis-aligned HeightSims, so a single mesh (and the existing,
     untouched fixture code) cover every aligned plane at once. See docs/plan for the design.

     Grids are keyed by SIGNED axis direction ('Z+','Z-','Y+','Y-','X+','X-'), not just the 3
     unsigned axes: a real job (O1224) has two planes sharing the Y axis with opposite tool
     directions (id1 axis -Y, id2/5 axis +Y), and a single unsigned "Y grid" can't represent both,
     since HeightSim's h/zTop/zBot convention assumes cutting always proceeds from one fixed side.

     A plane only qualifies if its real tool axis (third column of its rotation matrix) lands
     within tolDeg of a world axis - see classifyPlanes. Planes that don't (a genuinely oblique
     tilt, e.g. O1224's real I80 J90 K0 plane) are left for the caller to render via the ordinary
     buildPlaneSims/cutMoveMulti path instead (buildPlaneSims' new onlyIds parameter, above, exists
     for exactly this: build sims for only the oblique subset). General oblique-axis tri-dexel
     cutting is deliberately out of scope here - see the design plan's "explicitly out of scope". */

  // A plane's real tool axis, in world space: the third column of its rotation matrix (that
  // column is where the plane's own local +Z - the tool axis under G53.1/TCPC - ends up pointing).
  function planeAxisWorld(matrix) { return [matrix[0][2], matrix[1][2], matrix[2][2]]; }

  // Classify every plane as aligned (its tool axis is within tolDeg of a world X/Y/Z axis, in
  // which case it can join tri-dexel) or oblique (falls back to buildPlaneSims/cutMoveMulti).
  // signOf gives each aligned plane's signed axis key, e.g. 'Z+' (plane 0, the base frame, is
  // always aligned and 'Z+' since its matrix is the identity). tolDeg is deliberately tiny - just
  // enough to absorb floating-point rounding on an exact 90 degree multiple, nowhere near a real
  // oblique tilt like 80 degrees.
  function classifyPlanes(planes, tolDeg) {
    if (tolDeg == null) tolDeg = 0.01;
    const alignedIds = new Set(), obliqueIds = new Set(), signOf = new Map();
    for (const p of planes) {
      const ax = planeAxisWorld(p.matrix);
      let maxAbs = 0, idx = 2;
      for (let k = 0; k < 3; k++) { const a = Math.abs(ax[k]); if (a > maxAbs) { maxAbs = a; idx = k; } }
      const angleDeg = Math.acos(Math.min(1, maxAbs)) * 180 / Math.PI;
      const sign = ax[idx] < 0 ? -1 : 1;
      if (angleDeg <= tolDeg) { alignedIds.add(p.id); signOf.set(p.id, `${'XYZ'[idx]}${sign > 0 ? '+' : '-'}`); }
      else obliqueIds.add(p.id);
    }
    return { alignedIds, obliqueIds, signOf };
  }

  // Stopgap for undercut tools (T-slot/dovetail/lollipop) on their own tilted plane: a plane whose
  // moves are cut by ONLY undercut tools never shows any material removed at all (cutMove already
  // no-ops for them), so its separate stock slab just sits there unchanged for the whole program -
  // not wrong, but reads as broken. Returns the set of plane ids where every tool touching that
  // plane is an undercut tool, so the caller can skip drawing a shape it knows is always going to
  // look untouched. The real fix (an undercut tool actually removing material) needs a different
  // stock representation - see docs/NOTES.md and [[project-3plus2-and-undercut-tools]] - this is
  // just "don't show a slab we know is a lie."
  function undercutOnlyPlanes(P) {
    const byNo = new Map(P.tools.map(t => [t.no, t]));
    const allUndercut = new Map();
    for (let i = 0; i < P.n; i++) {
      const pid = P.PL[i], t = byNo.get(P.TL[i]);
      const ok = !!(t && t.undercut);
      if (allUndercut.has(pid)) { if (!ok) allUndercut.set(pid, false); }
      else allUndercut.set(pid, ok);
    }
    const out = new Set();
    for (const [pid, ok] of allUndercut) if (ok) out.add(pid);
    return out;
  }

  // Express every move's endpoint in one shared world frame via its own plane's origin/matrix.
  // Deliberately returns no PL field: cutMove's plane-boundary guard (see cutMove above) exists
  // only because buildPlaneSims' per-plane local sims have no valid cross-plane "from" point -
  // here every move sits in one continuous frame, so every move's "from" point is a genuinely
  // valid world position and that guard must not fire.
  function worldizeMoves(P) {
    const planeMap = new Map(P.planes.map(p => [p.id, p]));
    const n = P.n;
    const Xw = new Float64Array(n), Yw = new Float64Array(n), Zw = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const pl = planeMap.get(P.PL[i]), M = pl.matrix, o = pl.origin;
      const x = P.X[i], y = P.Y[i], z = P.Z[i];
      Xw[i] = o[0] + M[0][0] * x + M[0][1] * y + M[0][2] * z;
      Yw[i] = o[1] + M[1][0] * x + M[1][1] * y + M[1][2] * z;
      Zw[i] = o[2] + M[2][0] * x + M[2][1] * y + M[2][2] * z;
    }
    const pl0 = planeMap.get(P.PL[0]) || planeMap.get(0);
    const M0 = pl0.matrix, o0 = pl0.origin, ix = P.init.x, iy = P.init.y, iz = P.init.z;
    const init = {
      x: o0[0] + M0[0][0] * ix + M0[0][1] * iy + M0[0][2] * iz,
      y: o0[1] + M0[1][0] * ix + M0[1][1] * iy + M0[1][2] * iz,
      z: o0[2] + M0[2][0] * ix + M0[2][1] * iy + M0[2][2] * iz,
    };
    return { n, Xw, Yw, Zw, K: P.K, TL: P.TL, OP: P.OP, init };
  }

  // Re-express a world point/init as a signed grid's own (ax,ay,az) - az is always the "height"
  // HeightSim measures along, oriented (via `sign`) so the tool's real retract direction is +az,
  // matching HeightSim's convention (zTop = uncut reference, cutting only ever lowers h).
  function triPermute(axisIdx, sign, Xw, Yw, Zw, i) {
    if (axisIdx === 2) return [Xw[i], Yw[i], sign * Zw[i]];
    if (axisIdx === 0) return [Yw[i], Zw[i], sign * Xw[i]];
    return [Zw[i], Xw[i], sign * Yw[i]];
  }
  function triPermuteInit(axisIdx, sign, init) {
    if (axisIdx === 2) return { x: init.x, y: init.y, z: sign * init.z };
    if (axisIdx === 0) return { x: init.y, y: init.z, z: sign * init.x };
    return { x: init.z, y: init.x, z: sign * init.y };
  }

  // Build one HeightSim per signed axis direction actually used by an aligned plane. Every grid
  // shares ONE overall world bounding box (every aligned plane's feed-move extent combined) -
  // NOT a box tight to just that grid's own footprint, which would silently produce much finer
  // absolute resolution than `target` calls for and multiply cut cost (found and fixed during the
  // design spike - see docs/plan). Returns everything cutTriDexelMove/fuseTriDexel need:
  // grids (Map<signedKey,HeightSim>), views (Map<signedKey,{X,Y,Z,K,TL,OP,init}> - the same
  // permuted per-grid move data cutMove expects), keyOfMove (per-move signed key, or null for an
  // oblique-plane move), plus the classification result and the shared world box itself.
  function buildTriDexel(P, target, pad, box0, tolDeg) {
    if (pad == null) pad = 5;
    const w = worldizeMoves(P);
    // tolDeg is a SPIKE-ONLY escape hatch (default keeps today's behavior: classifyPlanes' own
    // tiny 0.01deg tolerance, real axis-aligned planes only). Passing a large value (up to ~55,
    // the worst case for "which world axis is closest") snaps EVERY plane to its nearest signed
    // axis instead of leaving non-aligned ones for the separate buildPlaneSims/fusion path - see
    // spike/NOTES3.md for why: a single fixed-axis world grid is categorically wrong for a tool
    // whose real axis is far from that grid's axis (it can delete real material far above a cut,
    // not just round a corner), so tolerant snapping onto tri-dexel's EXISTING per-axis grids
    // (each with the geometry already exactly right for THAT axis) is the safer generalization,
    // not a new single-grid representation.
    const cls = classifyPlanes(P.planes, tolDeg);
    const { alignedIds, obliqueIds, signOf } = cls;
    const n = P.n;
    const keyOfMove = new Array(n).fill(null);
    const usedKeys = new Set();
    for (let i = 0; i < n; i++) {
      const key = signOf.get(P.PL[i]);
      if (!key) continue; // oblique plane, or a plane with no moves - not tri-dexel's problem
      keyOfMove[i] = key; usedKeys.add(key);
    }
    let xmin, xmax, ymin, ymax, zmin, zmax;
    if (box0) {
      // A real stock box (from the Fusion/CIMCO export) is authoritative - use it directly rather
      // than derive one from where tool moves happen to go, and with NO padding at all. The grids
      // start out all-solid across the whole box, so any pad here is a shell of phantom material
      // around the real stock that nothing ever cuts away - it renders as a visibly oversized
      // block. The real stock bounds ARE the material boundary; the tool cannot remove material
      // that was never there, and a move reaching past the edge is correctly clamped by the grid.
      xmin = box0.xmin; xmax = box0.xmax;
      ymin = box0.ymin; ymax = box0.ymax;
      zmin = box0.zbot; zmax = box0.ztop;
    } else {
      xmin = Infinity; xmax = -Infinity; ymin = Infinity; ymax = -Infinity; zmin = Infinity; zmax = -Infinity;
      for (let i = 0; i < n; i++) {
        if (!keyOfMove[i] || !P.K[i]) continue;
        const x = w.Xw[i], y = w.Yw[i], z = w.Zw[i];
        if (x < xmin) xmin = x; if (x > xmax) xmax = x;
        if (y < ymin) ymin = y; if (y > ymax) ymax = y;
        if (z < zmin) zmin = z; if (z > zmax) zmax = z;
      }
      // Pad by the largest PLAUSIBLE tool diameter, not the largest one outright: a mis-parsed tap
      // (e.g. "8-32" thread size read as an 8 inch/203.2mm diameter - the same class of bug as the
      // known numbered-drill-misread-as-inches quirk) must not blow the shared box up to cover a
      // tool that never really cuts. A percentile-by-index degrades to "the max" on a short tool
      // list (this job has 15 tools; index floor(15*0.95)=14 IS the last element), so reject
      // outliers by ratio to the median instead, which stays robust regardless of list length.
      const diams = P.tools.map(t => t.D || 6).filter(d => d > 0).sort((a, b) => a - b);
      const median = diams.length ? diams[Math.floor(diams.length / 2)] : 6;
      const plausible = diams.filter(d => d <= Math.max(median * 5, 25));
      const padD = plausible.length ? plausible[plausible.length - 1] : (diams.length ? diams[diams.length - 1] : 12.7);
      const rpad = Math.max(pad, padD / 2 + 3);
      xmin -= rpad; xmax += rpad; ymin -= rpad; ymax += rpad; zmin -= rpad; zmax += rpad;
    }

    const grids = new Map(), views = new Map();
    for (const key of usedKeys) {
      const axisIdx = 'XYZ'.indexOf(key[0]), sign = key[1] === '+' ? 1 : -1;
      let box;
      if (axisIdx === 2) box = { xmin, xmax, ymin, ymax, zbot: sign > 0 ? zmin : -zmax, ztop: sign > 0 ? zmax : -zmin };
      else if (axisIdx === 0) box = { xmin: ymin, xmax: ymax, ymin: zmin, ymax: zmax, zbot: sign > 0 ? xmin : -xmax, ztop: sign > 0 ? xmax : -xmin };
      else box = { xmin: zmin, xmax: zmax, ymin: xmin, ymax: xmax, zbot: sign > 0 ? ymin : -ymax, ztop: sign > 0 ? ymax : -ymin };
      grids.set(key, new HeightSim(box, target));
      const X = new Float64Array(n), Y = new Float64Array(n), Z = new Float64Array(n);
      for (let i = 0; i < n; i++) { const [ax, ay, az] = triPermute(axisIdx, sign, w.Xw, w.Yw, w.Zw, i); X[i] = ax; Y[i] = ay; Z[i] = az; }
      views.set(key, { X, Y, Z, K: w.K, TL: w.TL, OP: w.OP, init: triPermuteInit(axisIdx, sign, w.init) });
    }
    return {
      Xw: w.Xw, Yw: w.Yw, Zw: w.Zw, K: w.K, TL: w.TL, OP: w.OP,
      alignedIds, obliqueIds, signOf, grids, views, keyOfMove,
      box: { xmin, xmax, ymin, ymax, zmin, zmax },
    };
  }

  // Cut move i into whichever signed grid matches its plane's real tool axis - a no-op for an
  // oblique-plane move (the caller's legacy buildPlaneSims/cutMoveMulti path handles those
  // instead). No new numerical geometry: this always calls the ordinary, unmodified cutMove.
  function cutTriDexelMove(td, P, simTools, i, f0, f1) {
    const key = td.keyOfMove[i];
    if (!key) return;
    cutMove(td.grids.get(key), td.views.get(key), simTools, i, f0, f1);
  }

  // True at a given WORLD point if this one signed grid still calls it solid (outside the grid's
  // own footprint counts as "no information, don't exclude" - the safe default for a grid that
  // simply doesn't cover that area, e.g. a small tilted-plane feature far from another plane's).
  function triSampleSolid(grid, axisIdx, sign, wx, wy, wz) {
    let ax, ay, az;
    if (axisIdx === 2) { ax = wx; ay = wy; az = sign * wz; }
    else if (axisIdx === 0) { ax = wy; ay = wz; az = sign * wx; }
    else { ax = wz; ay = wx; az = sign * wy; }
    const i = Math.floor((ax - grid.x0) / grid.dx), j = Math.floor((ay - grid.y0) / grid.dy);
    if (i < 0 || j < 0 || i > grid.nx - 1 || j > grid.ny - 1) return true;
    const h = grid.h[j * grid.nx + i];
    const EPS = 1e-4;
    return az <= h + EPS && az >= grid.zBot - EPS;
  }

  // Same convention as triSampleSolid, generalized to an oblique plane's own real rotation
  // matrix/origin (buildPlaneSims' local frame) instead of a world-axis permutation - transform
  // the world test point into that local frame first (local = M^T . (world - origin), valid since
  // M is a rotation matrix).
  //
  // CLIPPING (XY): boxFromMoves sizes a plane's box to its own moves' bounding box, which for a
  // perimeter/rim pass can span nearly the whole part even though the pass only actually cuts a
  // thin band within that box. A cell the plane's own cutMove never touched is still at its
  // initial value (op===0, HeightSim.reset()'s marker) and must NOT be trusted as "this plane
  // says empty here" - only a cell this plane's real moves actually cut gets to assert anything;
  // everywhere else, same as outside its box, it has no opinion. (Found and fixed during the
  // 3+2/tri-dexel fusion spike - see spike/NOTES3.md and spike/fusedpipeline.js for the
  // investigation: an unclipped version wrongly excluded ~20% of a real job's stock volume.)
  //
  // CLIPPING (Z): boxFromMoves' zBot/zTop are tightly padded (as little as 0.5mm - see app.js's
  // tiltPad) around THIS plane's own real moves' local Z extent - for a single roughing pass that
  // can be under 1mm thick, nothing like the real stock's actual depth. That's fine for a genuinely
  // local query, but a world-vertical ray (what AND-fusing into one mesh does) does NOT stay
  // within one local Z column when the local frame is tilted - it sweeps across a wide swing of
  // local Z as world Z changes (confirmed on a real job: a 25mm world-Z sweep crossed local Z from
  // ~59 to past 88 while the plane's own real box only spanned 75.98-79.25). HeightSim's "below
  // zBot = empty" rule is correct for a box that IS the real stock's floor (tri-dexel's Z+/X+/etc
  // grids); for an oblique plane's narrow, tightly-padded local box it means only "below the
  // deepest real cut THIS plane ever made" - querying below that is out of this plane's business,
  // not proof there's no material, so it must be "no opinion" too, same as never-cut and
  // out-of-XY-footprint. (Found the same way as the XY clipping bug: traced a real disconnected-
  // looking wall on O1160 to exactly this - a world-vertical scan asking plane 1 about a local Z
  // its own real moves never came near, at an (lx,ly) cell a DIFFERENT, real cut had touched.)
  function obliquePlaneSolid(sim, matrix, origin, wx, wy, wz) {
    const dx = wx - origin[0], dy = wy - origin[1], dz = wz - origin[2];
    const lx = matrix[0][0] * dx + matrix[1][0] * dy + matrix[2][0] * dz;
    const ly = matrix[0][1] * dx + matrix[1][1] * dy + matrix[2][1] * dz;
    const lz = matrix[0][2] * dx + matrix[1][2] * dy + matrix[2][2] * dz;
    const i = Math.floor((lx - sim.x0) / sim.dx), j = Math.floor((ly - sim.y0) / sim.dy);
    if (i < 0 || j < 0 || i > sim.nx - 1 || j > sim.ny - 1) return true;
    const idx = j * sim.nx + i;
    if (sim.op[idx] === 0) return true; // never actually cut by this plane - no opinion
    const EPS = 1e-4;
    if (lz < sim.zBot - EPS) return true; // below this plane's own real cutting range - no opinion, not "empty"
    return lz <= sim.h[idx] + EPS;
  }

  // Boolean-AND every signed grid td has (a world point is solid only if every grid that has an
  // opinion still calls it solid - axes nobody actually cut along impose no constraint), then mesh
  // the result via culled voxel-face meshing: emit a quad only where a solid cell touches a
  // non-solid neighbour. Watertight by construction. Ships intentionally blocky (visible
  // stairstepping) - smoothing this into a proper isosurface is a deferred follow-up, not this
  // function's job. Returns {pos, idx} in the same shape meshFromHeightArray returns.
  //
  // obliqueSims/planeById (both optional, default empty/undefined): a Map<planeId,HeightSim> of
  // genuinely-tilted planes (buildPlaneSims' output, restricted to td.obliqueIds) and the program's
  // plane definitions (for matrix/origin), ANDed in via obliquePlaneSolid so the real oblique
  // fallback joins the SAME fused mesh instead of being drawn as separate disconnected slabs.
  // Omitted, this is 100% unchanged (tri-dexel-only) behaviour.
  function fuseTriDexel(td, target, obliqueSims, planeById) {
    const box = td.box;
    const W = box.xmax - box.xmin, H = box.ymax - box.ymin, D = box.zmax - box.zmin;
    const c = Math.max(W, H, D) / target;
    const nx = Math.max(8, Math.round(W / c)), ny = Math.max(8, Math.round(H / c)), nz = Math.max(8, Math.round(D / c));
    const entries = [...td.grids.entries()].map(([key, grid]) => ({ axisIdx: 'XYZ'.indexOf(key[0]), sign: key[1] === '+' ? 1 : -1, grid }));
    const obliqueEntries = obliqueSims ? [...obliqueSims.entries()].map(([id, sim]) => ({ matrix: planeById.get(id).matrix, origin: planeById.get(id).origin, sim })) : [];
    const occ = new Uint8Array(nx * ny * nz);
    for (let k = 0; k < nz; k++) {
      const wz = box.zmin + (k + 0.5) * c;
      for (let j = 0; j < ny; j++) {
        const wy = box.ymin + (j + 0.5) * c;
        for (let i = 0; i < nx; i++) {
          const wx = box.xmin + (i + 0.5) * c;
          let solid = true;
          for (const e of entries) { if (!triSampleSolid(e.grid, e.axisIdx, e.sign, wx, wy, wz)) { solid = false; break; } }
          if (solid) for (const e of obliqueEntries) { if (!obliquePlaneSolid(e.sim, e.matrix, e.origin, wx, wy, wz)) { solid = false; break; } }
          if (solid) occ[(k * ny + j) * nx + i] = 1;
        }
      }
    }
    const isSolidAt = (i, j, k) => (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) ? false : occ[(k * ny + j) * nx + i] === 1;
    const pos = [], tri = [];
    const pushQuad = (v0, v1, v2, v3) => {
      const base = pos.length / 3;
      for (const v of [v0, v1, v2, v3]) pos.push(v[0], v[1], v[2]);
      tri.push(base, base + 1, base + 2, base, base + 2, base + 3);
    };
    for (let k = 0; k < nz; k++) {
      const z0 = box.zmin + k * c, z1 = z0 + c;
      for (let j = 0; j < ny; j++) {
        const y0 = box.ymin + j * c, y1 = y0 + c;
        for (let i = 0; i < nx; i++) {
          if (!isSolidAt(i, j, k)) continue;
          const x0 = box.xmin + i * c, x1 = x0 + c;
          if (!isSolidAt(i - 1, j, k)) pushQuad([x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [x0, y0, z1]);
          if (!isSolidAt(i + 1, j, k)) pushQuad([x1, y0, z0], [x1, y0, z1], [x1, y1, z1], [x1, y1, z0]);
          if (!isSolidAt(i, j - 1, k)) pushQuad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]);
          if (!isSolidAt(i, j + 1, k)) pushQuad([x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]);
          if (!isSolidAt(i, j, k - 1)) pushQuad([x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]);
          if (!isSolidAt(i, j, k + 1)) pushQuad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]);
        }
      }
    }
    return { pos: Float32Array.from(pos), idx: Uint32Array.from(tri) };
  }

  /* ---------- smooth stock surface ----------
     fuseTriDexel above meshes a yes/no voxel grid, so every face is an axis-aligned cube face and
     sloped walls, holes and radii come out as visible stair steps. Here the same grids give a
     continuous value instead - roughly how far (mm) a point is inside the material along each
     grid's own axis: positive inside, zero on the surface, negative outside - and the surface is
     pulled out where it crosses zero (Surface Nets). Each grid's height is read bilinearly between
     cell centres, so a floor lands at its exact cut depth and a wall blends across one cell
     instead of stepping. Same "every grid must agree it's solid" rule as fuseTriDexel (a minimum
     of the per-grid values), same clipping for oblique planes as obliquePlaneSolid. */

  // arrays (optional): Map of grid key ('Z+', ...) or 'p<planeId>' -> {h, op} to evaluate a
  // different state with the same geometry - the program's finished result, for colouring.
  // A wall running at an angle to a height grid can only change height at cell centres, so it
  // carries a sawtooth up to half a cell deep along its length (measured on O1160's 15deg outer
  // face: +-0.08mm on a face that is really flat). A smooth surface follows that faithfully and the
  // lighting turns it into visible lumps. One 1-2-1 pass in each direction averages the sawtooth
  // out while leaving a step edge where it was (the blur is symmetric) and flat floors untouched -
  // for DISPLAY only, the cutting grids themselves are never modified.
  function blurHeights(h, nx, ny) {
    const t = new Float32Array(h.length), o = new Float32Array(h.length);
    for (let j = 0; j < ny; j++) { const r = j * nx; for (let i = 0; i < nx; i++) t[r + i] = 0.25 * (h[r + (i > 0 ? i - 1 : i)] + 2 * h[r + i] + h[r + (i < nx - 1 ? i + 1 : i)]); }
    for (let j = 0; j < ny; j++) { const r = j * nx, u = (j > 0 ? j - 1 : j) * nx, d = (j < ny - 1 ? j + 1 : j) * nx; for (let i = 0; i < nx; i++) o[r + i] = 0.25 * (t[u + i] + 2 * t[r + i] + t[d + i]); }
    return o;
  }

  function stockField(td, obliqueSims, planeById, arrays) {
    const box = td.box;
    const al = [...td.grids.entries()].map(([key, g]) => {
      const a = arrays && arrays.get(key);
      return { g, axis: 'XYZ'.indexOf(key[0]), sign: key[1] === '+' ? 1 : -1, h: blurHeights(a ? a.h : g.h, g.nx, g.ny), op: a ? a.op : g.op, vd: (a ? a.voids : g.voids) || new Map() };
    });
    const ob = obliqueSims ? [...obliqueSims.entries()].map(([id, sim]) => {
      const a = arrays && arrays.get('p' + id), p = planeById.get(id);
      return { g: sim, m: p.matrix, o: p.origin, h: blurHeights(a ? a.h : sim.h, sim.nx, sim.ny), op: a ? a.op : sim.op, vd: (a ? a.voids : sim.voids) || new Map() };
    }) : [];
    let lastOp = 0;   // op id of the grid that set the most recent value() result (0 = original stock face)
    // Bilinear height between the four nearest cell centres; also records the nearest cell's op and
    // the four corners/weights, in case any of those columns has an undercut pocket.
    const hAt = (e, ax, ay) => {
      const g = e.g, nx = g.nx, mx = nx - 1, my = g.ny - 1;
      let u = (ax - g.x0) / g.dx - 0.5, v = (ay - g.y0) / g.dy - 0.5;
      if (u < 0) u = 0; else if (u > mx) u = mx;
      if (v < 0) v = 0; else if (v > my) v = my;
      let i = Math.floor(u), j = Math.floor(v);
      if (i >= mx) i = mx - 1; if (j >= my) j = my - 1;
      const fu = u - i, fv = v - j, h = e.h, r0 = j * nx + i, r1 = r0 + nx;
      e.near = (fv < 0.5 ? r0 : r1) + (fu < 0.5 ? 0 : 1); e.r0 = r0; e.fu = fu; e.fv = fv;
      return (h[r0] * (1 - fu) + h[r0 + 1] * fu) * (1 - fv) + (h[r1] * (1 - fu) + h[r1 + 1] * fu) * fv;
    };
    // One column's value at local height az, pockets included. bot: whether the grid's zBot is a
    // real floor (aligned grids: it's the stock bottom) or just the edge of what this grid knows
    // (oblique planes - see obliquePlaneSolid's Z clipping: no floor there, no opinion).
    const colVal = (e, idx, az, bot) => {
      let t = e.h[idx] - az; if (bot) { const tb = az - e.g.zBot; if (tb < t) t = tb; }
      const v = e.vd.get(idx);
      if (v) for (let k = 0; k < v.length; k += 2) { const p = v[k] - az > az - v[k + 1] ? v[k] - az : az - v[k + 1]; if (p < t) t = p; }
      return t;
    };
    // The plain bilinear value, or - when any of the four corner columns has a pocket - the
    // bilinear blend of the four columns' own values.
    const withVoids = (e, hv, az, bot) => {
      const vd = e.vd, r0 = e.r0, r1 = r0 + e.g.nx;
      if (!vd.size || !(vd.has(r0) || vd.has(r0 + 1) || vd.has(r1) || vd.has(r1 + 1))) { let t = hv - az; if (bot) { const tb = az - e.g.zBot; if (tb < t) t = tb; } return t; }
      const fu = e.fu, fv = e.fv;
      return (colVal(e, r0, az, bot) * (1 - fu) + colVal(e, r0 + 1, az, bot) * fu) * (1 - fv) + (colVal(e, r1, az, bot) * (1 - fu) + colVal(e, r1 + 1, az, bot) * fu) * fv;
    };
    function value(x, y, z) {
      let f = x - box.xmin, t; lastOp = 0;
      if ((t = box.xmax - x) < f) f = t; if ((t = y - box.ymin) < f) f = t; if ((t = box.ymax - y) < f) f = t;
      if ((t = z - box.zmin) < f) f = t; if ((t = box.zmax - z) < f) f = t;
      for (let k = 0; k < al.length; k++) {
        const e = al[k];
        let ax, ay, az;
        if (e.axis === 2) { ax = x; ay = y; az = e.sign * z; } else if (e.axis === 0) { ax = y; ay = z; az = e.sign * x; } else { ax = z; ay = x; az = e.sign * y; }
        t = withVoids(e, hAt(e, ax, ay), az, true);
        if (t < f) { f = t; lastOp = e.op[e.near]; }
      }
      for (let k = 0; k < ob.length; k++) {
        const e = ob[k], m = e.m, dx = x - e.o[0], dy = y - e.o[1], dz = z - e.o[2], g = e.g;
        const lx = m[0][0] * dx + m[1][0] * dy + m[2][0] * dz, ly = m[0][1] * dx + m[1][1] * dy + m[2][1] * dz, lz = m[0][2] * dx + m[1][2] * dy + m[2][2] * dz;
        const ci = Math.floor((lx - g.x0) / g.dx), cj = Math.floor((ly - g.y0) / g.dy);
        if (ci < 0 || cj < 0 || ci >= g.nx || cj >= g.ny || e.op[cj * g.nx + ci] === 0 || lz < g.zBot) continue;   // no opinion here
        t = withVoids(e, hAt(e, lx, ly), lz, false);
        if (t < f) { f = t; lastOp = e.op[cj * g.nx + ci]; }
      }
      return f;
    }
    // shading gradient width: ~2 cells of the finest grid in play
    let fine = Infinity; for (const e of al.concat(ob)) fine = Math.min(fine, e.g.dx, e.g.dy);
    return { box, value, op: (x, y, z) => { value(x, y, z); return lastOp; }, normalEps: isFinite(fine) ? 2 * fine : 0 };
  }

  // Surface Nets over field.value on a lattice of cell size max(box)/target, one cell of margin
  // round the box so the stock's own faces close. Normals come from the field's gradient rather
  // than averaged faces, so flat floors stay flat right up to a wall.
  function surfaceNets(field, target) {
    const box = field.box, fv = field.value;
    const c = Math.max(box.xmax - box.xmin, box.ymax - box.ymin, box.zmax - box.zmin) / target;
    const Lx = Math.ceil((box.xmax - box.xmin) / c) + 3, Ly = Math.ceil((box.ymax - box.ymin) / c) + 3, Lz = Math.ceil((box.zmax - box.zmin) / c) + 3;
    const x0 = box.xmin - c, y0 = box.ymin - c, z0 = box.zmin - c;
    const F = new Float32Array(Lx * Ly * Lz);
    for (let k = 0, q = 0; k < Lz; k++) { const z = z0 + k * c; for (let j = 0; j < Ly; j++) { const y = y0 + j * c; for (let i = 0; i < Lx; i++, q++) F[q] = fv(x0 + i * c, y, z); } }
    const Cx = Lx - 1, Cy = Ly - 1, Cz = Lz - 1, vid = new Int32Array(Cx * Cy * Cz).fill(-1), pos = [];
    const off = [0, 1, Lx, Lx + 1, Lx * Ly, Lx * Ly + 1, Lx * Ly + Lx, Lx * Ly + Lx + 1];
    const cx = [0, 1, 0, 1, 0, 1, 0, 1], cy = [0, 0, 1, 1, 0, 0, 1, 1], cz = [0, 0, 0, 0, 1, 1, 1, 1];
    const E = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
    const v = new Float32Array(8);
    for (let k = 0; k < Cz; k++) for (let j = 0; j < Cy; j++) for (let i = 0; i < Cx; i++) {
      const p = i + Lx * (j + Ly * k);
      let inside = 0;
      for (let b = 0; b < 8; b++) { v[b] = F[p + off[b]]; if (v[b] > 0) inside++; }
      if (inside === 0 || inside === 8) continue;
      let sx = 0, sy = 0, sz = 0, n = 0;
      for (let e = 0; e < 12; e++) {
        const a = E[e][0], b = E[e][1];
        if ((v[a] > 0) === (v[b] > 0)) continue;
        const t = v[a] / (v[a] - v[b]);
        sx += cx[a] + (cx[b] - cx[a]) * t; sy += cy[a] + (cy[b] - cy[a]) * t; sz += cz[a] + (cz[b] - cz[a]) * t; n++;
      }
      vid[i + Cx * (j + Cy * k)] = pos.length / 3;
      pos.push(x0 + (i + sx / n) * c, y0 + (j + sy / n) * c, z0 + (k + sz / n) * c);
    }
    const idx = [], cube = (i, j, k) => vid[i + Cx * (j + Cy * k)];
    const quad = (a, b, cc, d, flip) => { if (a < 0 || b < 0 || cc < 0 || d < 0) return; if (flip) idx.push(a, d, cc, a, cc, b); else idx.push(a, b, cc, a, cc, d); };
    for (let k = 0; k < Lz; k++) for (let j = 0; j < Ly; j++) for (let i = 0; i < Lx; i++) {
      const p = i + Lx * (j + Ly * k), s = F[p] > 0;
      // winding: normal points from the solid side to the empty side
      if (i < Cx && j > 0 && k > 0 && j < Cy && k < Cz && s !== (F[p + 1] > 0)) quad(cube(i, j - 1, k - 1), cube(i, j, k - 1), cube(i, j, k), cube(i, j - 1, k), !s);
      if (j < Cy && i > 0 && k > 0 && i < Cx && k < Cz && s !== (F[p + Lx] > 0)) quad(cube(i - 1, j, k - 1), cube(i - 1, j, k), cube(i, j, k), cube(i, j, k - 1), !s);
      if (k < Cz && i > 0 && j > 0 && i < Cx && j < Cy && s !== (F[p + Lx * Ly] > 0)) quad(cube(i - 1, j - 1, k), cube(i, j - 1, k), cube(i, j, k), cube(i - 1, j, k), !s);
    }
    // Surface Nets puts each vertex at the average of its cube's edge crossings, which sits up to
    // about half a cell off the real surface on walls and edges. One Newton step along the field's
    // gradient (capped at half a cell) snaps it back onto the surface - crisper edges, and a vertex
    // that is actually where the stock is.
    // Shading uses a wider gradient (normalEps): a wall running at an angle to a height grid can
    // only change height at cell centres, so it carries tiny cell-sized steps along its length -
    // harmless to the shape, but a tight gradient lights every one of them up as a vertical ridge.
    const P = Float32Array.from(pos), nor = new Float32Array(P.length), eps = c * 0.5, cap = c * 0.5, ne = Math.max(c, field.normalEps || 0);
    const grad = (x, y, z, e) => [(fv(x + e, y, z) - fv(x - e, y, z)) / (2 * e), (fv(x, y + e, z) - fv(x, y - e, z)) / (2 * e), (fv(x, y, z + e) - fv(x, y, z - e)) / (2 * e)];
    for (let q = 0; q < P.length; q += 3) {
      let x = P[q], y = P[q + 1], z = P[q + 2];
      const [gx, gy, gz] = grad(x, y, z, eps), g2 = gx * gx + gy * gy + gz * gz;
      if (g2 > 1e-8) {
        const s = fv(x, y, z) / g2; let sx = s * gx, sy = s * gy, sz = s * gz;
        const sl = Math.hypot(sx, sy, sz); if (sl > cap) { sx *= cap / sl; sy *= cap / sl; sz *= cap / sl; }
        P[q] = x -= sx; P[q + 1] = y -= sy; P[q + 2] = z -= sz;
      }
      const [nx, ny, nz] = grad(x, y, z, ne), l = Math.hypot(nx, ny, nz) || 1;
      nor[q] = -nx / l; nor[q + 1] = -ny / l; nor[q + 2] = -nz / l;
    }
    return { pos: P, idx: Uint32Array.from(idx), nor, cell: c };
  }

  // Drop-in smooth counterpart of fuseTriDexel (same arguments), plus the field for colouring.
  function meshTriDexelSmooth(td, target, obliqueSims, planeById) {
    const field = stockField(td, obliqueSims, planeById);
    return Object.assign(surfaceNets(field, target), { field });
  }

  /* ---------- cross-setup stock chaining ----------
     A later setup ("from preceding setup" stock mode) starts from what an earlier setup's
     program actually left behind, not a flat block. Fusion does not expose this shape for that
     stock mode (confirmed empirically - see docs/NOTES.md), so it is computed here: mesh the
     earlier setup's finished height field, move that mesh from its WCS into the later setup's
     WCS, then rasterize it into the later setup's own starting height field. Exact for a flat
     parting plane with no interlocking 3D features visible from both sides (the common two-sided
     case); the same accepted boundary as every other height-field limit in this engine. */

  // Mesh (corner-averaged, same topology as the page's own stock rendering) of one height array.
  // Takes the grid geometry and an explicit height array (not a live sim) so the FINAL result of
  // a finished program can be meshed, independent of whatever the sim's current live state is.
  function meshFromHeightArray(nx, ny, dx, dy, x0, y0, h) {
    const vx = nx + 1, vy = ny + 1, nv = vx * vy;
    const pos = new Float32Array(nv * 3);
    for (let j = 0; j < vy; j++) {
      const ja = j > 0 ? j - 1 : 0, jb = j < ny ? j : ny - 1;
      for (let i = 0; i < vx; i++) {
        const ia = i > 0 ? i - 1 : 0, ib = i < nx ? i : nx - 1;
        const z = 0.25 * (h[ja * nx + ia] + h[ja * nx + ib] + h[jb * nx + ia] + h[jb * nx + ib]);
        const k = (j * vx + i) * 3;
        pos[k] = x0 + i * dx; pos[k + 1] = y0 + j * dy; pos[k + 2] = z;
      }
    }
    const idx = new Uint32Array(nx * ny * 6); let q = 0;
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const a = j * vx + i, b = a + 1, c = a + vx, d = c + 1;
      idx[q++] = a; idx[q++] = b; idx[q++] = d; idx[q++] = a; idx[q++] = d; idx[q++] = c;
    }
    return { pos, idx };
  }

  // Rigid transform of a flat [x,y,z,...] position array from one setup's WCS into another's.
  // wcs shape matches the exported job/setup JSON: {origin:[x,y,z] mm, x:[..], y:[..], z:[..]}
  // (unit axis vectors) - pass {origin: wcs.originMM, x: wcs.x, y: wcs.y, z: wcs.z}.
  function transformPoints(pos, fromWcs, toWcs) {
    const [ox, oy, oz] = fromWcs.origin, [bx, by, bz] = toWcs.origin;
    const fx_ = fromWcs.x, fy_ = fromWcs.y, fz_ = fromWcs.z, tx_ = toWcs.x, ty_ = toWcs.y, tz_ = toWcs.z;
    const out = new Float32Array(pos.length);
    for (let i = 0; i < pos.length; i += 3) {
      const px = pos[i], py = pos[i + 1], pz = pos[i + 2];
      const wx = ox + fx_[0] * px + fy_[0] * py + fz_[0] * pz;
      const wy = oy + fx_[1] * px + fy_[1] * py + fz_[1] * pz;
      const wz = oz + fx_[2] * px + fy_[2] * py + fz_[2] * pz;
      const dx = wx - bx, dy = wy - by, dz = wz - bz;
      out[i] = tx_[0] * dx + tx_[1] * dy + tx_[2] * dz;
      out[i + 1] = ty_[0] * dx + ty_[1] * dy + ty_[2] * dz;
      out[i + 2] = tz_[0] * dx + tz_[1] * dy + tz_[2] * dz;
    }
    return out;
  }

  // Rasterize a triangle mesh (already in sim's local frame) into sim.h as its STARTING surface -
  // call right after sim.reset(), before any of this setup's own moves are cut. Software
  // Z-buffer style: per triangle, walk only the grid cells under its own bounding box (cheap for
  // a rigid transform between similarly-scaled setups), take the highest surface per cell where
  // more than one triangle covers it. Cells the mesh never reaches are left at the default
  // (zTop, i.e. "no prior data here, assume solid") - the natural, safe fallback.
  // Returns the fraction of the box actually covered, so a caller can warn if that's suspiciously
  // low (a sign the WCS transform put the two setups in the wrong place relative to each other).
  // emptyOutside: columns the mesh never covers hold no material (a stock shape's own footprint),
  // instead of keeping what the sim held before (a previous setup's result laid over a box).
  function seedHeightSim(sim, pos, idx, emptyOutside) {
    const nx = sim.nx, ny = sim.ny, dx = sim.dx, dy = sim.dy, x0 = sim.x0, y0 = sim.y0;
    const touched = new Uint8Array(nx * ny);
    const nt = idx.length / 3;
    for (let t = 0; t < nt; t++) {
      const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3;
      const x0v = pos[a], y0v = pos[a + 1], z0v = pos[a + 2];
      const x1v = pos[b], y1v = pos[b + 1], z1v = pos[b + 2];
      const x2v = pos[c], y2v = pos[c + 1], z2v = pos[c + 2];
      let i0 = Math.floor((Math.min(x0v, x1v, x2v) - x0) / dx), i1 = Math.floor((Math.max(x0v, x1v, x2v) - x0) / dx);
      let j0 = Math.floor((Math.min(y0v, y1v, y2v) - y0) / dy), j1 = Math.floor((Math.max(y0v, y1v, y2v) - y0) / dy);
      if (i0 < 0) i0 = 0; if (j0 < 0) j0 = 0; if (i1 > nx - 1) i1 = nx - 1; if (j1 > ny - 1) j1 = ny - 1;
      if (i0 > i1 || j0 > j1) continue;
      const denom = (y1v - y2v) * (x0v - x2v) + (x2v - x1v) * (y0v - y2v);
      if (Math.abs(denom) < 1e-9) continue;
      for (let j = j0; j <= j1; j++) {
        const py = y0 + (j + 0.5) * dy;
        for (let i = i0; i <= i1; i++) {
          const px = x0 + (i + 0.5) * dx;
          const wa = ((y1v - y2v) * (px - x2v) + (x2v - x1v) * (py - y2v)) / denom;
          const wb = ((y2v - y0v) * (px - x2v) + (x0v - x2v) * (py - y2v)) / denom;
          const wc = 1 - wa - wb;
          if (wa < -1e-6 || wb < -1e-6 || wc < -1e-6) continue;
          const z = wa * z0v + wb * z1v + wc * z2v;
          const k = j * nx + i;
          if (!touched[k] || z > sim.h[k]) { sim.h[k] = z; touched[k] = 1; }
        }
      }
    }
    let n = 0;
    for (let k = 0; k < sim.h.length; k++) if (touched[k]) { n++; sim.h[k] = Math.min(sim.zTop, Math.max(sim.zBot, sim.h[k])); } else if (emptyOutside) sim.h[k] = sim.zBot;
    sim.markAll();
    return n / touched.length;
  }

  /* ---------- sample programs ---------- */
  const fx = n => { const s = String(+n.toFixed(3)); return s.includes('.') ? s : s + '.'; };

  function demoProgram() {
    const L = [];
    const G = s => L.push(s);
    G('%'); G('O1001 (FLOOR SIM DEMO)');
    G('(Stock 100 x 70 x 20, WCS at stock centre, Z0 at top)');
    G('(T1  D=10. CR=0. - ZMIN=-7.8 - FLAT END MILL)');
    G('(T2  D=6. CR=0. - ZMIN=-8. - FLAT END MILL)');
    G('(T3  D=5. CR=0. - ZMIN=-14. - DRILL)');
    G('(T4  D=12. CR=0. - ZMIN=-5. - CHAMFER MILL)');
    G('(T5  D=6. CR=3. - ZMIN=-1.5 - BALL END MILL)');
    G('G90 G94 G17 G21 G49 G40 G80');
    // --- op 1: roughing
    G('(2D Pocket - Rough)'); G('T1 M6'); G('S8000 M3'); G('G54'); G('G0 X3. Y0.'); G('G43 H1 Z10.'); G('M8');
    const rows = [-12.7, -6.7, -0.7, 5.3, 11.3, 12.7];
    let zPrev = 0;
    for (const zc of [-3.9, -7.8]) {
      G('G0 Z2.'); G('G1 Z' + fx(zPrev + 0.5) + ' F1000.');
      G('G3 X3. Y0. I-3. J0. Z' + fx(zc) + ' F900.');
      G('G3 X3. Y0. I-3. J0.');
      G('G1 X24.7 Y-12.7 F1200.');
      let dir = -1;
      rows.forEach((yy, r) => { if (r > 0) G('G1 Y' + fx(yy)); G('G1 X' + fx(24.7 * dir)); dir = -dir; });
      G('G0 Z2.');
      zPrev = zc;
    }
    G('G0 Z10.'); G('M9'); G('G91 G28 Z0.'); G('G90');
    // --- op 2: finishing
    G('(2D Pocket - Finish)'); G('T2 M6'); G('S10000 M3'); G('G0 X0. Y-15.'); G('G43 H2 Z10.'); G('M8'); G('G0 Z2.');
    G('G1 Z-7.5 F600.'); G('G1 Z-8. F300.');
    const frows = [-15, -11, -7, -3, 1, 5, 9, 13, 15];
    let d2 = 1;
    G('G1 X' + fx(27 * d2) + ' F800.');
    frows.forEach((yy, r) => { if (r > 0) G('G1 Y' + fx(yy)); d2 = -d2; G('G1 X' + fx(27 * d2)); });
    G('G1 Y-15.'); G('G1 X27.'); G('G1 Y15.'); G('G1 X-27.'); G('G1 Y-15.');
    G('G0 Z10.'); G('M9'); G('G91 G28 Z0.'); G('G90');
    // --- op 3: drilling
    G('(Drill 5 mm holes)'); G('T3 M6'); G('S3500 M3'); G('G0 X40. Y25.'); G('G43 H3 Z10.'); G('M8');
    G('G98 G83 X40. Y25. Z-14. R2. Q3. F250.'); G('X-40.'); G('Y-25.'); G('X40.'); G('G80'); G('M9');
    // --- op 4: chamfer, using R-word arcs
    G('(Chamfer pocket edge)'); G('T4 M6'); G('S6000 M3'); G('G0 X0. Y-14.'); G('G43 H4 Z10.'); G('M8'); G('G0 Z2.');
    G('G1 Z-5. F500.'); G('G1 X24. F900.'); G('G3 X26. Y-12. R2.'); G('G1 Y12.'); G('G3 X24. Y14. R2.');
    G('G1 X-24.'); G('G3 X-26. Y12. R2.'); G('G1 Y-12.'); G('G3 X-24. Y-14. R2.'); G('G1 X0.');
    G('G0 Z10.'); G('M9');
    // --- op 5: ball-nose helical grooves
    G('(3D groove - helical entry)'); G('T5 M6'); G('S9000 M3'); G('G0 X45.5 Y0.'); G('G43 H5 Z10.'); G('M8'); G('G0 Z2.');
    G('G1 Z0.5 F500.'); G('G3 X45.5 Y0. I-5.5 J0. Z-1.5 F400.'); G('G3 X45.5 Y0. I-5.5 J0.'); G('G0 Z2.');
    G('G0 X-34.5 Y0.'); G('G1 Z0.5 F500.'); G('G2 X-34.5 Y0. I-5.5 J0. Z-1.5 F400.'); G('G2 X-34.5 Y0. I-5.5 J0.');
    G('G0 Z10.'); G('M9'); G('M5'); G('G91 G28 Z0.'); G('G90'); G('M30'); G('%');
    return L.join('\n');
  }

  // Dense 3D surfacing, a stand-in for a heavy finishing program.
  function stressProgram() {
    const L = [];
    L.push('(Stress test - ball nose raster over a wavy surface)');
    L.push('(T1  D=6. CR=3. - ZMIN=-5.2 - BALL END MILL)');
    L.push('G90 G94 G17 G21', '(3D Parallel finish)', 'T1 M6', 'S12000 M3', 'G0 X-46. Y-46.', 'G43 H1 Z10.', 'M8', 'G0 Z2.');
    const surf = (x, y) => -3 - 2 * Math.sin(x / 6) * Math.cos(y / 7);
    let dir = 1, first = true;
    for (let y = -46; y <= 46.001; y += 0.9) {
      const xs = [];
      for (let x = -46; x <= 46.001; x += 0.25) xs.push(x);
      if (dir < 0) xs.reverse();
      xs.forEach((x, i) => {
        const s = 'X' + fx(x) + ' Y' + fx(y) + ' Z' + fx(surf(x, y));
        L.push(first && i === 0 ? 'G1 ' + s + ' F1800.' : 'G1 ' + s);
      });
      first = false; dir = -dir;
    }
    L.push('G0 Z10.', 'M9', 'M5', 'M30');
    return L.join('\n');
  }

  return { parseProgram, completeTool, simTool, prof, holderSegments, applyLibrary, typeFromText, parseSetupCsv, applyCsvTools, unzipText, guessFromName,
           HeightSim, cutMove, boxFromMoves, buildPlaneSims, cutMoveMulti, undercutProfile, profileBand, undercutKind,
           planeAxisWorld, classifyPlanes, undercutOnlyPlanes, worldizeMoves, buildTriDexel, cutTriDexelMove, fuseTriDexel, obliquePlaneSolid, stockField, surfaceNets, meshTriDexelSmooth,
           parseStlBinary, parseCimcoSetup, applyCimcoTools, cimcoToFloorsimSetup,
           meshFromHeightArray, transformPoints, seedHeightSim,
           demoProgram, stressProgram, RAPID_MMPM };
})();
if (typeof module !== 'undefined') module.exports = NC;
