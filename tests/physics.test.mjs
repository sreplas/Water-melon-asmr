// Headless stress tests for the soft body (no browser needed):
//   node tests/physics.test.mjs
import { loadCore, shapeError, shapeMax } from './core.mjs';

const Core = loadCore();
const C = Core.CFG;
const STEP = C.STEP;
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); };
const fmt = (x, d = 3) => (Number.isFinite(x) ? x.toFixed(d) : String(x));

// the page's default camera, used for the drag-plane normal like the UI does
const eye = (() => { const yaw = 0.6, pitch = 0.55, dist = 3.5; return [dist * Math.cos(pitch) * Math.sin(yaw), C.H + dist * Math.sin(pitch), dist * Math.cos(pitch) * Math.cos(yaw)]; })();
const norm = (v) => { const l = Math.hypot(...v); return v.map((q) => q / l); };

function freshSim({ drop = 0, tilt = 0, firm = 0.25, damp = 0.35 } = {}) {   // the page defaults
  const sim = new Core.Sim(C);
  sim.setFirmness(firm); sim.setDamping(damp);
  sim.reset(drop, tilt);
  return sim;
}
function track(sim) {
  return { minJ: Infinity, maxJ: -Infinity, vMin: Infinity, vMax: -Infinity, minY: Infinity, maxSpeed: 0, nan: false };
}
function stepFor(sim, seconds, tr, each) {
  const n = Math.round(seconds / STEP);
  for (let s = 0; s < n; s++) {
    if (each) each(s * STEP);
    sim.step(STEP);
    if (tr) {
      const st = sim.stats();
      tr.minJ = Math.min(tr.minJ, st.minJ); tr.maxJ = Math.max(tr.maxJ, st.maxJ);
      tr.vMin = Math.min(tr.vMin, st.volume); tr.vMax = Math.max(tr.vMax, st.volume);
      tr.minY = Math.min(tr.minY, st.minY); tr.maxSpeed = Math.max(tr.maxSpeed, st.maxSpeed);
      if (!Number.isFinite(st.ke)) tr.nan = true;
    }
  }
}
function settleTime(sim, maxSeconds, keThresh = 2e-5) {
  let quiet = 0;
  for (let s = 0; s < Math.round(maxSeconds / STEP); s++) {
    sim.step(STEP);
    if (sim.stats().ke < keThresh) { if (++quiet > 30) return (s - 30) * STEP; } else quiet = 0;
  }
  return Infinity;
}
function nodePos(sim, i) { return [sim.x[3 * i], sim.x[3 * i + 1], sim.x[3 * i + 2]]; }

// Drag an anchor along a path the way a pointer would: grab, glide the target, hold, release.
function drag(sim, anchor, delta, { glide = 0.35, hold = 1.2, twist = 0, tr } = {}) {
  const P = nodePos(sim, sim.anchors[anchor]);
  sim.beginGrab(P, norm([P[0] - eye[0], P[1] - eye[1], P[2] - eye[2]]), 0.2, 0.1);
  const T = [P[0] + delta[0], P[1] + delta[1], P[2] + delta[2]];
  stepFor(sim, glide, tr, (t) => {   // the pointer glides; the sim clamps and speed-limits like the page does
    const k = Math.min(1, t / glide), e = k * k * (3 - 2 * k);
    sim.setGrabGoal(P[0] + (T[0] - P[0]) * e, P[1] + (T[1] - P[1]) * e, P[2] + (T[2] - P[2]) * e);
    sim.grab.twist = twist * e;
  });
  stepFor(sim, hold, tr);
  const held = { shape: shapeError(sim), stats: sim.stats() };
  sim.endGrab();
  return held;
}

