// Hand-computed correctness check: a synthetic T-slot cutter (wide head near the tip, narrow
// neck above it - the classic undercut shape) making ONE lateral pass at a fixed depth. Proves
// the multi-interval column can represent the resulting overhang, which HeightSim.cut (a single
// monotonic height per column) fundamentally cannot: it would just set every touched column to
// the same depth, destroying the shelf of material left above the head's cut.
'use strict';
const { cutMoveIntervals } = require('./multidexel.js');
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

// Profile (h measured up from the tip): wide head (r=3) for h in [0,2], then an abrupt step to
// a narrow neck (r=1) for h in [2,20] - a real T-slot/lollipop-style undercut shape.
const profile = [[0, 3], [2, 3], [2, 1], [20, 1]];

const zBot = 0, zTop = 30, zDepth = 10; // the lateral pass runs at a fixed depth of 10
const nx = 20, ny = 20, dx = 1, dy = 1, x0 = -10, y0 = -10;
const grid = new Map();
for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) grid.set(i + ',' + j, [[zBot, zTop]]);

// One lateral pass straight along X at (y=0, z=zDepth) - simulates the tool traveling along
// the bottom of a slot after having plunged in elsewhere (the plunge itself is a separate,
// spatially distant move and is not part of this test).
cutMoveIntervals(grid, nx, ny, dx, dy, x0, y0, -10, 0, zDepth, 10, 0, zDepth, profile, 60);

const colAt = (wx, wy) => grid.get(Math.floor((wx - x0) / dx) + ',' + Math.floor((wy - y0) / dy));

// y=2: within head radius (3) but beyond neck radius (1) - the head clears through here but
// the neck (which runs the rest of the tool's height) never reaches. Expect an OVERHANG: solid
// below the cut, a 2mm gap where the head passed, solid again above (the shelf).
{
  const col = colAt(0, 2);
  ok(col.length === 2, `y=2 (mid-radius): overhang produces 2 solid intervals, got ${JSON.stringify(col)}`);
  if (col.length === 2) {
    ok(near(col[0][0], zBot) && near(col[0][1], zDepth), `y=2: lower interval is [zBot,zDepth]=[0,10], got ${col[0]}`);
    ok(near(col[1][0], zDepth + 2) && near(col[1][1], zTop), `y=2: upper shelf is [zDepth+2,zTop]=[12,30], got ${col[1]}`);
  }
}

// y=0.5: within the neck radius (1) too - the neck reaches all the way up through this column,
// so it's open from the cut depth clear up to the stock's top surface. One interval only.
{
  const col = colAt(0, 0.5);
  ok(col.length === 1 && near(col[0][0], zBot) && near(col[0][1], zDepth),
    `y=0.5 (near centre): fully open down to the pass depth, one interval [0,10], got ${JSON.stringify(col)}`);
}

// y=5: beyond even the head radius (3) - the tool never reaches here at all. Untouched.
{
  const col = colAt(0, 5);
  ok(col.length === 1 && near(col[0][0], zBot) && near(col[0][1], zTop),
    `y=5 (beyond the tool entirely): untouched, full stock [0,30], got ${JSON.stringify(col)}`);
}

// The one thing today's HeightSim.cut (single height per column) can NEVER produce: two
// disjoint solid intervals with a gap between them - i.e. real material both above AND below
// a void. That's exactly what makes this an overhang instead of a simple pocket.
ok(colAt(0, 2).length > 1, "the core claim: a column can end up with material on BOTH sides of a removed band - impossible for a single-height field");

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
