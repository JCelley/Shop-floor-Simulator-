// CIMCO scanning cascading post: a .setup text file + binary STOCK/PART/FIXTURE STL files,
// giving real stock/fixture geometry and a real tool+holder database sourced from Fusion's own
// tool numbers rather than parsed out of NC comments. Tested against a real posted sample for
// the real O1224 job (fixtures/cimco/), not invented data - see docs/plan/NOTES.md for how it
// was obtained and hand-verified before this test existed.
const fs = require('fs'), path = require('path');
const NC = require('../src/engine.js');
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };

const DIR = path.join(__dirname, '..', 'fixtures', 'cimco');
const setupText = fs.readFileSync(path.join(DIR, 'O1224.setup'), 'utf8');
const stockBuf = fs.readFileSync(path.join(DIR, 'O1224_STOCK.stl'));
const partBuf = fs.readFileSync(path.join(DIR, 'O1224_PART.stl'));
const fixtureBuf = fs.readFileSync(path.join(DIR, 'O1224_FIXTURE.stl'));

/* ---------- parseCimcoSetup ---------- */
{
  const p = NC.parseCimcoSetup(setupText);
  ok(!!p.wcs && p.wcs.x === 0 && p.wcs.a === 0, 'WCS parsed, real sample is all-zero');
  ok(!!p.stockRef && p.stockRef.unit === 'UI' && /O1224_STOCK\.stl$/.test(p.stockRef.path), 'stockRef parsed: ' + p.stockRef.path);
  ok(!!p.partRef && /O1224_PART\.stl$/.test(p.partRef.path), 'partRef parsed: ' + p.partRef.path);
  ok(!!p.fixtureRef && /O1224_FIXTURE\.stl$/.test(p.fixtureRef.path), 'fixtureRef parsed: ' + p.fixtureRef.path);
  ok(p.tools.length === 15, `real tool count is 15, got ${p.tools.length}`);
  const t45 = p.tools.find(t => t.no === 45);
  ok(!!t45 && t45.fields.D === '0.164', `T45 (the tap) reads D=0.164 - NOT the bogus inches-misread value the NC-comment parser produced. Got: ${t45 && t45.fields.D}`);
  ok(p.holders.size === 15, `one holder entry per tool, got ${p.holders.size}`);
  const h45 = p.holders.get('H45');
  ok(!!h45 && h45.segments.length === 9, `H45 has 9 real segments, got ${h45 && h45.segments.length}`);
}

/* ---------- parseStlBinary ---------- */
{
  const stock = NC.parseStlBinary(stockBuf);
  ok(stock.idx.length / 3 === 12, `real STOCK.stl is 12 triangles (a box), got ${stock.idx.length / 3}`);
  let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity, zmin = Infinity, zmax = -Infinity;
  for (let i = 0; i < stock.pos.length; i += 3) {
    const x = stock.pos[i], y = stock.pos[i + 1], z = stock.pos[i + 2];
    if (x < xmin) xmin = x; if (x > xmax) xmax = x;
    if (y < ymin) ymin = y; if (y > ymax) ymax = y;
    if (z < zmin) zmin = z; if (z > zmax) zmax = z;
  }
  const near = (a, b) => Math.abs(a - b) < 0.01;
  ok(near(xmin, -1.04425) && near(xmax, 1.51575), `raw (inch) stock X bounds match the hand-verified real values, got ${xmin},${xmax}`);
  ok(near(zmin, 2.460945) && near(zmax, 4.440945), `raw (inch) stock Z bounds match the hand-verified real values, got ${zmin},${zmax}`);

  const part = NC.parseStlBinary(partBuf);
  ok(part.idx.length / 3 === 5180, `real PART.stl is 5,180 triangles, got ${part.idx.length / 3}`);
  const fixture = NC.parseStlBinary(fixtureBuf);
  ok(fixture.idx.length / 3 === 117870, `real FIXTURE.stl is 117,870 triangles, got ${fixture.idx.length / 3}`);

  // ASCII STL must be rejected with a clear error, not silently misparsed (v1 scope: binary only).
  // Needs to be >= 84 bytes to actually exercise the ASCII-detection branch, not the too-short one.
  const asciiStl = 'solid test\n' + 'facet normal 0 0 0\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\n'.repeat(2) + 'endsolid test\n';
  let threw = null;
  try { NC.parseStlBinary(Buffer.from(asciiStl)); } catch (e) { threw = e.message; }
  ok(threw && /ASCII/i.test(threw), `ASCII STL throws a clear error instead of misparsing: ${threw}`);
}

