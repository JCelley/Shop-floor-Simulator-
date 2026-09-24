// Does round 3 actually need the tolDeg=60 "snap anything reasonably close" trick, or does just
// reusing tri-dexel's EXISTING default (tiny, ~0.01deg) tolerance already give the same result -
// because the planes that mattered for O1224 were already exactly aligned, and the ones that
// needed real tolerance (O1160 plane 1, 14.66deg) turned out to be wrong to snap at all?
// NOTE: with default tolerance, planes that fall "oblique" get NO grid and NO cut at all here
// (buildTriDexel's oblique planes are for the caller's separate buildPlaneSims/fusion path, which
// this spike harness doesn't run) - so this comparison undercounts moves for the default case by
// design. The point isn't "which produces a prettier number", it's "does the plane-1 bug vanish
// once it's excluded from vertical-axis treatment", proving the mechanism, before deciding how to
// really handle oblique planes going forward.
'use strict';
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const NC = require(path.join(ROOT, 'src', 'engine.js'));
const { binTriangles, partHeightAt } = require('./compareToPart.js');

function runJob(name, ncPath, setupPath, stockPath, partPath) {
  const real = NC.parseProgram(fs.readFileSync(ncPath, 'utf8'));
  const setupText = fs.readFileSync(setupPath, 'utf8');
  const stockBuf = fs.readFileSync(stockPath);
  const partBuf = fs.readFileSync(partPath);
  const parsed = NC.parseCimcoSetup(setupText);
  NC.applyCimcoTools(parsed, real.tools);
  const meshes = { stock: NC.parseStlBinary(stockBuf), part: NC.parseStlBinary(partBuf) };
  const result = NC.cimcoToFloorsimSetup(parsed, meshes, name);
  const s = result.setup;
  const stockBox = { xmin: s.stock.xmin, xmax: s.stock.xmax, ymin: s.stock.ymin, ymax: s.stock.ymax, zbot: s.stock.zmin, ztop: s.stock.zmax };
  const partMesh = result.partMesh;
  const simTools = new Map(real.tools.map(t => [t.no, NC.simTool(t)]));

  function withTol(tolDeg) {
    const td = NC.buildTriDexel(real, 360, 5, stockBox, tolDeg);
    let cut = 0, skippedOblique = 0;
    for (let i = 0; i < real.n; i++) {
      if (!real.K[i]) continue;
      const T = simTools.get(real.TL[i]);
      if (!T || T.undercut) continue;
      if (!td.keyOfMove[i]) { skippedOblique++; continue; }
      NC.cutTriDexelMove(td, real, simTools, i, 0, 1);
      cut++;
    }
    const { pos, idx } = NC.fuseTriDexel(td, 360);
    const nxg = 360, nyg = Math.round(360 * (stockBox.ymax - stockBox.ymin) / (stockBox.xmax - stockBox.xmin));
    const gx0 = stockBox.xmin, gy0 = stockBox.ymin, gdx = (stockBox.xmax - stockBox.xmin) / nxg, gdy = (stockBox.ymax - stockBox.ymin) / nyg;
    const gridShape = { nx: nxg, ny: nyg, dx: gdx, dy: gdy, x0: gx0, y0: gy0 };
    const simMesh = { pos, idx };
    const simBins = binTriangles(simMesh, gridShape);
    const partBins = binTriangles(partMesh, gridShape);
    let count = 0, sumAbs = 0, maxAbs = 0; const HIST = [0, 0, 0, 0, 0];
    for (let j = 0; j < nyg; j++) {
      const py = gy0 + (j + 0.5) * gdy;
      for (let i = 0; i < nxg; i++) {
        const px = gx0 + (i + 0.5) * gdx;
        const real1 = partHeightAt(partMesh, partBins, gridShape, i, j, px, py);
        if (real1 === null) continue;
        const sim1 = partHeightAt(simMesh, simBins, gridShape, i, j, px, py);
        if (sim1 === null) continue;
        const e = sim1 - real1; count++; const ae = Math.abs(e); sumAbs += ae; if (ae > maxAbs) maxAbs = ae;
        if (ae < 0.2) HIST[0]++; else if (ae < 1) HIST[1]++; else if (ae < 3) HIST[2]++; else if (ae < 10) HIST[3]++; else HIST[4]++;
      }
    }
    console.log(`  ${name} tolDeg=${tolDeg === undefined ? 'default' : tolDeg}: grids=${[...td.grids.keys()]} cut=${cut} obliqueSkipped=${skippedOblique} | compared=${count}/${nxg*nyg} mean=${(sumAbs/count).toFixed(3)} max=${maxAbs.toFixed(2)} hist=${HIST}`);
  }
  console.log(name + ':');
  withTol(undefined);
  withTol(60);
}

const DIR = 'G:\\Shared drives\\APW\\Posted Programs - UNPROVEN\\';
runJob('O1160', DIR + 'O1160.NC', DIR + 'O1160.setup', DIR + 'O1160_STOCK.stl', DIR + 'O1160_PART.stl');
runJob('O1224', path.join(ROOT, 'fixtures', 'O1224.NC'), path.join(ROOT, 'fixtures', 'cimco', 'O1224.setup'), path.join(ROOT, 'fixtures', 'cimco', 'O1224_STOCK.stl'), path.join(ROOT, 'fixtures', 'cimco', 'O1224_PART.stl'));
