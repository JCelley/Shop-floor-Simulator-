"""
FloorSimJobExport: a Fusion add-in that adds a "Shop Floor Sim Files" button to the Manufacture workspace.

Click it, pick an NC program from the list, press OK. It posts that NC program with its own saved post settings,
then writes ONE file next to the posted NC file, named after it (for example O1228.floorsim.json). The file holds
the exact posted program, the stock box, the workholding, the tools with their holders, and the operation names,
so the simulator only needs that one file.

Install: unzip the folder somewhere permanent, then UTILITIES > Add-Ins > Scripts and Add-Ins > green "+" and select the
folder. On the Add-Ins tab tick "Run on Startup" and press Run. The button appears in the Manufacture workspace.
It only reads the design; it changes nothing except posting the NC program you choose.
"""
import datetime
import shutil
import time
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




# ====================================================================== job export (the add-in part)

ADDIN_NAME = 'FloorSimJobExport'
CMD_ID = 'floorsimJobExportCmd'
PANEL_ID = 'floorsimPanel'
SKIP_EXT = ('.json', '.html', '.htm', '.pdf', '.csv', '.xml', '.png', '.jpg', '.zip')
_handlers = []                                   # keeps event handlers alive


def as_list(coll):
    """Fusion returns lists or collections depending on the property; give back a plain list."""
    if coll is None:
        return []
    try:
        return list(coll)
    except TypeError:
        return [coll.item(i) for i in range(coll.count)]


def param_value(obj, name, default=None):
    try:
        p = obj.parameters.itemByName(name)
        return p.value.value if p else default
    except Exception:
        return default


def settings_path():
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), 'settings.json')


def load_settings():
    try:
        with open(settings_path()) as f:
            return json.load(f)
    except Exception:
        return {}


def save_settings(d):
    try:
        with open(settings_path(), 'w') as f:
            json.dump(d, f)
    except Exception:
        pass


def find_nc_file(prog, since=None):
    """Locate the NC file this NC program writes. Uses the program's own output settings first.
    When we just posted, fall back to the newest file written since; otherwise only accept a name match."""
    folder = param_value(prog, 'nc_program_output_folder')
    name = param_value(prog, 'nc_program_filename')
    ext = param_value(prog, 'nc_program_nc_extension')
    if not folder:
        return None
    folder = str(folder).replace('/', os.sep)
    if not os.path.isdir(folder):
        return None
    if name and ext:
        e = str(ext) if str(ext).startswith('.') else '.' + str(ext)
        p = os.path.join(folder, str(name) + e)
        if os.path.isfile(p) and (since is None or os.path.getmtime(p) >= since - 2):
            return p
    files = []
    for f in os.listdir(folder):
        full = os.path.join(folder, f)
        if not os.path.isfile(full) or f.lower().endswith(SKIP_EXT):
            continue
        if since is not None and os.path.getmtime(full) < since - 2:
            continue
        files.append(full)
    if name:
        named = [f for f in files if os.path.splitext(os.path.basename(f))[0].lower() == str(name).lower()]
        files = named or (files if since is not None else [])
    elif since is None:
        files = []
    return max(files, key=os.path.getmtime) if files else None


def tool_of(op):
    """The operation's tool as Fusion's own tool JSON (holder segments included)."""
    try:
        return json.loads(op.tool.toJson())
    except Exception:
        return None


def tool_number(tj):
    try:
        return int((tj.get('post-process') or {}).get('number'))
    except Exception:
        return None


def setup_of(entry):
    try:
        if entry.objectType == adsk.cam.Setup.classType():
            return entry
    except Exception:
        pass
    return getattr(entry, 'parentSetup', None)


