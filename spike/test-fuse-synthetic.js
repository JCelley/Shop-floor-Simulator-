// Hand-computed correctness check for fuse.js, independent of any real job data. Two tilted
// planes (rotation about world Y by +20deg and -20deg, both origin at world zero), each with a
// trivially CONSTANT local height (a flat facet), so the expected world crossing at any test
// point can be computed by hand from local = M^T * (world - origin) and checked against what
// crossingWorldZ actually returns.
'use strict';
const { crossingWorldZ, fusePlanesToWorldGrid } = require('./fuse.js');
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
const near = (a, b, eps = 1e-3) => Math.abs(a - b) < eps;

function rotY(deg) {
  const r = deg * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
  return [[c, 0, s], [0, 1, 0], [-s, 0, c]];
}
// A trivial HeightSim-shaped object: constant height everywhere within a huge box.
function constSim(hVal, half) {
  return { x0: -half, y0: -half, dx: 2 * half, dy: 2 * half, nx: 1, ny: 1, h: new Float32Array([hVal]) };
}
// nx=ny=1 degenerates sampleHeightSim's bilinear lookup to always index (0,0) - fine for a
// constant field, but let's use nx=ny=2 instead so the bilinear path is genuinely exercised
// (both corners equal hVal, so the interpolated result is still exactly hVal everywhere).
function constSim2(hVal, half) {
  const h = new Float32Array(4).fill(hVal);
  return { x0: -half, y0: -half, dx: half, dy: half, nx: 2, ny: 2, h };
}

const planeA = { matrix: rotY(20), origin: [0, 0, 0] };
const planeB = { matrix: rotY(-20), origin: [0, 0, 0] };
const simA = constSim2(5, 1000), simB = constSim2(8, 1000);

// ---- hand-computed values (see spike notes / commit message for the by-hand derivation) ----
const wx = 3, wy = 2;
const expectedA = 4.2292, expectedB = 9.6051;

const gotA = crossingWorldZ(planeA, simA, wx, wy, -1000, 1000, 40);
const gotB = crossingWorldZ(planeB, simB, wx, wy, -1000, 1000, 40);
ok(gotA !== null && near(gotA, expectedA, 0.01), `plane A crossing at (3,2): expected ~${expectedA}, got ${gotA}`);
ok(gotB !== null && near(gotB, expectedB, 0.01), `plane B crossing at (3,2): expected ~${expectedB}, got ${gotB}`);

// ---- fusion picks the SHALLOWER (min world Z) of the two overlapping planes ----
const box = { xmin: 2, xmax: 4, ymin: 1, ymax: 3, zbot: -50, ztop: 50 };
const fused = fusePlanesToWorldGrid([
  { matrix: planeA.matrix, origin: planeA.origin, sim: simA },
  { matrix: planeB.matrix, origin: planeB.origin, sim: simB },
], box, 4, 40);
// the grid cell nearest (3,2) should read close to plane A's crossing (the deeper of the two)
let bi = Math.round((wx - fused.x0) / fused.dx - 0.5), bj = Math.round((wy - fused.y0) / fused.dy - 0.5);
bi = Math.min(Math.max(bi, 0), fused.nx - 1); bj = Math.min(Math.max(bj, 0), fused.ny - 1);
const fusedVal = fused.h[bj * fused.nx + bi];
ok(near(fusedVal, expectedA, 0.05), `fused grid picks plane A (the deeper cut) near (3,2): expected ~${expectedA}, got ${fusedVal}`);

// ---- a column no plane covers at all stays at the untouched stock top (box.ztop) ----
const farBox = { xmin: 1000, xmax: 1002, ymin: 1000, ymax: 1002, zbot: -50, ztop: 50 };
const noSim = constSim2(5, 1); // a tiny box, nowhere near (1001,1001)
const fusedFar = fusePlanesToWorldGrid([{ matrix: planeA.matrix, origin: planeA.origin, sim: noSim }], farBox, 4, 40);
ok(fusedFar.h.every(v => v === farBox.ztop), 'a column no plane reaches stays at the untouched stock top, not zbot');

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
