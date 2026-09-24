// Isolate whether fuseTriDexel's OWN voxel-mesh resolution (separate from the cutting
// computation) is responsible for the O1160 error histogram's small/mid buckets, vs the ~20mm
// corner cluster which should NOT move if it's a real logic issue rather than a meshing artifact.
// Cuts ONCE, then fuses to two different mesh resolutions and re-runs compareToPart's own
// raycast logic against each, holding everything else fixed.
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

const td = NC.buildTriDexel(real, 360, 5, stockBox, 60);
const simTools = new Map(real.tools.map(t => [t.no, NC.simTool(t)]));
for (let i = 0; i < real.n; i++) {
  if (!real.K[i]) continue;
  const T = simTools.get(real.TL[i]);
  if (!T || T.undercut) continue;
  NC.cutTriDexelMove(td, real, simTools, i, 0, 1);
}

function compareAt(meshTarget) {
  const t0 = Date.now();
  const { pos, idx } = NC.fuseTriDexel(td, meshTarget);
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
      count++; const ae = Math.abs(e); sumAbs += ae;
      if (ae > maxAbs) { maxAbs = ae; maxAt = [px.toFixed(1), py.toFixed(1)]; }
      if (ae < 0.2) HIST[0]++; else if (ae < 1) HIST[1]++; else if (ae < 3) HIST[2]++; else if (ae < 10) HIST[3]++; else HIST[4]++;
    }
  }
  console.log('meshTarget', meshTarget, '| verts', pos.length / 3, '| mean', (sumAbs / count).toFixed(3), '| max', maxAbs.toFixed(2), 'at', maxAt, '| hist(<0.2,<1,<3,<10,>=10)', HIST, '| ms', Date.now() - t0);
}
compareAt(360);
compareAt(720);