// ---------------------------------------------------------------- 1. settle
{
  const sim = freshSim({ drop: 0.32, tilt: 0.09 });
  const tr = track(sim);
  stepFor(sim, 0.8, tr);
  const t = settleTime(sim, 6);
  const st = sim.stats();
  check('drop: settles', t < 4, `settle ${fmt(t, 2)} s after landing`);
  check('drop: no floor penetration', tr.minY >= 0, `min node y ${fmt(tr.minY, 5)}`);
  check('drop: volume kept', Math.abs(st.volume - 1) < 0.02, `volume ${fmt(st.volume * 100, 2)} %`);
  check('drop: returns to rest shape', shapeError(sim) < 0.02, `shape rms ${fmt(shapeError(sim), 4)}`);
  check('drop: no resets', sim.resets === 0, `resets ${sim.resets}`);
}

// ---------------------------------------------------------------- 2. anchors × moves
const MOVES = { stretch: [1.2, 0, 0.3], lift: [0, 1.0, 0], toward: [0.3, 0.2, 0.9] };
for (const anchor of ['tip', 'cornerA', 'cornerB', 'flesh', 'rind']) {
  for (const [mv, delta] of Object.entries(MOVES)) {
    const sim = freshSim();
    stepFor(sim, 0.2);
    const tr = track(sim);
    const held = drag(sim, anchor, anchor === 'rind' && mv === 'stretch' ? [1.2, 0, -0.3] : delta, { tr });
    const tRel = settleTime(sim, 8);
    const ok = tr.minJ > 0.2 && tr.vMin > 0.88 && tr.vMax < 1.12 && !tr.nan && sim.resets === 0;
    check(`${anchor}/${mv}: stable while held`, ok,
      `minJ ${fmt(tr.minJ)} maxJ ${fmt(tr.maxJ)} vol ${fmt(tr.vMin * 100, 1)}–${fmt(tr.vMax * 100, 1)} % maxV ${fmt(tr.maxSpeed, 1)} shape ${fmt(held.shape, 3)}`);
    check(`${anchor}/${mv}: settles, no collapse`, tRel < 6 && shapeError(sim) < 0.03 && tr.minY > -1e-9,
      `settle ${fmt(tRel, 2)} s, rest shape rms ${fmt(shapeError(sim), 4)}, minY ${fmt(tr.minY, 4)}`);
  }
}

// ---------------------------------------------------------------- 3. local deformation & rind stiffness
{
  const sim = freshSim();
  stepFor(sim, 0.2);
  const len = (s) => { const a = nodePos(s, s.anchors.tip), b = nodePos(s, s.anchors.rind); return Math.hypot(a[0] - b[0], a[2] - b[2]); };
  const L0 = len(sim), P = nodePos(sim, sim.anchors.tip);
  sim.beginGrab(P, [0, 0, -1], 0.2, 0.1);
  let peak = 0;
  stepFor(sim, 0.6, null, (t) => { sim.setGrabGoal(P[0] - 0.6 * Math.min(1, t / 0.3), P[1], P[2]); peak = Math.max(peak, len(sim) / L0); });
  check('local deformation (pulling the tip stretches it)', peak > 1.1, `tip→rind length ×${fmt(peak, 3)} while pulled 0.6 along the floor; shape rms ${fmt(shapeError(sim))}`);
  sim.endGrab();
  const kF = [], kR = [];
  for (let t = 0; t < sim.nt; t++) (sim.kmul[t] > 1.5 ? kR : kF).push(sim.kmul[t]);
  check('rind firmer than flesh', kR.length > 0 && Math.min(...kR) > Math.max(...kF.filter((k) => k < 1.2)), `${kR.length} rind tets, stiffness ×${fmt(Math.max(...sim.kmul), 2)}`);
}

