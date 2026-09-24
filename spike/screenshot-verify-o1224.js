'use strict';
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const { chromium } = require(path.join(ROOT, 'node_modules', 'playwright'));

const full = JSON.parse(fs.readFileSync(path.join(__dirname, 'out-verify-realpipeline-o1224.json'), 'utf8'));
// screenshot-only lower-res mesh - the full one is too large for addInitScript (same issue hit
// earlier this session for O1224's comparison-resolution mesh)
const NC = require(path.join(ROOT, 'src', 'engine.js'));
const real = NC.parseProgram(fs.readFileSync(path.join(ROOT, 'fixtures', 'O1224.NC'), 'utf8'));
const setupText = fs.readFileSync(path.join(ROOT, 'fixtures', 'cimco', 'O1224.setup'), 'utf8');
const stockBuf = fs.readFileSync(path.join(ROOT, 'fixtures', 'cimco', 'O1224_STOCK.stl'));
const parsed = NC.parseCimcoSetup(setupText);
NC.applyCimcoTools(parsed, real.tools);
const result = NC.cimcoToFloorsimSetup(parsed, { stock: NC.parseStlBinary(stockBuf) }, 'O1224');
const s = result.setup;
const stockBox = { xmin: s.stock.xmin, xmax: s.stock.xmax, ymin: s.stock.ymin, ymax: s.stock.ymax, zbot: s.stock.zmin, ztop: s.stock.zmax };
const TRI_DEXEL_TOL_DEG = 5;
const cls = NC.classifyPlanes(real.planes, TRI_DEXEL_TOL_DEG);
const td = NC.buildTriDexel(real, 360, 5, stockBox, TRI_DEXEL_TOL_DEG);
const sims = NC.buildPlaneSims(real, stockBox, 360, 0.5, cls.obliqueIds);
const simTools = new Map(real.tools.map(t => [t.no, NC.simTool(t)]));
for (let i = 0; i < real.n; i++) {
  if (!real.K[i]) continue;
  const T = simTools.get(real.TL[i]);
  if (!T || T.undercut) continue;
  NC.cutMoveMulti(sims, real, simTools, i, 0, 1);
  NC.cutTriDexelMove(td, real, simTools, i, 0, 1);
}
const planeById = new Map(real.planes.map(p => [p.id, p]));
const low = NC.fuseTriDexel(td, 120, sims, planeById);
const data = { pos: Array.from(low.pos), idx: Array.from(low.idx), box: stockBox };

(async () => {
  const url = 'file://' + path.join(__dirname, 'render.html').replace(/\\/g, '/');
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  page.on('pageerror', e => console.log('pageerror:', e.message));
  await page.addInitScript(d => { window.__FUSED_DATA = d; }, data);
  for (const angle of [0, 1, 2]) {
    await page.goto(url + '?angle=' + angle);
    await page.waitForFunction(() => window.__rendered === true, { timeout: 20000 });
    await page.screenshot({ path: path.join(__dirname, `out-verify-o1224-${angle}.png`) });
  }
  await browser.close();
  console.log('done');
})().catch(e => { console.error(e); process.exit(1); });
