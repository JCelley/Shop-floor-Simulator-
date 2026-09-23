const fs = require('fs'), path = require('path');
const d = JSON.parse(fs.readFileSync(path.join(__dirname, 'out-o1160-fused.json'), 'utf8'));
const { nx, ny, dx, dy, x0, y0, h, zTop, zBot } = d;
// Find columns whose height is much higher than the average of their 4 neighbors - a spike.
let worst = null, worstDiff = -1;
for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) {
  const idx = j * nx + i, v = h[idx];
  const nb = (h[idx - 1] + h[idx + 1] + h[idx - nx] + h[idx + nx]) / 4;
  const diff = v - nb;
  if (diff > worstDiff) { worstDiff = diff; worst = { i, j, v, nb }; }
}
console.log('worst spike:', worst, 'diff', worstDiff.toFixed(3));
const wx = x0 + (worst.i + 0.5) * dx, wy = y0 + (worst.j + 0.5) * dy;
console.log('world xy of spike:', wx.toFixed(3), wy.toFixed(3));
console.log('zTop', zTop, 'zBot', zBot);
