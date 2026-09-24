'use strict';
const fs = require('fs'), path = require('path');
const NC = require(path.join(__dirname, '..', 'src', 'engine.js'));
const DIR = 'G:\\Shared drives\\APW\\Posted Programs - UNPROVEN\\';
const real = NC.parseProgram(fs.readFileSync(DIR + 'O1160.NC', 'utf8'));
const w = NC.worldizeMoves(real);

const targets = [
  { label: 'gouge (-18.8,-24.59)', x: -18.80, y: -24.59 },
  { label: 'gouge max-err (32.82,-23.06)', x: 32.82, y: -23.06 },
  { label: 'extra-material (42.66,24.37)', x: 42.66, y: 24.37 },
];

let xminP1 = Infinity, xmaxP1 = -Infinity, yminP1 = Infinity, ymaxP1 = -Infinity;
for (let i = 0; i < real.n; i++) {
  if (!real.K[i] || real.PL[i] !== 1) continue;
  const x = w.Xw[i], y = w.Yw[i];
  if (x < xminP1) xminP1 = x; if (x > xmaxP1) xmaxP1 = x;
  if (y < yminP1) yminP1 = y; if (y > ymaxP1) ymaxP1 = y;
}
console.log('plane 1 XY bbox: x[', xminP1.toFixed(2), ',', xmaxP1.toFixed(2), '] y[', yminP1.toFixed(2), ',', ymaxP1.toFixed(2), ']');

for (const t of targets) {
  let nearest = Infinity, nearestMove = -1;
  for (let i = 0; i < real.n; i++) {
    if (!real.K[i] || real.PL[i] !== 1) continue;
    const d = Math.hypot(w.Xw[i] - t.x, w.Yw[i] - t.y);
    if (d < nearest) { nearest = d; nearestMove = i; }
  }
  console.log(`${t.label}: nearest plane-1 move is #${nearestMove} at distance ${nearest.toFixed(2)}mm (tool T${real.TL[nearestMove]})`);
}
