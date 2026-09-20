// Assembles src/* into ONE self-contained HTML file: dist/nc-floor-sim.html
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..'), rd = p => fs.readFileSync(path.join(root, 'src', p), 'utf8');
// replacer functions (not strings) so "$&" style sequences in the code are never interpreted
const html = rd('index.template.html').replace('/*CSS*/', () => rd('style.css')).replace('/*ENGINE*/', () => rd('engine.js')).replace('/*APP*/', () => rd('app.js'));
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
const out = path.join(root, 'dist', 'nc-floor-sim.html');
fs.writeFileSync(out, html);
console.log('built', path.relative(root, out), Math.round(html.length / 1024) + ' KB');
