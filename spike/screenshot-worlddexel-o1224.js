const path = require('path'), fs = require('fs');
const { chromium } = require(path.join(__dirname, '..', 'node_modules', 'playwright'));
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'out-worlddexel-o1224.json'), 'utf8'));
  await page.addInitScript(d => { window.__FUSED_DATA = d; }, data);
  const url = 'file://' + path.join(__dirname, 'render.html').replace(/\\/g, '/');
  await page.goto(url + '?angle=0');
  await page.waitForFunction(() => window.__rendered === true, { timeout: 15000 });
  await page.screenshot({ path: path.join(__dirname, 'out-worlddexel-o1224-0.png') });
  await browser.close();
  console.log('done');
})().catch(e => { console.error(e); process.exit(1); });
