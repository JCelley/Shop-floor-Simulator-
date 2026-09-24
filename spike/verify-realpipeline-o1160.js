// Validate the ACTUAL engine.js code path now used by app.js (NC.buildTriDexel + NC.buildPlaneSims
// + NC.fuseTriDexel(td, target, obliqueSims, planeById)) against the real PART.stl - not the spike's
// standalone fusedpipeline.js copy, which could have drifted from what actually got ported into
// engine.js. Triggered by John spotting what looks like missing side walls in the real app vs the
// earlier round-3 screenshot; ground truth (rendered separately, no sim involved) confirms the real
// part DOES have walls on all 4 sides, so this checks whether the real app's pipeline is regressing.
'use strict';
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const NC = require(path.join(ROOT, 'src', 'engine.js'));
const { binTriangles, partHeightAt } = require('./compareToPart.js');
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

const TRI_DEXEL_TOL_DEG = 5;
const cls = NC.classifyPlanes(real.planes, TRI_DEXEL_TOL_DEG);
console.log('aligned:', [...cls.alignedIds].sort((a,b)=>a-b), 'oblique:', [...cls.obliqueIds].sort((a,b)=>a-b));

const target = 360;
const td = NC.buildTriDexel(real, target, 5, stockBox, TRI_DEXEL_TOL_DEG);
const sims = NC.buildPlaneSims(real, stockBox, target, 0.5, cls.obliqueIds);
console.log('tri-dexel grids:', [...td.grids.keys()], 'oblique sims:', [...sims.keys()]);

const simTools = new Map(real.tools.map(t => [t.no, NC.simTool(t)]));
for (let i = 0; i < real.n; i++) {
  if (!real.K[i]) continue;
  const T = simTools.get(real.TL[i]);
  if (!T || T.undercut) continue;
  NC.cutMoveMulti(sims, real, simTools, i, 0, 1);
  NC.cutTriDexelMove(td, real, simTools, i, 0, 1);
}
const planeById = new Map(real.planes.map(p => [p.id, p]));
const { pos, idx } = NC.fuseTriDexel(td, target, sims, planeById);
console.log('mesh:', pos.length / 3, 'verts', idx.length / 3, 'tris');

const nxg = 360, nyg = Math.round(360 * (stockBox.ymax - stockBox.ymin) / (stockBox.xmax - stockBox.xmin));
const gx0 = stockBox.xmin, gy0 = stockBox.ymin, gdx = (stockBox.xmax - stockBox.xmin) / nxg, gdy = (stockBox.ymax - stockBox.ymin) / nyg;
const gridShape = { nx: nxg, ny: nyg, dx: gdx, dy: gdy, x0: gx0, y0: gy0 };
const simMesh = { pos, idx };
const simBins = binTriangles(simMesh, gridShape);
const partBins = binTriangles(partMesh, gridShape);
let count = 0, sumAbs = 0, maxAbs = 0, maxAt = null;
const HIST = [0, 0, 0, 0, 0];
for (let j = 0; j < nyg; j++) {
  const py = gy0 + (j + 0.5) * gdy;
  for (let i = 0; i < nxg; i++) {
    const px = gx0 + (i + 0.5) * gdx;
    const real1 = partHeightAt(partMesh, partBins, gridShape, i, j, px, py);
    if (real1 === null) continue;
    const sim1 = partHeightAt(simMesh, simBins, gridShape, i, j, px, py);
    if (sim1 === null) continue;
    const e = sim1 - real1;
    count++; const ae = Math.abs(e); sumAbs += ae; if (ae > maxAbs) { maxAbs = ae; maxAt = [px.toFixed(1), py.toFixed(1)]; }
    if (ae < 0.2) HIST[0]++; else if (ae < 1) HIST[1]++; else if (ae < 3) HIST[2]++; else if (ae < 10) HIST[3]++; else HIST[4]++;
  }
}
console.log('compared columns:', count, '/', nxg * nyg);
console.log('mean abs error (mm):', (sumAbs / count).toFixed(3));
console.log('max abs error (mm):', maxAbs.toFixed(3), 'at', maxAt);
console.log('error histogram: <0.2mm', HIST[0], '| <1mm', HIST[1], '| <3mm', HIST[2], '| <10mm', HIST[3], '| >=10mm', HIST[4]);
console.log(`  as %% of compared columns: ${HIST.map(v => (100 * v / count).toFixed(1) + '%').join(', ')}`);

fs.writeFileSync(path.join(__dirname, 'out-verify-realpipeline-o1160.json'), JSON.stringify({ pos: Array.from(pos), idx: Array.from(idx), box: stockBox }));
