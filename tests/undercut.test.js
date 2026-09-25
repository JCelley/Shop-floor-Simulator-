// Undercut tools (lollipop, T-slot, dovetail) now really cut. A height-grid column keeps a list of
// pockets below its top (HeightSim.voids), and an undercut tool's removed band at a column is worked
// out exactly from its profile (ball/disk/cone, then the thinner neck) - see cutUndercut. Expected
// values below are worked out by hand from the tool geometry, not read back from the code.
const fs = require('fs'), path = require('path');
const NC = require('../src/engine.js');
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
const near = (a, b, e = 0.02) => Math.abs(a - b) < e;

// ---- name detection and shape type
for (const [name, kind] of [['3/16 LOLLIPOP', 'lollipop'], ['1/4 T-SLOT CUTTER', 'slot'], ['SLOT MILL', 'slot'], ['3/8 DOVETAIL 60DEG', 'dovetail'], ['1/2 WOODRUFF', 'slot']]) {
  const t = { no: 1 }; NC.guessFromName(t, name, false); t.name = name; NC.completeTool(t);
  ok(t.undercut === true && t.ucType === kind, `"${name}" is an undercut tool of shape ${kind} (got ${t.undercut}, ${t.ucType})`);
}
{ const t = { no: 2 }; NC.guessFromName(t, '3/8 BULL .008R 4FL', false); ok(!t.undercut, 'a normal bull-nose mill is not flagged'); }

// ---- profile band: lollipop ball R=5 on a 3mm-radius neck. At 4mm off-axis the ball covers
// heights where R*sin(theta) >= 4 -> u = R -/+ R*cos(asin(0.8)) = 5 -/+ 3 = 2..8. The neck (r=3)
// never reaches 4mm; the 5mm-radius shank above the neck (from 30mm) does.
{
  const p = NC.undercutProfile({ ucType: 'lollipop', D: 10, neckD: 6, shankD: 10, neckL: 30, stick: 40, headH: 10 });
  const b = NC.profileBand(p, 4);
  ok(b.length === 4 && near(b[0], 2) && near(b[1], 8) && near(b[2], 30) && near(b[3], 40), `lollipop at 4mm: ball band 2..8 and shank 30..40 (got ${b.map(v => v.toFixed(2))})`);
  const b2 = NC.profileBand(p, 2.5);
  ok(b2.length === 2 && near(b2[0], 5 - Math.sqrt(25 - 6.25), 0.05) && near(b2[1], 40), `inside the neck radius the whole length from the ball up is covered (got ${b2.map(v => v.toFixed(2))})`);
  ok(NC.profileBand(p, 5.1).length === 0, 'beyond the widest point, nothing');
}

// ---- T-slot side pass: D=10 (R=5), 2mm head, 4mm neck, one pass at Z=-3 along X at Y=0 through
// a block from Z=-10 to 0. At Y=3 only the head reaches -> a pocket from -3 to -1 with material
// above AND below. At Y=1 the neck reaches too -> cut straight up to the top (top drops to -3).
const t = { no: 1, name: 'T-SLOT', undercut: true, D: 10, neckD: 4, headH: 2, stick: 20 }; NC.completeTool(t);
const T = NC.simTool(t);
ok(!t.neckGuess && !t.headGuess && T.ucProf && T.Rmax === 5, 'real neck/head given -> no guess, profile built');
const sim = new NC.HeightSim({ xmin: -20, xmax: 20, ymin: -10, ymax: 10, zbot: -10, ztop: 0 }, 200);
const col = (x, y) => { const i = Math.floor((x - sim.x0) / sim.dx), j = Math.floor((y - sim.y0) / sim.dy), k = j * sim.nx + i; return { h: sim.h[k], v: sim.voids.get(k) || [], op: sim.op[k] }; };
const P = { n: 1, K: Uint8Array.from([1]), X: Float32Array.from([30]), Y: Float32Array.from([0]), Z: Float32Array.from([-3]), TL: Uint16Array.from([1]), OP: Uint16Array.from([0]), init: { x: -30, y: 0, z: -3 } };
NC.cutMove(sim, P, new Map([[1, T]]), 0, 0, 1);   // through the ordinary per-move entry point
let c = col(0, 3);
ok(c.h === 0 && c.v.length === 2 && near(c.v[0], -3) && near(c.v[1], -1) && c.op === 1, `Y=3: top untouched, pocket -3..-1 (got top ${c.h}, pocket ${c.v})`);
c = col(0, 1);
ok(near(c.h, -3) && c.v.length === 0, `Y=1: cut through to -3, no pocket (got top ${c.h})`);
c = col(0, 6);
ok(c.h === 0 && c.v.length === 0 && c.op === 0, 'Y=6: out of reach, untouched');
const snap = sim.snapshot();

