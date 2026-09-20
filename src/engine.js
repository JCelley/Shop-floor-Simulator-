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
  const UNDERCUT_RE = /T[- ]?SLOT|DOVETAIL|WOODRUFF|KEYSEAT|LOLLIPOP|UNDERCUT|BACK[- ]?CHAMFER|BACK[- ]?COUNTERBORE|BACK[- ]?SPOT/i;

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
    return t;
  }

  // Simulation tool: the profile function prof(d) is the height of the tool
  // surface above the tip at horizontal distance d from the axis.
  function simTool(t) {
    const R = (t.D || 6) / 2, undercut = !!t.undercut;
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
    const lead = /^\s*(?:(\d+)\/(\d+)|(\d*\.\d+)|(\d+))\s*(MM)?/.exec(s);
    if (lead) {
      const v = lead[1] ? +lead[1] / +lead[2] : (lead[3] ? +lead[3] : +lead[4]);
      t.D = lead[5] ? v : v * sc;
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
      else if (c === '"') q = true;
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
      out.ops.push({ label: String(desc).replace(/^\s*OP\d+\s*\|\s*/i, '').trim(), tool: no });
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
  function planeMatrix(I, J, K) {
    const ci = Math.cos(deg(I)), si = Math.sin(deg(I)), cj = Math.cos(deg(J)), sj = Math.sin(deg(J)), ck = Math.cos(deg(K)), sk = Math.sin(deg(K));
    const Rx = [[1, 0, 0], [0, ci, -si], [0, si, ci]];
    const Ry = [[cj, 0, sj], [0, 1, 0], [-sj, 0, cj]];
    const Rz = [[ck, -sk, 0], [sk, ck, 0], [0, 0, 1]];
    return matMul3(matMul3(Rz, Ry), Rx);
  }

  /* ---------- G-code parser ---------- */
  function parseProgram(text, opts) {
    opts = opts || {};
    const lines = String(text).replace(/\r/g, '').split('\n');
    const X = [], Y = [], Z = [], K = [], F = [], S = [], TL = [], CO = [], OP = [], LN = [], PL = [];
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

    const getTool = no => {
      let t = tools.get(no);
      if (!t) { t = { no, name: no ? 'T' + no : 'No tool selected', type: 'flat', D: 6, rc: 0, defaulted: true }; tools.set(no, t); }
      return t;
    };

    const push = (kind, nx, ny, nz, ln) => {
      if (!init) init = { x: nx, y: ny, z: nz };
      if (forceNewOp || pendingLabel !== null || !ops.length) {
        const t = getTool(tool);
        ops.push({ label: pendingLabel || t.name || ('T' + tool), tool, move: X.length, line: ln });
        pendingLabel = null; forceNewOp = false;
      }
      X.push(nx); Y.push(ny); Z.push(nz); K.push(kind); F.push(feed);
      S.push(spinOn ? spindle : 0); TL.push(tool); CO.push(coolant); OP.push(ops.length - 1); LN.push(ln); PL.push(curPlaneId);
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
      for (const [c, v] of words) {
        if (c === 'G') g.push(v);
        else if (c === 'M') mc.push(Math.round(v));
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
          case 41: case 42: if (!notes.includes(CC_NOTE)) notes.push(CC_NOTE); break;
          default: break;
        }
      }
      if ('F' in a) feed = a.F * k();
      if ('S' in a) spindle = a.S;
      if ('T' in a) pendingTool = Math.round(a.T);
      for (const m of mc) {
        if (m === 3 || m === 4) spinOn = true;
        else if (m === 5) spinOn = false;
        else if (m === 8) coolant |= 1;
        else if (m === 7) coolant |= 2;
        else if (m === 9) coolant = 0;
        else if (m === 88 || m === 494) coolant |= 4;
        else if (m === 89 || m === 495) coolant &= ~4;
      }
      if (mc.includes(6) || toolChange) { tool = pendingTool; getTool(tool); forceNewOp = true; }
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

    // Tilted-plane summary: a specific note when G68.2 planes were found (still not
    // simulated for stock removal - see NOTES.md), otherwise fall back to the old
    // generic warning for any other unaccounted rotary motion.
    if (planes.length > 1) {
      const tilted = PL.filter(p => p !== 0).length;
      notes.push(`Uses ${planes.length - 1} tilted work plane(s) (G68.2/G53.1) across ${tilted} move(s). Stock removal for those is not yet simulated correctly - shown using the base orientation for now.`);
    } else if (sawRotary) {
      warn('Rotary axis moves (A/B/C) are ignored');
    }

    const n = X.length;
    const P = {
      n, lines, ops, warnings, notes, init: init || { x: 0, y: 0, z: 0 },
      X: Float32Array.from(X), Y: Float32Array.from(Y), Z: Float32Array.from(Z),
      K: Uint8Array.from(K), F: Float32Array.from(F), S: Float32Array.from(S),
      TL: Uint16Array.from(TL), CO: Uint8Array.from(CO), OP: Uint16Array.from(OP), LN: Uint32Array.from(LN),
      PL: Uint16Array.from(PL), planes,
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
    for (let i = 0; i < n; i++) {
      const d = Math.hypot(P.X[i] - px, P.Y[i] - py, P.Z[i] - pz);
      const sp = P.K[i] ? (P.F[i] > 0 ? P.F[i] : 500) : RAPID_MMPM;
      tt += d / (sp / 60); P.cumT[i] = tt;
      const bb = P.K[i] ? b : ball;
      bb.xmin = Math.min(bb.xmin, P.X[i]); bb.xmax = Math.max(bb.xmax, P.X[i]);
      bb.ymin = Math.min(bb.ymin, P.Y[i]); bb.ymax = Math.max(bb.ymax, P.Y[i]);
      bb.zmin = Math.min(bb.zmin, P.Z[i]); bb.zmax = Math.max(bb.zmax, P.Z[i]);
      px = P.X[i]; py = P.Y[i]; pz = P.Z[i];
    }
    P.total = tt;
    P.bounds = b.xmin <= b.xmax ? b : ball;
    P.feedBounds = b.xmin <= b.xmax;
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
    reset() { this.h.fill(this.zTop); this.op.fill(0); this.markAll(); }
    clearDirty() { this.di0 = 1e9; this.di1 = -1; this.dj0 = 1e9; this.dj1 = -1; }
    markAll() { this.di0 = 0; this.di1 = this.nx - 1; this.dj0 = 0; this.dj1 = this.ny - 1; }
    snapshot() { return { h: this.h.slice(), op: this.op.slice() }; }
    restore(s) { this.h.set(s.h); this.op.set(s.op); this.markAll(); }

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
      const zBot = this.zBot, opa = this.op;
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
              h[idx] = hz; opa[idx] = opId;
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
    if (!T || T.undercut) return;   // undercut tools (T-slot/dovetail/lollipop) shown as toolpath only
    sim.cut(sx + (ex - sx) * f0, sy + (ey - sy) * f0, sz + (ez - sz) * f0,
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
  function buildPlaneSims(P, box0, target, pad) {
    if (pad == null) pad = 5;
    const used = new Set(P.PL);
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
           HeightSim, cutMove, boxFromMoves, buildPlaneSims, cutMoveMulti, demoProgram, stressProgram, RAPID_MMPM };
})();
if (typeof module !== 'undefined') module.exports = NC;
