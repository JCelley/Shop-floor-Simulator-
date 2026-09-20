"""
FloorSimExport: writes each CAM setup's stock box and workholding for the NC floor simulator.

How to run (menu names may differ slightly between Fusion versions)
  1. Open the design and switch to the MANUFACTURE workspace.
  2. UTILITIES > Add-Ins > Scripts and Add-Ins > Scripts tab > "+" > Create new script (Python),
     name it FloorSimExport, then replace the contents of its .py file with this file.
  3. Select it and press Run. Pick a folder when asked.

Output: one <setup name>.floorsim.json per setup, in the folder you pick. The script only reads;
it does not change the design or the toolpaths.

What is written, all in millimetres and in the setup's own work coordinate system (WCS),
which is the coordinate system the posted NC program uses:
  stock     the stock box, from the setup's stockXLow ... stockZHigh parameters
  fixtures  triangle meshes of the bodies chosen as fixtures in that setup, moved into the WCS
  check     a self-test: is the part inside the stock box once moved into the WCS?
  wcs       the raw WCS origin (and which unit it was read in) and axes, so a wrong placement can be diagnosed
"""
import json
import os
import re
import traceback

try:
    import adsk.core
    import adsk.fusion
    import adsk.cam
except ImportError:          # lets the helper functions be tested outside Fusion
    adsk = None

CM_TO_MM = 10.0              # Fusion's API always works in centimetres


# ---------------------------------------------------------------- pure helpers (testable)

def to_wcs(coords, origin, xa, ya, za, decimals=2):
    """Flat [x,y,z,...] in world cm -> flat [x,y,z,...] in WCS mm.
    origin and the three axes are (x, y, z) tuples in world coordinates."""
    ox, oy, oz = origin
    out = []
    for i in range(0, len(coords), 3):
        dx, dy, dz = coords[i] - ox, coords[i + 1] - oy, coords[i + 2] - oz
        out.append(round((dx * xa[0] + dy * xa[1] + dz * xa[2]) * CM_TO_MM, decimals))
        out.append(round((dx * ya[0] + dy * ya[1] + dz * ya[2]) * CM_TO_MM, decimals))
        out.append(round((dx * za[0] + dy * za[1] + dz * za[2]) * CM_TO_MM, decimals))
    return out


def bbox(flat):
    """Bounding box of a flat [x,y,z,...] list as (minx,miny,minz,maxx,maxy,maxz), or None."""
    if not flat:
        return None
    xs, ys, zs = flat[0::3], flat[1::3], flat[2::3]
    return (min(xs), min(ys), min(zs), max(xs), max(ys), max(zs))


def corners(lo, hi):
    """Eight corners of a box as a flat list."""
    out = []
    for x in (lo[0], hi[0]):
        for y in (lo[1], hi[1]):
            for z in (lo[2], hi[2]):
                out += [x, y, z]
    return out


def union(a, b):
    if a is None:
        return b
    if b is None:
        return a
    return (min(a[0], b[0]), min(a[1], b[1]), min(a[2], b[2]), max(a[3], b[3]), max(a[4], b[4]), max(a[5], b[5]))


def part_check(part_bb, stock, tol=1.0):
    """The part must sit inside the stock box (both in WCS mm). Returns a dict for the JSON."""
    if part_bb is None or stock is None:
        return {'status': 'unknown', 'note': 'no part bounds or no stock box to compare'}
    inside = (part_bb[0] >= stock['xmin'] - tol and part_bb[1] >= stock['ymin'] - tol and part_bb[2] >= stock['zmin'] - tol and
              part_bb[3] <= stock['xmax'] + tol and part_bb[4] <= stock['ymax'] + tol and part_bb[5] <= stock['zmax'] + tol)
    return {'status': 'ok' if inside else 'mismatch', 'partBox': [round(v, 2) for v in part_bb]}


def read_stock(setup):
    """Stock box in WCS mm from the setup parameters, or None when they are not available."""
    vals = {}
    for key, name in (('xmin', 'stockXLow'), ('xmax', 'stockXHigh'), ('ymin', 'stockYLow'),
                      ('ymax', 'stockYHigh'), ('zmin', 'stockZLow'), ('zmax', 'stockZHigh')):
        try:
            p = setup.parameters.itemByName(name)
            vals[key] = round(p.value.value * CM_TO_MM, 3)
        except Exception:
            return None
    return vals


def choose_origin_scale(lo, hi, raw_origin, xa, ya, za, stock):
    """Body geometry comes back in centimetres, but the WCS origin from the CAM side turned out to be in
    millimetres (found by testing against real setups). Try both readings and keep the one that puts the
    part inside the stock box. Returns (k, check) where origin_in_cm = raw_origin * k."""
    if lo is None or hi is None or stock is None:
        return 0.1, {'status': 'unknown', 'note': 'no part bounds or no stock box to compare, assumed millimetres'}
    first = None
    for k in (0.1, 1.0):
        origin = tuple(v * k for v in raw_origin)
        chk = part_check(bbox(to_wcs(corners(lo, hi), origin, xa, ya, za)), stock)
        if chk['status'] == 'ok':
            return k, chk
        if first is None:
            first = (k, chk)
    return first


