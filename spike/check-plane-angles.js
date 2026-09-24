'use strict';
const fs = require('fs'), path = require('path');
const NC = require(path.join(__dirname, '..', 'src', 'engine.js'));
const DIR = 'G:\\Shared drives\\APW\\Posted Programs - UNPROVEN\\';
const real = NC.parseProgram(fs.readFileSync(DIR + 'O1160.NC', 'utf8'));

const defaultCls = NC.classifyPlanes(real.planes, undefined);
const wideCls = NC.classifyPlanes(real.planes, 60);
console.log('default-tolerance aligned:', [...defaultCls.alignedIds].sort((a, b) => a - b));
console.log('default-tolerance oblique:', [...defaultCls.obliqueIds].sort((a, b) => a - b));

const w = NC.worldizeMoves(real);
const planeAxis = new Map(real.planes.map(p => [p.id, NC.planeAxisWorld(p.matrix)]));
const moveCountByPlane = new Map();
for (let i = 0; i < real.n; i++) { if (!real.K[i]) continue; moveCountByPlane.set(real.PL[i], (moveCountByPlane.get(real.PL[i]) || 0) + 1); }

for (const p of real.planes) {
  const a = planeAxis.get(p.id);
  const axLen = Math.hypot(a[0], a[1], a[2]);
  const cosToZ = Math.abs(a[2]) / axLen;
  const angFromZ = Math.acos(Math.min(1, cosToZ)) * 180 / Math.PI;
  const key = wideCls.signOf.get(p.id);
  console.log(`plane ${p.id}: axis (${a.map(v => v.toFixed(4))}) angle-from-Z=${angFromZ.toFixed(2)}deg  snappedTo=${key}  cuttingMoves=${moveCountByPlane.get(p.id) || 0}  defaultAligned=${defaultCls.alignedIds.has(p.id)}`);
}
