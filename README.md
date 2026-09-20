# NC Floor Sim

Browser CNC stock-removal simulator for shop-floor operators. See `CLAUDE.md` for the brief and `docs/NOTES.md` for details.

```
npm install        # jsdom + three@0.128.0 (dev only)
npm run build      # dist/nc-floor-sim.html, one self-contained file
npm test           # every suite; needs Node 18+ and Python 3 (Python only for the Fusion-side tests)
```

Open `dist/nc-floor-sim.html` in Chrome. It loads a demo program on start. Drop in a job file (`*.floorsim.json`) or an
NC program with its setup-sheet CSV and Fusion `.tools` file.

`fixtures/` contains real customer job data. Keep this repository private.
