import sys
sys.dont_write_bytecode = True
import os
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
import sys, importlib.util
spec = importlib.util.spec_from_file_location('fse', os.path.join(ROOT, 'fusion', 'FloorSimExport.py')); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
fails = 0
def ok(c, msg):
    global fails
    print(('ok   ' if c else 'FAIL ') + msg); fails += (0 if c else 1)
# WCS rotated 90 deg about Z and shifted; point built as origin + 2*x + 3*y + 4*z (cm) must map to (20,30,40) mm
o = (1, 2, 3); xa = (0, 1, 0); ya = (-1, 0, 0); za = (0, 0, 1)
w = (o[0] + 2*xa[0] + 3*ya[0] + 4*za[0], o[1] + 2*xa[1] + 3*ya[1] + 4*za[1], o[2] + 2*xa[2] + 3*ya[2] + 4*za[2])
r = m.to_wcs(list(w), o, xa, ya, za); ok(r == [20.0, 30.0, 40.0], 'rigid transform world cm -> WCS mm: %s' % r)
# tilted axes (A-axis 30 deg) still orthonormal
import math; c, s = math.cos(math.radians(30)), math.sin(math.radians(30))
xa2, ya2, za2 = (1, 0, 0), (0, c, s), (0, -s, c)
p = (5 + 2*xa2[0] + 3*ya2[0] + 4*za2[0], 6 + 2*xa2[1] + 3*ya2[1] + 4*za2[1], 7 + 2*xa2[2] + 3*ya2[2] + 4*za2[2])
r2 = m.to_wcs(list(p), (5, 6, 7), xa2, ya2, za2); ok(all(abs(a - b) < 0.01 for a, b in zip(r2, [20, 30, 40])), 'tilted WCS: %s' % r2)
ok(m.bbox([1, 2, 3, -1, 5, 0]) == (-1, 2, 0, 1, 5, 3), 'bbox')
stock = {'xmin': -10, 'xmax': 10, 'ymin': -10, 'ymax': 10, 'zmin': -5, 'zmax': 0}
ok(m.part_check((-9, -9, -4, 9, 9, 0), stock)['status'] == 'ok', 'part inside stock -> ok')
ok(m.part_check((-9, -9, -4, 90, 9, 0), stock)['status'] == 'mismatch', 'part outside stock -> mismatch')
ok(m.part_check(None, stock)['status'] == 'unknown', 'no part -> unknown')
class P:  # fake CAM parameter
    def __init__(s, v): s.value = type('V', (), {'value': v})()
class Params:
    def __init__(s, d): s.d = d
    def itemByName(s, n):
        if n not in s.d: raise KeyError(n)
        return P(s.d[n])
class Setup: pass
st = Setup(); st.parameters = Params({'stockXLow': -2.695, 'stockXHigh': 0.48, 'stockYLow': -1.5875, 'stockYHigh': 1.5875, 'stockZLow': 9.108, 'stockZHigh': 11.979})
rs = m.read_stock(st); ok(rs and abs(rs['xmin'] + 26.95) < 1e-6 and abs(rs['zmax'] - 119.79) < 1e-6, 'read_stock cm -> mm: %s' % rs)
st.parameters = Params({}); ok(m.read_stock(st) is None, 'missing parameters -> None')
ok(m.safe_name('OP50 A-side / #1') == 'OP50_A-side_1', 'safe file name')

# --- origin unit detection with the real OP50 numbers (part at world origin, cm; raw origin from the CAM API)
lo, hi = (-1.301, -0.501, 0.0), (1.301, 0.501, 2.28)
ax = ((1, 0, 0), (0, 1, 0), (0, 0, 1)); stk = {'xmin': -26.988, 'xmax': 4.762, 'ymin': -15.875, 'ymax': 15.875, 'zmin': 90.092, 'zmax': 118.794}
k, chk = m.choose_origin_scale(lo, hi, (11.1125, 0, -93.902), *ax, stk); ok(k == 0.1 and chk['status'] == 'ok', 'origin given in mm is detected: k=%s %s' % (k, chk['status']))
k, chk = m.choose_origin_scale(lo, hi, (1.11125, 0, -9.3902), *ax, stk); ok(k == 1.0 and chk['status'] == 'ok', 'origin given in cm is detected: k=%s %s' % (k, chk['status']))
k, chk = m.choose_origin_scale(lo, hi, (5000, 0, 0), *ax, stk); ok(chk['status'] == 'mismatch', 'impossible origin -> mismatch')
flip = ((-1, 0, 0), (0, 1, 0), (0, 0, -1)); s49 = {'xmin': -63.5, 'xmax': 63.5, 'ymin': -53.023, 'ymax': 53.023, 'zmin': 52.5, 'zmax': 90.092}
k, chk = m.choose_origin_scale((-6.35, -5.3023, 0.068), (6.35, 5.3023, 3.827), (0, 0, 90.774), *flip, s49); ok(k == 0.1 and chk['status'] == 'ok', 'flipped Op49 setup: k=%s %s' % (k, chk['status']))
print('\n%d FAILED' % fails if fails else '\nall passed'); sys.exit(1 if fails else 0)