/* ---------- cimcoToFloorsimSetup: the shape buildFixtures()/checkSetup() actually read ---------- */
{
  const parsed = NC.parseCimcoSetup(setupText);
  const meshes = { stock: NC.parseStlBinary(stockBuf), part: NC.parseStlBinary(partBuf), fixture: NC.parseStlBinary(fixtureBuf) };
  const result = NC.cimcoToFloorsimSetup(parsed, meshes, 'O1224');
  const s = result.setup;
  ok(s.format === 'floorsim-setup' && s.version === 1, 'output carries the exact format tag the existing pipeline expects');
  const near = (a, b, eps = 0.01) => Math.abs(a - b) < eps;
  ok(near(s.stock.xmin, -26.524) && near(s.stock.xmax, 38.500), `stock box in mm matches the hand-verified real values: ${s.stock.xmin.toFixed(3)}..${s.stock.xmax.toFixed(3)}`);
  ok(near(s.stock.ymin, -21.590) && near(s.stock.ymax, 21.590), `stock box Y in mm: ${s.stock.ymin.toFixed(3)}..${s.stock.ymax.toFixed(3)}`);
  ok(near(s.stock.zmin, 62.508) && near(s.stock.zmax, 112.800), `stock box Z in mm: ${s.stock.zmin.toFixed(3)}..${s.stock.zmax.toFixed(3)}`);
  ok(s.fixtures.length === 1, `exactly one fixture entry (the whole FIXTURE.stl as one body), got ${s.fixtures.length}`);
  ok(s.fixtures[0].positions.length === 117870 * 9, `fixture positions array is the real triangle count worth of floats, got ${s.fixtures[0].positions.length}`);
  ok(s.fixtures[0].indices.length === 117870 * 3, `fixture indices array matches, got ${s.fixtures[0].indices.length}`);
  ok(result.warnings.length === 0, `no A/B/C-rotation warnings on this all-zero real sample, got ${JSON.stringify(result.warnings)}`);
  ok(!!result.partMesh && result.partMesh.pos.length === 5180 * 9, 'partMesh is populated and unit-converted, not wired into any rendering path');
}

/* ---------- applyCimcoTools: real, sane values, not a repeat of the tap-diameter bug ---------- */
{
  const real = NC.parseProgram(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'O1224.NC'), 'utf8'));
  const parsed = NC.parseCimcoSetup(setupText);
  const n = NC.applyCimcoTools(parsed, real.tools);
  ok(n === 15, `all 15 real tools matched by number, got ${n}`);
  const t45 = real.tools.find(t => t.no === 45);
  const near = (a, b, eps = 0.001) => Math.abs(a - b) < eps;
  ok(near(t45.D, 4.1656), `T45 simulates at a sane ~4.17mm diameter (0.164in), not a bogus inches-misread value. Got ${t45.D}`);
  ok(!!t45.holderSegs && t45.holderSegs.length === 9, 'T45 got real holder segments from the CIMCO holder database');
  const t85 = real.tools.find(t => t.no === 85);
  ok(near(t85.D, 12.7) && t85.type === 'bull' && near(t85.rc, 0.762), `T85 (real "1/2 .5 BULL R.03" tool) matches its own name: D=${t85.D} type=${t85.type} rc=${t85.rc}`);
  const t52 = real.tools.find(t => t.no === 52);
  ok(t52.type === 'chamfer' && near(t52.tip, 90, 0.01), `T52 chamfer angle resolves to ~90deg from the post's radian field, got ${t52.tip}`);
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
