import sys, os, json, csv, re, shutil, tempfile, types, importlib.util
sys.dont_write_bytecode = True
import os
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
spec = importlib.util.spec_from_file_location('fsj', os.path.join(ROOT, 'fusion', 'FloorSimJobExport', 'FloorSimJobExport.py')); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
fails = 0
def ok(c, msg):
    global fails; print(('ok   ' if c else 'FAIL ') + msg); fails += (0 if c else 1)

# ---- a fake Fusion object model, fed with the real job data
class CT:
    def __init__(s, t): s.t = t
    def classType(s): return s.t
m.adsk = types.SimpleNamespace(
    fusion=types.SimpleNamespace(BRepBody=CT('BRepBody'), Occurrence=CT('Occurrence'), TriangleMeshQualityOptions=types.SimpleNamespace(LowQualityTriangleMesh=1, NormalQualityTriangleMesh=2)),
    cam=types.SimpleNamespace(Setup=CT('Setup'), NCProgramPostProcessOptions=types.SimpleNamespace(create=lambda: object())))
class Coll:
    def __init__(s, i): s._i = list(i)
    count = property(lambda s: len(s._i))
    def item(s, k): return s._i[k]
class Val:
    def __init__(s, v): s.value = types.SimpleNamespace(value=v)
class Params:
    def __init__(s, d): s.d = d
    def itemByName(s, n): return Val(s.d[n]) if n in s.d else None
P3 = lambda a: types.SimpleNamespace(x=a[0], y=a[1], z=a[2])
O_MM = (11.1125, -5.7e-14, -93.902)             # the CAM API's WCS origin: millimetres
def world_cm(w): return [(w[0] + O_MM[0]) / 10, w[1] / 10, (w[2] + O_MM[2]) / 10]
def box_mesh(lo, hi):                            # box given in WCS mm -> mesh in WORLD cm, like Fusion's body mesh
    xs, ys, zs = (lo[0], hi[0]), (lo[1], hi[1]), (lo[2], hi[2]); pts = []
    for z in zs:
        for y in ys:
            for x in xs: pts += world_cm((x, y, z))
    tri = [0,2,1, 0,3,2] ; idx = [0,1,3, 0,3,2, 4,5,7, 4,7,6, 0,1,5, 0,5,4, 2,3,7, 2,7,6, 0,2,6, 0,6,4, 1,3,7, 1,7,5]
    return pts, idx
class Body:
    objectType = 'BRepBody'
    def __init__(s, name, lo, hi):
        s.name = name; s.parentComponent = types.SimpleNamespace(name='Vise'); pts, idx = box_mesh(lo, hi)
        mesh = types.SimpleNamespace(nodeCoordinatesAsDouble=pts, nodeIndices=idx)
        s.meshManager = types.SimpleNamespace(createMeshCalculator=lambda: types.SimpleNamespace(setQuality=lambda q: None, calculate=lambda: mesh))
JAW_L = ((-63.5, -50.0, 0.0), (-30.0, -6.0, 90.09)); JAW_R = ((-63.5, 6.0, 0.0), (-30.0, 50.0, 90.09))
setup = types.SimpleNamespace(
    objectType='Setup', name='OP50 ', stockMode=6,
    parameters=Params({'stockXLow': -2.6988, 'stockXHigh': 0.4762, 'stockYLow': -1.5875, 'stockYHigh': 1.5875, 'stockZLow': 9.0092, 'stockZHigh': 11.8794}),
    workCoordinateSystem=types.SimpleNamespace(getAsCoordinateSystem=lambda: (P3(O_MM), P3((1, 0, 0)), P3((0, 1, 0)), P3((0, 0, 1)))),
    fixtures=Coll([Body('Jaw L', *JAW_L), Body('Jaw R', *JAW_R)]),
    models=Coll([types.SimpleNamespace(boundingBox=types.SimpleNamespace(minPoint=P3((-1.301, -0.501, 0.0)), maxPoint=P3((1.301, 0.501, 2.28))))]))
lib = json.load(open(os.path.join(ROOT, 'fixtures', 'tools.json')))['data']
libno = {e['post-process']['number']: e for e in lib}
class Op:
    objectType = 'Operation'
    def __init__(s, label, no): s.name = label; s.parentSetup = setup; s.tool = types.SimpleNamespace(toJson=lambda: json.dumps(libno[no]))
