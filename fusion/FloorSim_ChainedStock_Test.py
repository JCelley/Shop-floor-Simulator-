"""
THROWAWAY DIAGNOSTIC - not for real use. Delete once the question below is answered.

Question: for a setup whose stock mode is "From Preceding Setup" (e.g. "Op 60" in the real
SOL1-902195 / O1228 job - stockMode 7, per docs/NOTES.md), does Fusion expose the actual
COMPUTED remaining-stock shape anywhere in the API? We already confirmed `Setup.stockSolids`
only works for "Solid" stock mode - it throws for "From Preceding Setup". This script does not
guess another property name; it introspects every setup for anything with "stock" in its name
(and the CAM object for anything mentioning stock/simulate/rest), so we find the real API
surface instead of guessing wrong ones. Needed for cross-setup stock chaining in the floor
simulator - see the "cross-setup stock chaining" discussion in docs/NOTES.md.

How to run:
  1. Open the design with the real job (the one with OP50 / Op49 / Op 60 / Probe test setups)
     and switch to the MANUFACTURE workspace.
  2. UTILITIES > Scripts and Add-ins > Scripts tab > green "+" > select this file > Run.
  3. Pick a folder when asked. It writes floorsim_chainedstock_test.txt there.
  4. Paste that file's full contents back.

Read-only: touches nothing in the design or CAM tree, only reads and writes its own log file.
"""
import os
import traceback

try:
    import adsk.core
    import adsk.fusion
    import adsk.cam
except ImportError:          # lets this be imported (not run) outside Fusion without erroring
    adsk = None


def describe(name, value):
    """One log line for an attribute: its type, and count if it looks like a collection."""
    if callable(value):
        return '    %s = [method/function]' % name
    try:
        cnt = value.count
        return '    %s = %s (collection, count=%s)' % (name, type(value).__name__, cnt)
    except Exception:
        pass
    try:
        return '    %s = %s: %r' % (name, type(value).__name__, value)
    except Exception:
        return '    %s = %s (unprintable)' % (name, type(value).__name__)


def dump_setup(setup, log):
    log.append('')
    log.append('--- Setup "%s" ---' % setup.name)
    try:
        log.append('  stockMode = %r' % setup.stockMode)
    except Exception as e:
        log.append('  stockMode FAILED: %s' % e)

    # Every attribute with "stock" in its name - real API surface, not a guessed one.
    names = sorted(n for n in dir(setup) if 'stock' in n.lower() and not n.startswith('_'))
    log.append('  attributes with "stock" in the name: %s' % names)
    for n in names:
        try:
            v = getattr(setup, n)
        except Exception as e:
            log.append('    %s -> FAILED: %s' % (n, e))
            continue
        log.append(describe(n, v))
        # if it's a collection, peek at the first item's type
        try:
            if not callable(v) and v.count > 0:
                item = v.item(0)
                log.append('      item(0) objectType = %s' % getattr(item, 'objectType', type(item).__name__))
        except Exception:
            pass

    # models: already known to list part models for other stock modes - check this one too.
    try:
        log.append('  models.count = %d' % setup.models.count)
        for j in range(min(setup.models.count, 5)):
            m = setup.models.item(j)
            log.append('    models[%d]: %s (%s)' % (j, getattr(m, 'name', '?'), getattr(m, 'objectType', '?')))
    except Exception as e:
        log.append('  models FAILED: %s' % e)

    # explicit stockSolids probe - confirmed by Autodesk docs to throw outside Solid stock mode;
    # verify that holds in practice for this real setup too, and log the exact error if so.
    try:
        ss = setup.stockSolids
        log.append('  stockSolids.count = %d' % ss.count)
    except Exception as e:
        log.append('  stockSolids FAILED: %s' % e)


def run(context):
    app = adsk.core.Application.get()
    ui = app.userInterface
    log = ['=== FloorSim chained-stock test ===', 'Document: ' + app.activeDocument.name]
    try:
        cam = adsk.cam.CAM.cast(app.activeDocument.products.itemByProductType('CAMProductType'))
        if not cam or cam.setups.count == 0:
            ui.messageBox('Switch to the Manufacture workspace in a document that has setups, then run this again.')
            return
        log.append('Setups: %d' % cam.setups.count)
        for i in range(cam.setups.count):
            try:
                dump_setup(cam.setups.item(i), log)
            except Exception:
                log.append('  Setup %d FAILED: %s' % (i, traceback.format_exc().splitlines()[-1]))

        cam_names = sorted(n for n in dir(cam) if any(k in n.lower() for k in ('stock', 'simulat', 'rest')) and not n.startswith('_'))
        log.append('')
        log.append('CAM-level attributes mentioning stock/simulate/rest: %s' % cam_names)
        for n in cam_names:
            try:
                log.append(describe(n, getattr(cam, n)))
            except Exception as e:
                log.append('    %s -> FAILED: %s' % (n, e))

        dlg = ui.createFolderDialog()
        dlg.title = 'Choose a folder for the diagnostic log'
        if dlg.showDialog() != adsk.core.DialogResults.DialogOK:
            return
        out_path = os.path.join(dlg.folder, 'floorsim_chainedstock_test.txt')
        with open(out_path, 'w') as f:
            f.write('\n'.join(log))
        ui.messageBox('Wrote:\n' + out_path + '\n\nPlease paste its full contents back.', 'FloorSim chained-stock test')
    except Exception:
        ui.messageBox('FloorSim chained-stock test FAILED:\n' + traceback.format_exc() + '\n\nLog so far:\n' + '\n'.join(log))
