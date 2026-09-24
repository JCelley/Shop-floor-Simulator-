// Hand-computed + regression correctness checks for worlddexel.js's generalized-axis cylinder
// swept-volume math, before trusting it on real data.
'use strict';
const { makeAxisFrame, cylinderZLowAtT, cylinderZLowOverMove, cutMoveWorld } = require('./worlddexel.js');
const NC = require('../src/engine.js');
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
const near = (a, b, eps) => Math.abs(a - b) < (eps === undefined ? 1e-3 : eps);

/* ---------- straight vertical plunge, tool axis = world Z exactly, column ON the axis (d=0) ----
   Hand-derivation in the file's own comment: the deepest point reached must simply be the
   lowest tip position, 5, since the column is always within radius of a purely vertical tool. */
{
  const a = [0, 0, 1];
  const frame = makeAxisFrame(a, [0, 0, 20], [0, 0, -15], 0, 0);
  ok(near(cylinderZLowAtT(frame, 0, 5, 1e6), 20), `t=0: deepest reach is the start tip Z (20), got ${cylinderZLowAtT(frame, 0, 5, 1e6)}`);
  ok(near(cylinderZLowAtT(frame, 1, 5, 1e6), 5), `t=1: deepest reach is the end tip Z (5), got ${cylinderZLowAtT(frame, 1, 5, 1e6)}`);
  const zLow = cylinderZLowOverMove(frame, 5, 1e6, 30);
  ok(zLow !== null && near(zLow, 5, 0.01), `whole move: deepest reach over t is the lowest tip point (5), got ${zLow}`);
}

/* ---------- vertical tool, lateral move, column OFF-axis (radial distance matters) -----------
   Tool radius 5, tip moves sideways at constant Z=10 from x=-20 to x=20 (y=0). Column at
   (0, 3): distance from the path (the X axis) is 3, within radius 5, so the tool DOES reach
   here, and since Z is constant throughout the lateral move, the deepest reach is simply 10 -
   there is no plunging component to go any deeper. */
{
  const a = [0, 0, 1];
  const frame = makeAxisFrame(a, [-20, 0, 10], [40, 0, 0], 0, 3);
  const zLow = cylinderZLowOverMove(frame, 5, 1e6, 30);
  ok(zLow !== null && near(zLow, 10, 0.01), `lateral move at constant Z=10, column within radius: deepest reach is 10, got ${zLow}`);

  // Column at (0, 8): distance 8 > radius 5 - the tool never reaches this column at all.
  const frameFar = makeAxisFrame(a, [-20, 0, 10], [40, 0, 0], 0, 8);
  const zLowFar = cylinderZLowOverMove(frameFar, 5, 1e6, 30);
  ok(zLowFar === null, `column beyond the tool radius is never reached, got ${zLowFar}`);
}

/* ---------- regression: for a vertical tool, must match the EXISTING engine's own analytic
   cutMove exactly (within tolerance) - this is the real correctness bar, not just internal
   self-consistency. Uses a real diagonal move with a real flat tool, several test columns. */
{
  const T = { R: 6, kind: 0, rc: 0, r0: 6, slope: 0, undercut: false }; // flat tool matches worlddexel's plain-cylinder model exactly (kind 0 has no corner rounding)
  const sim = new NC.HeightSim({ xmin: -50, xmax: 50, ymin: -50, ymax: 50, zbot: -20, ztop: 50 }, 200);
  const ax = -30, ay = 5, az = 10, bx = 30, by = -8, bz = 2; // a real diagonal, sloped move
  sim.cut(ax, ay, az, bx, by, bz, T, 1);

  const a = [0, 0, 1];
  const frame0 = makeAxisFrame(a, [ax, ay, az], [bx - ax, by - ay, bz - az], 0, 0);
  const testCols = [[0, 0], [-10, 3], [15, -6], [5, 5]];
  for (const [cx, cy] of testCols) {
    const frame = makeAxisFrame(a, [ax, ay, az], [bx - ax, by - ay, bz - az], cx, cy);
    const gotGeneral = cylinderZLowOverMove(frame, T.R, 1e6, 30);
    const i = Math.floor((cx - sim.x0) / sim.dx), j = Math.floor((cy - sim.y0) / sim.dy);
    const gotExisting = sim.h[j * sim.nx + i]; // sim started at zTop=50 and only this one move has run
    if (gotExisting >= 50 - 1e-6) {
      ok(gotGeneral === null, `column (${cx},${cy}): existing engine says untouched, generalized method agrees (null), got ${gotGeneral}`);
    } else {
      ok(gotGeneral !== null && near(gotGeneral, gotExisting, 0.05), `column (${cx},${cy}): generalized method matches the existing engine's own analytic cut (${gotExisting.toFixed(3)}), got ${gotGeneral === null ? 'null' : gotGeneral.toFixed(3)}`);
    }
  }
}

/* ---------- a genuinely tilted axis, checked by hand ---------------------------------------
   Tool axis tilted 30deg from vertical about world Y: a = (sin30, 0, cos30) = (0.5, 0, 0.86603).
   STATIONARY tool (A=B, a pure "plunge" along its own tilted axis, no lateral travel) at tip
   world origin (0,0,0). Column at (0,0,0) itself (directly under the tip in world XY): by hand,
   h(t,z) with u0=(0,0,0) (since tip=A=(0,0,0) and column=(0,0,z), so u0=(0-0,0-0,0-0)=(0,0,0)
   for z=0 baseline - wait the frame bakes in z already via ez_perp/azComp, so u0 excludes z) -
   with u0=0, h0=0, and since D=0 (stationary), h(t,z) = 0 + z*azComp = z*0.86603 for ANY t. The
   radial distance at column (0,0): w0=u0-h0*a=0, so w(t,z)=z*ezPerp, ezPerp=(-azComp*ax,
   -azComp*ay,1-azComp*az) = (-0.86603*0.5, 0, 1-0.86603*0.86603) = (-0.43301, 0, 0.25). d(z) =
   z*|ezPerp|. |ezPerp| = sqrt(0.43301^2+0.25^2) = sqrt(0.1875+0.0625) = sqrt(0.25) = 0.5. So
   d(z)=0.5*|z|. Need d(z)<=R for R=2: 0.5|z|<=2 -> |z|<=4. Need h(z)=0.86603z in [0,1e6]: z>=0.
   Combined valid z in [0,4]. Deepest reach (min valid z) = 0. */
{
  const a = [0.5, 0, Math.sqrt(3) / 2];
  const frame = makeAxisFrame(a, [0, 0, 0], [0, 0, 0], 0, 0);
  const zLow = cylinderZLowAtT(frame, 0, 2, 1e6);
  ok(zLow !== null && near(zLow, 0, 1e-6), `tilted stationary tool directly under its own tip: deepest reach is the tip itself (z=0), got ${zLow}`);
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
