// Loads the DOM-free simulation core straight out of melon-jelly.html so the
// tests always exercise the shipped code.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const HTML_PATH = process.env.MELON_HTML || fileURLToPath(new URL('../melon-jelly.html', import.meta.url));

export function loadCore() {
  const html = readFileSync(HTML_PATH, 'utf8');
  const m = html.match(/<script id="melon-core">([\s\S]*?)<\/script>/);
  if (!m) throw new Error('melon-core script block not found');
  // evaluate in the main realm (a vm sandbox distorts typed-array performance)
  (0, eval)(m[1]);
  return globalThis.MelonCore;
}

// Best rigid fit (Kabsch via polar decomposition) of the current shape onto
// the rest shape; returns the RMS residual, i.e. how deformed the body is.
export function shapeError(sim) { return shapeFit(sim).rms; }
// Largest single-node distance from that rigid fit: catches a folded corner that the RMS hides.
export function shapeMax(sim) { return shapeFit(sim).max; }

function shapeFit(sim) {
  const n = sim.n, a = sim.rest, b = sim.x, m = sim.mass;
  let M = 0; const ca = [0, 0, 0], cb = [0, 0, 0];
  for (let i = 0; i < n; i++) { M += m[i]; for (let k = 0; k < 3; k++) { ca[k] += m[i] * a[3 * i + k]; cb[k] += m[i] * b[3 * i + k]; } }
  for (let k = 0; k < 3; k++) { ca[k] /= M; cb[k] /= M; }
  const H = new Array(9).fill(0);   // Σ m (b - cb)(a - ca)ᵀ  (row-major)
  for (let i = 0; i < n; i++) for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
    H[3 * r + c] += m[i] * (b[3 * i + r] - cb[r]) * (a[3 * i + c] - ca[c]);
  }
  let R = H.slice();
  for (let it = 0; it < 60; it++) {       // Higham: R ← ½(R + R⁻ᵀ)
    const [p, q, s, t, u, v, w, x, y] = R;
    const det = p * (u * y - v * x) - q * (t * y - v * w) + s * (t * x - u * w);
    if (Math.abs(det) < 1e-18) break;
    const cof = [u * y - v * x, -(t * y - v * w), t * x - u * w, -(q * y - s * x), p * y - s * w, -(p * x - q * w), q * v - s * u, -(p * v - s * t), p * u - q * t];
    R = R.map((val, i) => 0.5 * (val + cof[i] / det));
  }
  let err = 0, max = 0;
  for (let i = 0; i < n; i++) {
    const d = [a[3 * i] - ca[0], a[3 * i + 1] - ca[1], a[3 * i + 2] - ca[2]];
    let e2 = 0;
    for (let r = 0; r < 3; r++) {
      const pr = R[3 * r] * d[0] + R[3 * r + 1] * d[1] + R[3 * r + 2] * d[2] + cb[r];
      e2 += (pr - b[3 * i + r]) ** 2;
    }
    err += m[i] * e2;
    max = Math.max(max, Math.sqrt(e2));
  }
  return { rms: Math.sqrt(err / M), max };
}
