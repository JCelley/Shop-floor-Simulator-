// Undercut-shaped tools (T-slot, dovetail, lollipop...) can't be represented by the
// one-height-per-column engine (see docs/NOTES.md). Option A: detect by name, skip stock
// removal for that tool, keep playing its toolpath. Tested against the real O1224 fixture,
// which genuinely uses a lollipop cutter (T81).
const fs = require('fs'), path = require('path');
const NC = require('../src/engine.js');
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };

// ---- name detection
const t1 = { no: 1 }; NC.guessFromName(t1, '3/16 LOLLIPOP', false);
ok(t1.undercut === true, 'guessFromName flags a lollipop cutter as undercut');
const t2 = { no: 2 }; NC.guessFromName(t2, '3/8 BULL .008R 4FL', false);
ok(!t2.undercut, 'a normal bull-nose mill is not flagged');
const t3 = { no: 3 }; NC.guessFromName(t3, '1/4 T-SLOT CUTTER', false);
ok(t3.undercut === true, 'a T-slot cutter is flagged');
const t4 = { no: 4 }; NC.guessFromName(t4, '3/8 DOVETAIL 60DEG', false);
ok(t4.undercut === true, 'a dovetail cutter is flagged');

// ---- simTool carries the flag through, cutMove skips it entirely
NC.completeTool(t1);
const T1 = NC.simTool(t1);
ok(T1.undercut === true, 'simTool carries the undercut flag');
const sim = new NC.HeightSim({ xmin: -10, xmax: 10, ymin: -10, ymax: 10, zbot: -5, ztop: 0 }, 40);
const before = sim.h.slice();
const P = { n: 1, K: Uint8Array.from([1]), X: Float32Array.from([5]), Y: Float32Array.from([0]), Z: Float32Array.from([-3]), TL: Uint16Array.from([1]), OP: Uint16Array.from([0]), init: { x: -5, y: 0, z: -3 } };
NC.cutMove(sim, P, new Map([[1, T1]]), 0, 0, 1);
ok(sim.h.every((v, i) => v === before[i]), 'cutMove leaves the height field untouched for an undercut tool');

// ---- real job: O1224's T81 "3/16 LOLLIPOP" is used and flagged, and the page-level
// warning text (built the same way app.js does) would list exactly that tool.
const real = NC.parseProgram(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'O1224.NC'), 'utf8'));
const t81 = real.tools.find(t => t.no === 81);
ok(!!t81 && /LOLLIPOP/i.test(t81.name), 'T81 in the real job is the lollipop cutter: ' + (t81 && t81.name));
ok(t81 && t81.undercut === true, 'T81 is flagged undercut from the real tool comment');
const usedTools = new Set(real.TL);
ok(usedTools.has(81), 'T81 is actually used by a move in the real program, not just listed in the header');

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
