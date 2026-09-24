// Sanity-check compareToPart.js itself before trusting its verdict on real jobs: a simple flat
// "part" (two triangles forming a flat square at z=10) compared against a sim grid at a KNOWN
// height everywhere - the reported error must exactly equal the known difference.
'use strict';
const { compareToPart } = require('./compareToPart.js');
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
const near = (a, b, eps) => Math.abs(a - b) < (eps === undefined ? 1e-3 : eps);

// Flat square part: corners (0,0,10),(20,0,10),(20,20,10),(0,20,10), two triangles.
const partMesh = {
  pos: new Float32Array([0, 0, 10, 20, 0, 10, 20, 20, 10, 0, 20, 10]),
  idx: new Uint32Array([0, 1, 2, 0, 2, 3]),
};

{
  const nx = 10, ny = 10, dx = 2, dy = 2;
  const grid = { nx, ny, dx, dy, x0: 0, y0: 0, h: new Float32Array(nx * ny).fill(10) }; // matches the real part exactly
  const stats = compareToPart(grid, partMesh);
  ok(stats.count === nx * ny, `every column inside the flat part's footprint is compared, got ${stats.count}`);
  ok(near(stats.meanAbs, 0, 1e-4) && near(stats.maxAbs, 0, 1e-4), `sim matching the real part exactly reports ~0 error, got mean=${stats.meanAbs} max=${stats.maxAbs}`);
}

{
  const nx = 10, ny = 10, dx = 2, dy = 2;
  const grid = { nx, ny, dx, dy, x0: 0, y0: 0, h: new Float32Array(nx * ny).fill(15) }; // 5mm too much material everywhere
  const stats = compareToPart(grid, partMesh);
  ok(near(stats.meanAbs, 5, 1e-4) && near(stats.maxAbs, 5, 1e-4), `sim 5mm off everywhere reports exactly 5mm error, got mean=${stats.meanAbs} max=${stats.maxAbs}`);
}

{
  // A grid extending PAST the part's real footprint (part is 0..20, grid is 0..40) - columns
  // outside the part's mesh must be excluded from the comparison (NaN in err), not silently
  // treated as some default.
  const nx = 20, ny = 10, dx = 2, dy = 2;
  const grid = { nx, ny, dx, dy, x0: 0, y0: 0, h: new Float32Array(nx * ny).fill(10) };
  const stats = compareToPart(grid, partMesh);
  ok(stats.count === 10 * 10, `columns outside the real part's footprint are excluded from the comparison, got ${stats.count} compared out of ${nx * ny} total`);
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
