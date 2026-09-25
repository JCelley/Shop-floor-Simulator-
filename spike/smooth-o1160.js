// Smooth stock surface (stockField + surfaceNets) vs the blocky fuseTriDexel, on the real O1160 job:
// speed at the app's live/settled sizes, accuracy against the real PART.stl, and screenshots.
'use strict';
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const NC = require(path.join(ROOT, 'src', 'engine.js'));
const { binTriangles, partHeightAt } = require('./compareToPart.js');
const job = process.argv[2] || 'O1160';
const DIR = job === 'O1224' ? null : 'G:\\Shared drives\\APW\\Posted Programs - UNPROVEN\\';
const rd = (f, bin) => fs.readFileSync(DIR ? DIR + f : path.join(ROOT, 'fixtures', /\.NC$/.test(f) ? '' : 'cimco', f), bin ? undefined : 'utf8');

const real = NC.parseProgram(rd(job + '.NC'));
const parsed = NC.parseCimcoSetup(rd(job + '.setup'));
NC.applyCimcoTools(parsed, real.tools);
const result = NC.cimcoToFloorsimSetup(parsed, { stock: NC.parseStlBinary(rd(job + '_STOCK.stl', 1)), part: NC.parseStlBinary(rd(job + '_PART.stl', 1)) }, job);
const s = result.setup.stock, stockBox = { xmin: s.xmin, xmax: s.xmax, ymin: s.ymin, ymax: s.ymax, zbot: s.zmin, ztop: s.zmax };
const TOL = 5, target = 360;
const cls = NC.classifyPlanes(real.planes, TOL);
const td = NC.buildTriDexel(real, target, 5, stockBox, TOL);
const sims = NC.buildPlaneSims(real, stockBox, target, 0.5, cls.obliqueIds);
const simTools = new Map(real.tools.map(t => [t.no, NC.simTool(t)]));
for (let i = 0; i < real.n; i++) { if (!real.K[i]) continue; const T = simTools.get(real.TL[i]); if (!T || T.undercut) continue; NC.cutMoveMulti(sims, real, simTools, i, 0, 1); NC.cutTriDexelMove(td, real, simTools, i, 0, 1); }
const planeById = new Map(real.planes.map(p => [p.id, p]));

const time = (label, fn, n = 3) => { fn(); const t0 = Date.now(); let r; for (let k = 0; k < n; k++) r = fn(); console.log(`${label}: ${((Date.now() - t0) / n).toFixed(1)} ms`); return r; };
time('blocky  target 80 (live)   ', () => NC.fuseTriDexel(td, 80, sims, planeById));
time('smooth  target 80 (live)   ', () => NC.meshTriDexelSmooth(td, 80, sims, planeById));
time('blocky  target 140 (settled)', () => NC.fuseTriDexel(td, 140, sims, planeById));
const sm140 = time('smooth  target 140 (settled)', () => NC.meshTriDexelSmooth(td, 140, sims, planeById));
console.log('smooth 140 triangles:', sm140.idx.length / 3);

function compare(mesh, label) {
  const nxg = 360, nyg = Math.round(360 * (stockBox.ymax - stockBox.ymin) / (stockBox.xmax - stockBox.xmin));
  const gs = { nx: nxg, ny: nyg, dx: (stockBox.xmax - stockBox.xmin) / nxg, dy: (stockBox.ymax - stockBox.ymin) / nyg, x0: stockBox.xmin, y0: stockBox.ymin };
  const sb = binTriangles(mesh, gs), pb = binTriangles(result.partMesh, gs);
  let count = 0, sum = 0; const H = [0, 0, 0, 0, 0];
  for (let j = 0; j < nyg; j++) for (let i = 0; i < nxg; i++) {
    const px = gs.x0 + (i + 0.5) * gs.dx, py = gs.y0 + (j + 0.5) * gs.dy;
    const r = partHeightAt(result.partMesh, pb, gs, i, j, px, py); if (r === null) continue;
    const m = partHeightAt(mesh, sb, gs, i, j, px, py); if (m === null) continue;
    const a = Math.abs(m - r); count++; sum += a;
    if (a < 0.2) H[0]++; else if (a < 1) H[1]++; else if (a < 3) H[2]++; else if (a < 10) H[3]++; else H[4]++;
  }
  console.log(`${label}: compared ${count}, mean ${(sum / count).toFixed(3)} mm, <0.2mm ${(100 * H[0] / count).toFixed(1)}%, >=10mm ${(100 * H[4] / count).toFixed(1)}%`);
}
compare(NC.fuseTriDexel(td, 360, sims, planeById), 'blocky 360 vs real part');
compare(NC.meshTriDexelSmooth(td, 360, sims, planeById), 'smooth 360 vs real part');
compare(sm140, 'smooth 140 vs real part');

// screenshots of both at the app's settled size
const { chromium } = require(path.join(ROOT, 'node_modules', 'playwright'));
(async () => {
  const url = 'file://' + path.join(__dirname, 'render.html').replace(/\\/g, '/');
  const browser = await chromium.launch();
  for (const [name, mesh] of [['blocky', NC.fuseTriDexel(td, 140, sims, planeById)], ['smooth', sm140]]) {
    const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
    await page.addInitScript(d => { window.__FUSED_DATA = d; }, { pos: Array.from(mesh.pos), idx: Array.from(mesh.idx), box: stockBox });
    for (const angle of [0, 1]) {
      await page.goto(url + '?angle=' + angle);
      await page.waitForFunction(() => window.__rendered === true, { timeout: 20000 });
      await page.screenshot({ path: path.join(__dirname, `out-${name}-${job}-${angle}.png`) });
    }
    await page.close();
  }
  await browser.close();
  console.log('screenshots written');
})().catch(e => { console.error(e); process.exit(1); });