// a flat end mill then faces down to -2 over Y=3: it breaks into the pocket, so the top drops to
// the pocket floor (-3) and the pocket is gone
sim.cut(-30, 3, -2, 30, 3, -2, { R: 1, kind: 0, rc: 0, r0: 1, slope: 0 }, 2);
c = col(0, 3);
ok(near(c.h, -3) && c.v.length === 0, `facing into a pocket opens it: top -3, no pocket (got top ${c.h}, pocket ${c.v})`);
// a second, deeper undercut pass merges with the first pocket instead of stacking
sim.restore(snap);
sim.cutUndercut(-30, 0, -4, 30, 0, -4, T, 3);
c = col(0, 3);
ok(c.v.length === 2 && near(c.v[0], -4) && near(c.v[1], -1), `a second pass 1mm lower widens the pocket to -4..-1 (got ${c.v})`);
sim.restore(snap);
c = col(0, 3);
ok(c.v.length === 2 && near(c.v[0], -3), 'snapshot/restore brings the pockets back exactly (scrubbing)');

// ---- a plunge: the band stretches over the plunge's height range
{
  const s2 = new NC.HeightSim({ xmin: -10, xmax: 10, ymin: -10, ymax: 10, zbot: -10, ztop: 0 }, 100);
  s2.cutUndercut(0, 0, 5, 0, 0, -6, T, 1);   // straight down from above the block to Z=-6
  // at 3mm off-axis only the head (r=5) reaches: its 0..2mm band swept from -6 up to +5 -> -6..7,
  // which reaches the top, so the top drops to -6; at 6mm off-axis nothing reaches
  const k3 = Math.floor((0 - s2.y0) / s2.dy) * s2.nx + Math.floor((3 - s2.x0) / s2.dx), k6 = Math.floor((0 - s2.y0) / s2.dy) * s2.nx + Math.floor((6 - s2.x0) / s2.dx);
  ok(near(s2.h[k3], -6, 0.05) && s2.h[k6] === 0, `a plunge cuts the head's band over the whole depth it travels (top ${s2.h[k3].toFixed(3)} at 3mm, ${s2.h[k6]} at 6mm)`);
}

// ---- where the neck size comes from, in order: TOOLGEOM tool parameter, TOOLGEOM shaft section,
// the TOOL line's shaft diameter AD (only if thinner than the cutter), else a labelled guess.
const setupWith = geom => `WCS ID1 X0 Y0 Z0 A0 B0 C0
TOOL 81 "LOLLIPOP MILL" HOLDER=H81 BL=1.4 FL=0.16 D=0.1875 US=UI AD=0.1875 SL=1.16 SD=0.1875 TL=0
${geom}`;
const toolFrom = text => { const p = NC.parseCimcoSetup(text), tools = [{ no: 81, name: '3/16 LOLLIPOP', undercut: true, D: 4.76 }]; NC.applyCimcoTools(p, tools); return tools[0]; };
let t81 = toolFrom(setupWith(''));
ok(t81.neckGuess === true && near(t81.neckD, 0.6 * 0.1875 * 25.4, 0.01), `no TOOLGEOM and AD = D: labelled guess, 60% of the ball (${t81.neckD.toFixed(3)} mm)`);
ok(near(t81.neckL, 1.16 * 25.4, 0.01) && near(t81.stick, 1.4 * 25.4, 0.01), 'neck length from SL, stick-out from BL');
t81 = toolFrom(setupWith('TOOLGEOM 81 TYPE=LOLLIPOP_MILL US=UI D=0.1875 SHD=0.1875 SHAFT=0.11:0.6/0.1875:0.8 P_shoulderDiameter=NA P_neckDiameter=NA'));
ok(!t81.neckGuess && near(t81.neckD, 0.11 * 25.4, 0.01), `the first shaft section thinner than the ball is the neck (${t81.neckD.toFixed(3)} mm)`);
t81 = toolFrom(setupWith('TOOLGEOM 81 TYPE=LOLLIPOP_MILL US=UI D=0.1875 SHAFT=0.11:0.6 P_shoulderDiameter=0.09'));
ok(!t81.neckGuess && near(t81.neckD, 0.09 * 25.4, 0.01), 'a named neck/shoulder parameter wins over the shaft sections');
t81 = toolFrom(setupWith('TOOLGEOM 81 TYPE=LOLLIPOP_MILL US=UI D=0.1875 SHAFT=EMPTY P_shoulderDiameter=0.1875'));
ok(t81.neckGuess === true, 'a "neck" as wide as the cutter is ignored, still a guess');
ok(NC.parseCimcoSetup(setupWith('TOOLGEOM 81 TYPE=X')).tools.length === 1, 'the TOOLGEOM line does not add a second tool');

// ---- real job: O1224's T81 lollipop on tilted plane 7 now actually removes material
const real = NC.parseProgram(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'O1224.NC'), 'utf8'));
const r81 = real.tools.find(x => x.no === 81);
ok(!!r81 && r81.undercut && r81.ucType === 'lollipop', 'T81 in the real job is read as a lollipop');
const sims = NC.buildPlaneSims(real, NC.boxFromMoves(real, 0, 10), 200, 5, new Set([7]));
const simTools = new Map(real.tools.map(x => [x.no, NC.simTool(x)]));
for (let i = 0; i < real.n; i++) NC.cutMoveMulti(sims, real, simTools, i, 0, 1);
const s7 = sims.get(7);
let cut = 0; for (let k = 0; k < s7.op.length; k++) if (s7.op[k]) cut++;
ok(cut > 50, `plane 7's stock is really cut by the lollipop now (${cut} cells, ${s7.voids.size} with pockets under the surface)`);

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
