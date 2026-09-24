// Render O1160's sim result (green) overlaid with the REAL finished PART.stl (orange), with two
// marker spheres at the exact XY of the two anomaly clusters found by diagnose-badregion.js:
//  RED   = the "gouge" cluster (x=-18.80, y=-24.59) - sim removed too much material, unexplained.
//  YELLOW = the "extra material" cluster (x=42.66, y=24.37) - sim has more material than the real
//           part there; John asked to see this before deciding if it's the vise-held section
//           (it sits near the stock's Z TOP, 88.04mm, not the bottom - unexpected if so).
// Marker Z is placed at the SIM surface height so John can see exactly where on the sim mesh it is.
'use strict';
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const NC = require(path.join(ROOT, 'src', 'engine.js'));
const { chromium } = require(path.join(ROOT, 'node_modules', 'playwright'));
const DIR = 'G:\\Shared drives\\APW\\Posted Programs - UNPROVEN\\';

const real = NC.parseProgram(fs.readFileSync(DIR + 'O1160.NC', 'utf8'));
const setupText = fs.readFileSync(DIR + 'O1160.setup', 'utf8');
const stockBuf = fs.readFileSync(DIR + 'O1160_STOCK.stl');
const partBuf = fs.readFileSync(DIR + 'O1160_PART.stl');
const parsed = NC.parseCimcoSetup(setupText);
NC.applyCimcoTools(parsed, real.tools);
const meshes = { stock: NC.parseStlBinary(stockBuf), part: NC.parseStlBinary(partBuf) };
const result = NC.cimcoToFloorsimSetup(parsed, meshes, 'O1160');
const s = result.setup;
const stockBox = { xmin: s.stock.xmin, xmax: s.stock.xmax, ymin: s.stock.ymin, ymax: s.stock.ymax, zbot: s.stock.zmin, ztop: s.stock.zmax };
const partMesh = result.partMesh;

const target = 200; // lower res for a screenshot-only render, comparison already done at 360 elsewhere
const td = NC.buildTriDexel(real, target, 5, stockBox, 60);
const simTools = new Map(real.tools.map(t => [t.no, NC.simTool(t)]));
for (let i = 0; i < real.n; i++) {
  if (!real.K[i]) continue;
  const T = simTools.get(real.TL[i]);
  if (!T || T.undercut) continue;
  NC.cutTriDexelMove(td, real, simTools, i, 0, 1);
}
const { pos, idx } = NC.fuseTriDexel(td, target);

const markers = [
  { pos: [-18.80, -24.59, 65.92], color: 0xff2222, r: 3.2 }, // gouge cluster
  { pos: [42.66, 24.37, 87.13], color: 0xffcc00, r: 3.2 },   // extra-material cluster
];

const data = {
  sim: { pos: Array.from(pos), idx: Array.from(idx) },
  part: { pos: Array.from(partMesh.pos), idx: Array.from(partMesh.idx) },
  box: stockBox,
  markers,
};

(async () => {
  const url = 'file://' + path.join(__dirname, 'render-heldstock.html').replace(/\\/g, '/');
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1100, height: 850 } });
  page.on('pageerror', e => console.log('pageerror:', e.message));
  await page.addInitScript(d => { window.__FUSED_DATA = d; }, data);
  for (const angle of [0, 1, 2]) {
    await page.goto(url + '?angle=' + angle);
    await page.waitForFunction(() => window.__rendered === true, { timeout: 20000 });
    await page.screenshot({ path: path.join(__dirname, `out-heldstock-o1160-${angle}.png`) });
  }
  await browser.close();
  console.log('done - red = gouge cluster, yellow = extra-material cluster');
})().catch(e => { console.error(e); process.exit(1); });