def safe_name(s):
    return re.sub(r'[^A-Za-z0-9._-]+', '_', s).strip('_') or 'setup'


# ---------------------------------------------------------------- Fusion-facing code

def _pt(p):
    return (p.x, p.y, p.z)


def wcs_frame(setup):
    origin, xa, ya, za = setup.workCoordinateSystem.getAsCoordinateSystem()
    return _pt(origin), _pt(xa), _pt(ya), _pt(za)


def collect_bodies(entity, out, log):
    """Bodies inside a fixture entry, which may be a body or an occurrence (with children)."""
    t = entity.objectType
    if t == adsk.fusion.BRepBody.classType():
        out.append(entity)
    elif t == adsk.fusion.Occurrence.classType():
        for i in range(entity.bRepBodies.count):
            out.append(entity.bRepBodies.item(i))
        for i in range(entity.childOccurrences.count):
            collect_bodies(entity.childOccurrences.item(i), out, log)
    else:
        log.append('    skipped a fixture entry of type ' + t + ' (only solid bodies are exported)')


def mesh_quality():
    q = adsk.fusion.TriangleMeshQualityOptions
    return getattr(q, 'LowQualityTriangleMesh', None) or q.NormalQualityTriangleMesh


def export_setup(setup, log):
    raw_origin, xa, ya, za = wcs_frame(setup)
    stock = read_stock(setup)
    log.append('  stock box: ' + ('read from setup parameters' if stock else 'NOT FOUND (the page will fall back to a guess)'))

    # part bounds (world cm), used to work out the unit of the WCS origin and to self-test the placement
    part_lo = part_hi = None
    try:
        models = setup.models
        for i in range(models.count):
            bb = models.item(i).boundingBox
            lo, hi = _pt(bb.minPoint), _pt(bb.maxPoint)
            part_lo = lo if part_lo is None else tuple(min(a, b) for a, b in zip(part_lo, lo))
            part_hi = hi if part_hi is None else tuple(max(a, b) for a, b in zip(part_hi, hi))
    except Exception as e:
        log.append('  part bounds unavailable (' + str(e) + ')')
    k, check = choose_origin_scale(part_lo, part_hi, raw_origin, xa, ya, za, stock)
    origin = tuple(v * k for v in raw_origin)
    log.append('  WCS origin read as %s; placement self-test: %s' % ('millimetres' if k < 1 else 'centimetres', check['status']))

    entries = []
    try:
        coll = setup.fixtures
        for i in range(coll.count):
            entries.append(coll.item(i))
    except Exception as e:
        log.append('  fixtures: could not be read (' + str(e) + ')')
    bodies = []
    for e in entries:
        collect_bodies(e, bodies, log)

    fixtures = []
    for b in bodies:
        try:
            calc = b.meshManager.createMeshCalculator()
            calc.setQuality(mesh_quality())
            m = calc.calculate()
            pos = to_wcs(list(m.nodeCoordinatesAsDouble), origin, xa, ya, za)
            try:
                nm = '%s / %s' % (b.parentComponent.name, b.name)
            except Exception:
                nm = b.name
            fixtures.append({'name': nm, 'positions': pos, 'indices': list(m.nodeIndices)})
            log.append('    fixture body "%s": %d triangles' % (nm, len(m.nodeIndices) // 3))
        except Exception:
            log.append('    fixture body failed: ' + traceback.format_exc().splitlines()[-1])
    if not fixtures:
        log.append('  no fixture geometry found for this setup')

    try:
        mode = int(setup.stockMode)
    except Exception:
        mode = None
    return {
        'format': 'floorsim-setup', 'version': 1, 'units': 'mm', 'setup': setup.name,
        'stockMode': mode, 'stock': stock, 'fixtures': fixtures, 'check': check,
        'wcs': {'origin_raw': raw_origin, 'originUnit': 'mm' if k < 1 else 'cm', 'x': xa, 'y': ya, 'z': za,
                'originMM': [round(v * CM_TO_MM, 3) for v in origin]},  # resolved, ready to use - same frame as fixtures/positions
    }


def run(context):
    app = adsk.core.Application.get()
    ui = app.userInterface
    try:
        cam = adsk.cam.CAM.cast(app.activeDocument.products.itemByProductType('CAMProductType'))
        if not cam or cam.setups.count == 0:
            ui.messageBox('Switch to the Manufacture workspace in a document that has setups, then run this again.')
            return
        dlg = ui.createFolderDialog()
        dlg.title = 'Choose a folder for the simulator files'
        if dlg.showDialog() != adsk.core.DialogResults.DialogOK:
            return
        folder, summary = dlg.folder, []
        for i in range(cam.setups.count):
            setup = cam.setups.item(i)
            log = ['Setup "%s"' % setup.name]
            try:
                data = export_setup(setup, log)
                path = os.path.join(folder, safe_name(setup.name) + '.floorsim.json')
                with open(path, 'w') as f:
                    json.dump(data, f, separators=(',', ':'))
                log.append('  wrote ' + os.path.basename(path))
            except Exception:
                log.append('  FAILED: ' + traceback.format_exc().splitlines()[-1])
            summary += log
        ui.messageBox('\n'.join(summary), 'FloorSimExport')
    except Exception:
        ui.messageBox('FloorSimExport failed:\n' + traceback.format_exc())
