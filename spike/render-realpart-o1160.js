// Render JUST the real PART.stl (ground truth, CIMCO's CAD-derived finished shape) alone, no sim
// involved at all, to settle whether O1160 really has raised side rails on the left/right edges
// or not - independent of any of this session's sim/fusion code.
'use strict';
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const NC = require(path.join(ROOT, 'src', 'engine.js'));
const { chromium } = require(path.join(ROOT, 'node_modules', 'playwright'));
const DIR = 'G:\\Shared drives\\APW\\Posted Programs - UNPROVEN\\';

const setupText = fs.readFileSync(DIR + 'O1160.setup', 'utf8');
const stockBuf = fs.readFileSync(DIR + 'O1160_STOCK.stl');
const partBuf = fs.readFileSync(DIR + 'O1160_PART.stl');
const parsed = NC.parseCimcoSetup(setupText);
const meshes = { stock: NC.parseStlBinary(stockBuf), part: NC.parseStlBinary(partBuf) };
const result = NC.cimcoToFloorsimSetup(parsed, meshes, 'O1160');
const s = result.setup;
const stockBox = { xmin: s.stock.xmin, xmax: s.stock.xmax, ymin: s.stock.ymin, ymax: s.stock.ymax, zbot: s.stock.zmin, ztop: s.stock.zmax };
const partMesh = result.partMesh;

const data = { sim: { pos: Array.from(partMesh.pos), idx: Array.from(partMesh.idx) }, part: { pos: [], idx: [] }, box: stockBox, markers: [] };

(async () => {
  const url = 'file://' + path.join(__dirname, 'render-heldstock.html').replace(/\\/g, '/');
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1100, height: 850 } });
  page.on('pageerror', e => console.log('pageerror:', e.message));
  await page.addInitScript(d => { window.__FUSED_DATA = d; }, data);
  for (const angle of [0, 1, 2]) {
    await page.goto(url + '?angle=' + angle);
    await page.waitForFunction(() => window.__rendered === true, { timeout: 20000 });
    await page.screenshot({ path: path.join(__dirname, `out-realpart-o1160-${angle}.png`) });
  }
  await browser.close();
  console.log('done');
})().catch(e => { console.error(e); process.exit(1); });
