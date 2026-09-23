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
console.log('contributor at spike:', d.contributors ? d.contributors[worst.j * nx + worst.i] : '(not saved)');
console.log('plane ids:', d.planeIds);
// print a 5x5 neighborhood of contributors and heights around the spike
if (d.contributors) {
  for (let jj = worst.j - 2; jj <= worst.j + 2; jj++) {
    let rowC = '', rowH = '';
    for (let ii = worst.i - 2; ii <= worst.i + 2; ii++) {
      const idx = jj * nx + ii;
      rowC += String(d.contributors[idx]).padStart(4);
      rowH += h[idx].toFixed(1).padStart(8);
    }
    console.log('contrib row', jj, rowC, '   height row', rowH);
  }
}
