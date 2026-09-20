// Cross-setup stock chaining: mesh a finished setup's height field, move it into another
// setup's WCS, stamp it in as that setup's starting stock. Engine-level tests only (pure math);
// tests/chainStockPage.test.js covers the end-to-end page behavior.
const fs = require('fs'), path = require('path');
const NC = require('../src/engine.js');
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
const near = (a, b, t, m) => ok(Math.abs(a - b) <= t, `${m}: got ${a.toFixed(4)} want ${b} ±${t}`);

// ---- identity transform: same WCS in and out must not move anything
{
  const wcs = { origin: [10, -5, 3], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
  const pos = Float32Array.from([1, 2, 3, -4, 5, -6, 0, 0, 0]);
  const out = NC.transformPoints(pos, wcs, wcs);
  let maxDiff = 0; for (let i = 0; i < pos.length; i++) maxDiff = Math.max(maxDiff, Math.abs(pos[i] - out[i]));
  ok(maxDiff < 1e-5, `same WCS in and out is an identity transform (max diff ${maxDiff.toExponential(2)})`);
}

// ---- real flip: the actual WCS from Op_60.floorsim.json (180 deg about Y, origin shifted in Z)
const op60 = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'setups', 'Op_60.floorsim.json'), 'utf8'));
const identity = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
const flip = { origin: op60.wcs.originMM, x: op60.wcs.x, y: op60.wcs.y, z: op60.wcs.z };
ok(Array.isArray(op60.wcs.originMM) && op60.wcs.originMM.length === 3, 'the real fixture has the resolved originMM field');
{
  const pos = Float32Array.from([0, 0, 0, 10, 5, -2]);
  const out = NC.transformPoints(pos, identity, flip);
  // rigid transform: distance between the two points must be preserved
  const d0 = Math.hypot(pos[3] - pos[0], pos[4] - pos[1], pos[5] - pos[2]);
  const d1 = Math.hypot(out[3] - out[0], out[4] - out[1], out[5] - out[2]);
  near(d1, d0, 1e-4, 'a rigid transform preserves distance between points');
  // round trip: identity -> flip -> identity must recover the original points exactly
  const back = NC.transformPoints(out, flip, identity);
  let maxDiff = 0; for (let i = 0; i < pos.length; i++) maxDiff = Math.max(maxDiff, Math.abs(pos[i] - back[i]));
  ok(maxDiff < 1e-3, `round trip through a real flip recovers the original points (max diff ${maxDiff.toExponential(2)})`);
}

// ---- mesh + seed: a simple pyramid-shaped "finished setup A" seeds setup B's starting stock
{
  const nx = 20, ny = 20, dx = 1, dy = 1, x0 = -10, y0 = -10;
  const hA = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const cx = x0 + (i + 0.5) * dx, cy = y0 + (j + 0.5) * dy;
    hA[j * nx + i] = -Math.max(0, 5 - Math.hypot(cx, cy)); // a 5mm-deep conical pocket at the centre
  }
  const meshA = NC.meshFromHeightArray(nx, ny, dx, dy, x0, y0, hA);
  ok(meshA.pos.length === (nx + 1) * (ny + 1) * 3, 'mesh has one vertex per grid corner');
  ok(meshA.idx.length === nx * ny * 6, 'mesh has 2 triangles per cell');

  // seed a FRESH sim with the SAME grid geometry, via identity transform - should reproduce A's
  // own shape closely (mesh -> rasterize round trip through the same grid).
  const simB = new NC.HeightSim({ xmin: x0, xmax: x0 + nx * dx, ymin: y0, ymax: y0 + ny * dy, zbot: -20, ztop: 5 }, 20);
  const tpos = NC.transformPoints(meshA.pos, identity, identity);
  const coverage = NC.seedHeightSim(simB, tpos, meshA.idx);
  ok(coverage > 0.9, `seeding covers almost the whole box (${(coverage * 100).toFixed(0)}%)`);
  let maxDiff = 0; for (let k = 0; k < hA.length; k++) maxDiff = Math.max(maxDiff, Math.abs(simB.h[k] - hA[k]));
  ok(maxDiff < 0.5, `seeded heights closely match the source shape on the same grid (max diff ${maxDiff.toFixed(3)} mm)`);
  ok(simB.h.some(v => v < 4), 'the seeded pocket is actually visible in the new sim (not left at a flat default)');

  // a cell far outside A's footprint (if the grids didn't overlap at all) stays at the default zTop
  const simC = new NC.HeightSim({ xmin: 100, xmax: 120, ymin: 100, ymax: 120, zbot: -20, ztop: 5 }, 20);
  const coverageC = NC.seedHeightSim(simC, tpos, meshA.idx);
  ok(coverageC === 0, `a sim with no overlap at all gets zero coverage (${coverageC})`);
  ok(simC.h.every(v => v === simC.zTop), 'and every cell stays at the safe default (full stock), not some garbage value');
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