// ---------------------------------------------------------------- 4. release: wobble, then settle (no snap, no endless ring)
{
  const sim = freshSim();
  stepFor(sim, 0.2);
  drag(sim, 'tip', [0, 0.7, 0], { hold: 0.8 });
  const tipI = sim.anchors.tip, series = [];
  for (let s = 0; s < 600; s++) { sim.step(STEP); series.push(sim.x[3 * tipI + 1]); }
  let crossings = 0; const mean = series.slice(400).reduce((a, b) => a + b, 0) / 200;
  for (let i = 1; i < 360; i++) if ((series[i - 1] - mean) * (series[i] - mean) < 0) crossings++;
  const firstQuarter = Math.max(...series.slice(0, 30)) - Math.min(...series.slice(0, 30));
  check('release: visible wobble', crossings >= 2, `${crossings} mean-crossings of the tip in 3 s`);
  check('release: not an instant snap', firstQuarter > 0.05, `tip travel in first 0.25 s ${fmt(firstQuarter)}`);
  check('release: decays', sim.stats().ke < 2e-4, `KE after 5 s ${sim.stats().ke.toExponential(2)}`);
}

// ---------------------------------------------------------------- 5. twist, repeated grabs, fling
{
  const sim = freshSim(); stepFor(sim, 0.2);
  const tr = track(sim);
  drag(sim, 'tip', [0, 0.35, 0], { twist: 1.4, tr });
  drag(sim, 'cornerA', [0, 0.3, 0], { twist: -1.4, tr });
  check('twist ±1.4 rad stable', tr.minJ > 0.2 && sim.resets === 0 && !tr.nan, `minJ ${fmt(tr.minJ)} vol ${fmt(tr.vMin * 100, 1)}–${fmt(tr.vMax * 100, 1)} %`);
}
{
  const sim = freshSim(); stepFor(sim, 0.2);
  const tr = track(sim), rng = Core.mulberry32(7), names = ['tip', 'cornerA', 'cornerB', 'flesh', 'rind'];
  for (let k = 0; k < 30; k++) {
    const a = names[Math.floor(rng() * names.length)];
    drag(sim, a, [(rng() - 0.5) * 2, rng() * 1.2, (rng() - 0.5) * 2], { glide: 0.08 + rng() * 0.15, hold: 0.05 + rng() * 0.25, twist: (rng() - 0.5) * 2, tr });
  }
  const t = settleTime(sim, 8);
  check('30 rapid grabs: stable (never inverted)', tr.minJ > 0.05 && tr.vMin > 0.88 && !tr.nan && sim.resets === 0, `minJ ${fmt(tr.minJ)} vol ${fmt(tr.vMin * 100, 1)}–${fmt(tr.vMax * 100, 1)} % maxV ${fmt(tr.maxSpeed, 1)}`);
  check('30 rapid grabs: settles intact', t < 6 && shapeError(sim) < 0.03 && tr.minY > -1e-9, `settle ${fmt(t, 2)} s, shape ${fmt(shapeError(sim), 4)}, minY ${fmt(tr.minY, 5)}`);
}
{
  const sim = freshSim(); stepFor(sim, 0.2);
  const tr = track(sim);
  drag(sim, 'flesh', [0.6, 1.6, 0.4], { glide: 0.06, hold: 0.0, tr });
  let peak = 0;
  stepFor(sim, 3, tr, () => { peak = Math.max(peak, sim.stats().maxY); });
  const t = settleTime(sim, 8);
  check('fling: lands and stays in the pen', !tr.nan && sim.resets === 0 && tr.minY > -1e-9, `peak y ${fmt(peak, 2)}, minY ${fmt(tr.minY, 5)}, maxV ${fmt(tr.maxSpeed, 1)}`);
  check('fling: settles intact', t < 8 && shapeError(sim) < 0.03, `settle ${fmt(t, 2)} s, shape ${fmt(shapeError(sim), 4)}`);
}