def export_job(cam, prog, do_post, extra_folder, log, ask_file=None, doc_name=''):
    """Post the NC program (optionally), then bundle program + stock + workholding + tools into one file."""
    started = time.time()
    if do_post:
        log.append('Posting "%s" with its saved post settings...' % prog.name)
        if not prog.postProcess(adsk.cam.NCProgramPostProcessOptions.create()):
            raise RuntimeError('Fusion reported that posting failed. Check the NC program for errors.')
    nc_path = find_nc_file(prog, started if do_post else None)
    if not nc_path and ask_file:
        nc_path = ask_file()
    if not nc_path or not os.path.isfile(nc_path):
        raise RuntimeError('Could not find the posted NC file. Check the output folder in the NC program.')
    with open(nc_path, 'r', encoding='latin-1', newline='') as f:
        gcode = f.read()
    stem = os.path.splitext(os.path.basename(nc_path))[0]
    when = datetime.datetime.fromtimestamp(os.path.getmtime(nc_path)).strftime('%Y-%m-%d %H:%M')
    log.append('NC file: %s (%s)' % (nc_path, 'posted just now' if do_post else 'existing file from ' + when + ', NOT re-posted'))

    ops = as_list(getattr(prog, 'filteredOperations', None)) or as_list(prog.operations)
    op_list, tools, setups = [], {}, []
    for o in ops:
        tj = tool_of(o)
        no = tool_number(tj) if tj else None
        if no is not None:
            op_list.append({'label': o.name, 'tool': no})
            tools.setdefault(no, tj)
        s = setup_of(o)
        if s is not None and all(s.name != x.name for x in setups):
            setups.append(s)
    if not tools:                                   # fall back to every tool in the document
        try:
            for tj in json.loads(cam.documentToolLibrary.toJson()).get('data', []):
                no = tool_number(tj)
                if no is not None:
                    tools.setdefault(no, tj)
        except Exception as e:
            log.append('  could not read tools (%s)' % e)
    if not setups:
        raise RuntimeError('This NC program has no operations that belong to a setup.')
    if len(setups) > 1:
        log.append('  NOTE: this NC program covers %d setups. Workholding is taken from "%s".' % (len(setups), setups[0].name))
    log.append('Setup "%s": %d operations, %d tools' % (setups[0].name, len(op_list), len(tools)))
    data = export_setup(setups[0], log)

    job = {
        'format': 'floorsim-job', 'version': 1, 'units': 'mm',
        'program': stem, 'ncFile': os.path.basename(nc_path), 'ncNumber': None,
        'gcode': gcode, 'ops': op_list,
        'toolLibrary': {'data': [tools[k] for k in sorted(tools)], 'version': 1},
        'setup': data['setup'], 'stockMode': data['stockMode'], 'stock': data['stock'],
        'fixtures': data['fixtures'], 'check': data['check'], 'wcs': data['wcs'],
        'exported': datetime.datetime.now().isoformat(timespec='seconds'),
        'document': doc_name, 'ncProgram': prog.name, 'ncFileModified': when,
    }
    out = os.path.join(os.path.dirname(nc_path), stem + '.floorsim.json')
    with open(out, 'w') as f:
        json.dump(job, f, separators=(',', ':'))
    written = [out]
    if extra_folder:
        try:
            os.makedirs(extra_folder, exist_ok=True)
            dst = os.path.join(extra_folder, os.path.basename(out))
            shutil.copy2(out, dst)
            written.append(dst)
        except Exception as e:
            log.append('  WARNING: could not copy to "%s" (%s)' % (extra_folder, e))
    log.append('')
    log.append('Wrote:')
    log += ['  ' + w for w in written]
    if data['check']['status'] == 'mismatch':
        log.append('')
        log.append('WARNING: the placement self-test failed, so the workholding may be in the wrong place.')
    if not do_post:
        log.append('')
        log.append('NOTE: the NC file was not re-posted. If you changed toolpaths since, post again.')
    return {'job': job, 'paths': written, 'nc': nc_path}


# ---------------------------------------------------------------- Fusion UI

def get_cam():
    app = adsk.core.Application.get()
    return adsk.cam.CAM.cast(app.activeDocument.products.itemByProductType('CAMProductType'))


class _Created(adsk.core.CommandCreatedEventHandler if adsk else object):
    def notify(self, args):
        app = adsk.core.Application.get()
        ui = app.userInterface
        try:
            cmd = args.command
            cam = get_cam()
            inputs = cmd.commandInputs
            dd = inputs.addDropDownCommandInput('prog', 'NC program', adsk.core.DropDownStyles.TextListDropDownStyle)
            n = cam.ncPrograms.count if cam else 0
            for i in range(n):
                dd.listItems.add(cam.ncPrograms.item(i).name, i == 0)
            if n == 0:
                dd.listItems.add('(this document has no NC programs)', True)
            inputs.addBoolValueInput('post', 'Post the program now', True, '', True)
            inputs.addStringValueInput('extra', 'Also copy the job file to (optional)', load_settings().get('extraFolder', ''))
            inputs.addTextBoxCommandInput('note', '', 'Writes the job file next to the posted NC file, named after it.', 2, True)
            h = _Execute()
            cmd.execute.add(h)
            _handlers.append(h)
        except Exception:
            ui.messageBox('Failed:\n' + traceback.format_exc())


