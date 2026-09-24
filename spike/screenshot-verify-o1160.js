'use strict';
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const { chromium } = require(path.join(ROOT, 'node_modules', 'playwright'));

const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'out-verify-realpipeline-o1160.json'), 'utf8'));

(async () => {
  const url = 'file://' + path.join(__dirname, 'render.html').replace(/\\/g, '/');
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  page.on('pageerror', e => console.log('pageerror:', e.message));
  await page.addInitScript(d => { window.__FUSED_DATA = d; }, data);
  for (const angle of [0, 1, 2]) {
    await page.goto(url + '?angle=' + angle);
    await page.waitForFunction(() => window.__rendered === true, { timeout: 20000 });
    await page.screenshot({ path: path.join(__dirname, `out-verify-o1160-${angle}.png`) });
  }
  await browser.close();
  console.log('done');
})().catch(e => { console.error(e); process.exit(1); });