// ---------------------------------------------------------------- 6. slider extremes
for (const firm of [0, 1]) for (const damp of [0, 1]) {
  const sim = freshSim({ firm, damp }); stepFor(sim, 0.2);
  const tr = track(sim);
  drag(sim, 'tip', [1.0, 0.8, 0.2], { tr });
  drag(sim, 'rind', [-0.5, 0.6, 0.5], { tr });
  const t = settleTime(sim, 12);
  check(`firmness ${firm} / damping ${damp}`, tr.minJ > 0.15 && !tr.nan && sim.resets === 0 && t < 10 && shapeError(sim) < 0.04,
    `minJ ${fmt(tr.minJ)} vol ${fmt(tr.vMin * 100, 1)}–${fmt(tr.vMax * 100, 1)} % settle ${fmt(t, 2)} s shape ${fmt(shapeError(sim), 4)}`);
}

// ---------------------------------------------------------------- 7. nudges
for (let k = 0; k < 4; k++) {
  const sim = freshSim(); stepFor(sim, 0.2);
  const tr = track(sim);
  sim.nudge(k, 1);
  stepFor(sim, 0.6, tr);
  const t = settleTime(sim, 6);
  check(`nudge ${k}`, !tr.nan && tr.minJ > 0.2 && t < 5 && shapeError(sim) < 0.03, `minJ ${fmt(tr.minJ)} settle ${fmt(t, 2)} s`);
}

// ---------------------------------------------------------------- 7b. regressions found by review
// (a) a squashed corner used to become a fixed point of the volume constraint at J = J_MIN
{
  const sim = freshSim({ firm: 0.45, damp: 0.5 }); stepFor(sim, 0.2);
  const P = nodePos(sim, sim.anchors.cornerA);
  sim.beginGrab(P, norm([P[0] - eye[0], P[1] - eye[1], P[2] - eye[2]]), 0.2, 0.1);
  stepFor(sim, 0.6, null, () => sim.setGrabGoal(1.5, 2, 1.2));
  sim.endGrab();
  stepFor(sim, 10);
  const st = sim.stats();
  check('regression: no crushed corner after a yank', st.minJ > 0.9 && shapeMax(sim) < 0.03, `minJ ${fmt(st.minJ)} 10 s later, worst node off rest ${fmt(shapeMax(sim), 4)}`);
}
// (b) flinging a corner sideways used to leave it folded over for good
{
  let worst = 0;
  for (const deg of [180, 225, 135, 270]) {
    const sim = freshSim({ drop: 0.3, tilt: 0.09, firm: 0.45, damp: 0 }); stepFor(sim, 1.5);
    const P = nodePos(sim, sim.anchors.cornerB), a = (deg * Math.PI) / 180;
    sim.beginGrab(P, norm([P[0] - eye[0], P[1] - eye[1], P[2] - eye[2]]), 0.2, 0.1);
    stepFor(sim, 0.12, null, (t) => { const k = Math.min(1, t / 0.12); sim.setGrabGoal(P[0] + 2.2 * Math.cos(a) * k, P[1], P[2] + 2.2 * Math.sin(a) * k); });
    sim.endGrab();
    stepFor(sim, 4);
    worst = Math.max(worst, shapeMax(sim));
  }
  check('regression: flung corners unfold', worst < 0.05, `worst node off rest ${fmt(worst, 4)} after 4 s (4 directions)`);
}
// (c) seeded fling scan: nothing inverts, everything recovers
{
  const rng = Core.mulberry32(2026), names = ['tip', 'cornerA', 'cornerB', 'flesh', 'rind'];
  let stuck = 0, worstJ = Infinity, worstEnd = Infinity, refits = 0;
  for (let k = 0; k < 60; k++) {
    const firm = [0, 0.25, 0.45, 1][k % 4], sim = freshSim({ firm, damp: rng() }); stepFor(sim, 0.2);
    const P = nodePos(sim, sim.anchors[names[k % 5]]);
    sim.beginGrab(P, norm([P[0] - eye[0], P[1] - eye[1], P[2] - eye[2]]), 0.2, 0.1);
    const G = [(rng() - 0.5) * 4, rng() * 2.4, (rng() - 0.5) * 4], tw = (rng() - 0.5) * 2.8, dur = 0.05 + rng() * 0.3;
    stepFor(sim, dur + rng() * 0.5, null, (t) => {
      const e = Math.min(1, t / dur);
      sim.setGrabGoal(P[0] + (G[0] - P[0]) * e, P[1] + (G[1] - P[1]) * e, P[2] + (G[2] - P[2]) * e);
      sim.grab.twist = tw * e;
      worstJ = Math.min(worstJ, sim.stats().minJ);
    });
    sim.endGrab();
    stepFor(sim, 10);
    const st = sim.stats();
    worstEnd = Math.min(worstEnd, st.minJ); refits += sim.refits;
    if (st.minJ < 0.6 || st.ke * 10.5 >= 0.005) stuck++;
  }
  check('regression: 60 random flings recover', stuck === 0 && worstJ > -0.05, `${stuck} stuck after 10 s, worst J while held ${fmt(worstJ)}, worst J at rest ${fmt(worstEnd)}, fold re-fits ${refits}`);
}

