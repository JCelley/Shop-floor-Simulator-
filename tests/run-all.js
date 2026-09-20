// Runs every test suite. Exit code is non-zero if any suite fails.
const fs = require('fs');
const { spawnSync } = require('child_process'), path = require('path');
const root = path.join(__dirname, '..');
const py = ['python3', 'python', 'py'].find(c => spawnSync(c, ['--version']).status === 0);
const hasBrowser = fs.existsSync(path.join(root, 'node_modules', 'playwright'));
const steps = [
  ['build', 'node', ['scripts/build.js']],
  ['engine (parser + stock removal)', 'node', ['tests/engine.test.js']],
  ...(py ? [['fusion export script (math)', py, ['tests/script.test.py']], ['fusion add-in (fake Fusion, real job data)', py, ['tests/addin.test.py']]] : []),
  ['page UI (jsdom, stubbed WebGL)', 'node', ['tests/ui.test.js']],
  ...(hasBrowser ? [['page in a real browser (Playwright/Chromium)', 'node', ['tests/browser.test.js']]] : []),
  ['real OP50 files + placement checks', 'node', ['tests/real2.test.js']],
  ...(py ? [['job file -> page', 'node', ['tests/job.test.js']]] : []),
];
if (!py) console.log('NOTE: no Python found, skipping the Fusion-side tests (install Python 3 to run them).');
if (!hasBrowser) console.log('NOTE: Playwright not installed, skipping the real-browser test (npm install --save-dev playwright && npx playwright install chromium).');
let failed = 0;
for (const [name, cmd, args] of steps) {
  process.stdout.write(`\n=== ${name}\n`);
  const r = spawnSync(cmd, args, { cwd: root, encoding: 'utf8', timeout: 600000 });
  const out = (r.stdout || '') + (r.stderr || '');
  const lines = out.trim().split('\n');
  console.log(r.status === 0 ? 'PASS  ' + lines[lines.length - 1] : 'FAIL\n' + lines.filter(l => /FAIL|Error|error/.test(l)).slice(0, 12).join('\n') + '\n' + lines.slice(-3).join('\n'));
  if (r.status !== 0) failed++;
}
console.log(failed ? `\n${failed} suite(s) FAILED` : '\nALL SUITES PASSED');
process.exit(failed ? 1 : 0);