class _Execute(adsk.core.CommandEventHandler if adsk else object):
    def notify(self, args):
        app = adsk.core.Application.get()
        ui = app.userInterface
        log = []
        try:
            inputs = args.command.commandInputs
            name = inputs.itemById('prog').selectedItem.name
            do_post = inputs.itemById('post').value
            extra = inputs.itemById('extra').value.strip()
            save_settings({'extraFolder': extra})
            cam = get_cam()
            prog = cam.ncPrograms.itemByName(name) if cam else None
            if not prog:
                ui.messageBox('Pick an NC program from the list.')
                return

            def ask_file():
                dlg = ui.createFileDialog()
                dlg.title = 'Select the posted NC file'
                dlg.filter = '*.*'
                dlg.isMultiSelectEnabled = False
                return dlg.filename if dlg.showOpen() == adsk.core.DialogResults.DialogOK else None

            export_job(cam, prog, do_post, extra, log, ask_file, app.activeDocument.name)
            ui.messageBox('\n'.join(log), 'Shop floor export')
        except Exception:
            ui.messageBox('\n'.join(log + ['', 'Failed:', traceback.format_exc()]), 'Shop floor export')


# v0.2 - John wanted the button inside Fusion's own "Actions" panel on the Milling tab, not its
# own panel. There are actually TWO panels named "Actions" (Milling tab and Utilities tab) - a
# name search across the whole workspace found the wrong one first. Neither panel's real internal
# ID is known (unverified), so both the tab and the panel are found by matching their displayed
# names. If that search ever fails (e.g. Autodesk renames or relocates either one), this falls
# back to our own panel on the Tools tab exactly as before, so the button never just silently
# disappears. //DWY
NATIVE_TAB_NAME = 'MILLING'
NATIVE_PANEL_NAME = 'ACTIONS'


def find_panel_in_tab(ws, tab_name, panel_name):
    """Search one specific tab's panels by displayed name, not a workspace-wide search - panel
    names are not unique across tabs (there are two different panels both named "Actions")."""
    try:
        tab_target = tab_name.strip().lower()
        panel_target = panel_name.strip().lower()
        for i in range(ws.toolbarTabs.count):
            tab = ws.toolbarTabs.item(i)
            if not tab.name or tab.name.strip().lower() != tab_target:
                continue
            for j in range(tab.toolbarPanels.count):
                p = tab.toolbarPanels.item(j)
                if p.name and p.name.strip().lower() == panel_target:
                    return p
    except Exception:
        pass
    return None


def run(context):
    app = adsk.core.Application.get()
    ui = app.userInterface
    try:
        cmd_def = ui.commandDefinitions.itemById(CMD_ID)
        if cmd_def:
            cmd_def.deleteMe()
        cmd_def = ui.commandDefinitions.addButtonDefinition(
            CMD_ID, 'Shop Floor Sim Files',
            'Posts the chosen NC program and writes one job file for the floor simulator')
        h = _Created()
        cmd_def.commandCreated.add(h)
        _handlers.append(h)
        ws = ui.workspaces.itemById('CAMEnvironment')
        panel = find_panel_in_tab(ws, NATIVE_TAB_NAME, NATIVE_PANEL_NAME) or ws.toolbarPanels.itemById(PANEL_ID) or ws.toolbarPanels.add(PANEL_ID, 'Shop floor')
        ctrl = panel.controls.itemById(CMD_ID) or panel.controls.addCommand(cmd_def)
        ctrl.isPromoted = True
    except Exception:
        ui.messageBox('FloorSimJobExport failed to start:\n' + traceback.format_exc())


def stop(context):
    app = adsk.core.Application.get()
    ui = app.userInterface
    try:
        ws = ui.workspaces.itemById('CAMEnvironment')
        # Our control could be sitting in Fusion's native Actions panel or, if that search failed
        # this session, our own fallback panel - check both, but only ever delete the PANEL if it
        # is the one we created ourselves (id == PANEL_ID). Never delete a native Fusion panel.
        panel = find_panel_in_tab(ws, NATIVE_TAB_NAME, NATIVE_PANEL_NAME) or ws.toolbarPanels.itemById(PANEL_ID)
        if panel:
            ctrl = panel.controls.itemById(CMD_ID)
            if ctrl:
                ctrl.deleteMe()
            if panel.id == PANEL_ID and panel.controls.count == 0:
                panel.deleteMe()
        cmd_def = ui.commandDefinitions.itemById(CMD_ID)
        if cmd_def:
            cmd_def.deleteMe()
    except Exception:
        pass