// ---------------------------------------------------------------- 8. geometry & embedding
{
  const sim = freshSim();
  const rm = Core.buildRenderMesh(C);
  const edges = new Map();
  for (let t = 0; t < rm.indices.length; t += 3) for (let e = 0; e < 3; e++) {
    const a = rm.indices[t + e], b = rm.indices[t + ((e + 1) % 3)];
    const key = a < b ? `${a},${b}` : `${b},${a}`;
    edges.set(key, (edges.get(key) || 0) + (a < b ? 1 : -1));
  }
  let bad = 0; for (const v of edges.values()) if (v !== 0) bad++;
  check('render mesh closed & consistently wound', bad === 0, `${rm.count} verts, ${rm.indices.length / 3} tris, ${bad} unpaired edges`);
  let neg = 0; for (let t = 0; t < sim.nt; t++) if (!(sim.V0[t] > 0)) neg++;
  check('lattice: all tets positive', neg === 0, `${sim.nt} tets, ${neg} non-positive`);
  const sk = Core.computeSkin(sim.rest, sim.n, rm.positions, rm.count, 8);
  const frames = sim.computeNodeFrames(sim.rest, new Float32Array(sim.n * 16));
  let err = 0; const out = [0, 0, 0];
  for (let i = 0; i < rm.count; i++) {
    Core.embedPoint(frames, sim.rest, sk.idx, sk.wt, 8 * i, rm.positions[3 * i], rm.positions[3 * i + 1], rm.positions[3 * i + 2], out);
    err = Math.max(err, Math.hypot(out[0] - rm.positions[3 * i], out[1] - rm.positions[3 * i + 1], out[2] - rm.positions[3 * i + 2]));
  }
  check('embedding reproduces rest surface', err < 1e-5, `max error ${err.toExponential(2)}`);
}

// ---------------------------------------------------------------- 9. cost
{
  const sim = freshSim(); stepFor(sim, 0.5);
  const t0 = performance.now(); for (let k = 0; k < 240; k++) sim.step(STEP);
  const per = (performance.now() - t0) / 240;
  const buf = new Float32Array(sim.n * 16), t1 = performance.now();
  for (let k = 0; k < 240; k++) sim.computeNodeFrames(sim.x, buf);
  const fr = (performance.now() - t1) / 240;
  check('cost per 120 Hz step (machine-dependent)', per < 6, `${fmt(per, 3)} ms/step (${sim.nt} tets × ${C.SUBSTEPS} substeps), node frames ${fmt(fr, 3)} ms`);
}

const w = Math.max(...results.map((r) => r.name.length));
let fails = 0;
for (const r of results) { if (!r.ok) fails++; console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(w)}  ${r.detail}`); }
console.log(`\n${results.length - fails}/${results.length} passed`);
process.exit(fails ? 1 : 0);