rows = [r for r in csv.reader(open(os.path.join(ROOT, 'fixtures', 'O1228.csv'), encoding='utf-8-sig'))][1:]
ops = [Op(re.sub(r'^\s*OP\d+\s*\|\s*', '', r[1]).strip(), int(re.search(r'T(\d+)', r[3]).group(1))) for r in rows if len(r) > 8 and re.search(r'T\d+', r[3] or '')]
NC = open(os.path.join(ROOT, 'fixtures', 'O1228.NC'), 'rb').read()
tmp = tempfile.mkdtemp(); extra = os.path.join(tmp, 'shared', 'floorsim')
class Prog:
    name = 'OP50 program'
    def __init__(s, params): s.parameters = Params(params); s.filteredOperations = ops; s.operations = [setup]
    def postProcess(s, opts):
        open(os.path.join(tmp, 'O1228.NC'), 'wb').write(NC); return True
prog = Prog({'nc_program_output_folder': tmp.replace('\\', '/'), 'nc_program_filename': 'O1228', 'nc_program_nc_extension': 'NC'})
cam = types.SimpleNamespace(documentToolLibrary=types.SimpleNamespace(toJson=lambda: json.dumps({'data': lib})))

log = []; res = m.export_job(cam, prog, True, extra, log, None, 'CAM - SOL1-902195 REV A')
job = res['job']; print('   log:', ' | '.join(l for l in log if l)[:400])
ok(os.path.basename(res['paths'][0]) == 'O1228.floorsim.json', 'file is named after the posted NC file: ' + os.path.basename(res['paths'][0]))
ok(len(res['paths']) == 2 and os.path.isfile(res['paths'][1]), 'a copy went to the extra folder')
ok(job['gcode'].encode('latin-1') == NC, 'the exact posted NC is embedded (%d bytes)' % len(NC))
ok(len(job['ops']) == 16 and job['ops'][5]['label'] == '2D Contour Finish Outside #26 #17 #18', '16 operations with names; #6 = ' + job['ops'][5]['label'])
ok(sorted(e['post-process']['number'] for e in job['toolLibrary']['data']) == [57, 58, 59, 60, 61, 62, 65], 'only the 7 tools this program uses, holders included: ' + str(len(job['toolLibrary']['data'])))
ok(all(len(e['holder']['segments']) == 9 for e in job['toolLibrary']['data']), 'every tool carries its 9 holder segments')
st = job['stock']; ok(abs(st['xmin'] + 26.988) < 0.01 and abs(st['zmax'] - 118.794) < 0.01, 'stock box in mm: %s' % st)
fx = {f['name']: f['positions'] for f in job['fixtures']}
jl = fx['Vise / Jaw L']; ok(abs(min(jl[0::3]) + 63.5) < 0.02 and abs(max(jl[2::3]) - 90.09) < 0.02, 'fixture lands where expected in WCS (x %.2f..%.2f, z top %.2f)' % (min(jl[0::3]), max(jl[0::3]), max(jl[2::3])))
ok(job['check']['status'] == 'ok' and job['wcs']['originUnit'] == 'mm', 'placement self-test ok, origin read as mm')
omm = job['wcs']['originMM']; ok(all(abs(a - b) < 0.01 for a, b in zip(omm, O_MM)), 'resolved originMM matches the known WCS origin: %s' % omm)
ok(job['exported'][:4] == '2026' or len(job['exported']) == 19, 'export time recorded: ' + job['exported'])
os.makedirs(os.path.join(ROOT, 'tests', '.tmp'), exist_ok=True); json.dump(job, open(os.path.join(ROOT, 'tests', '.tmp', 'O1228.floorsim.json'), 'w'), separators=(',', ':'))
# posting off: existing file is used, and the log says so
log = []; res2 = m.export_job(cam, prog, False, '', log, None, 'x'); ok(any('NOT re-posted' in l for l in log), 'not re-posting is reported')
# file finding
prog2 = Prog({'nc_program_output_folder': tmp.replace('\\', '/'), 'nc_program_filename': '', 'nc_program_nc_extension': ''})
ok(m.find_nc_file(prog2, None) is None, 'unknown name and no post -> refuses to guess')
ok(m.find_nc_file(prog2, os.path.getmtime(os.path.join(tmp, 'O1228.NC')) - 1) is not None, 'unknown name right after posting -> newest new file')
prog3 = Prog({'nc_program_output_folder': os.path.join(tmp, 'nope'), 'nc_program_filename': 'O1228', 'nc_program_nc_extension': 'NC'})
try: m.export_job(cam, prog3, False, '', [], None, ''); ok(False, 'missing file raises')
except RuntimeError as e: ok('Could not find' in str(e), 'missing NC file gives a clear error')
shutil.rmtree(tmp)
print('\n%d FAILED' % fails if fails else '\nall passed'); sys.exit(1 if fails else 0)
