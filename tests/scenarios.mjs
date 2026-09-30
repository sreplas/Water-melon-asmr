// The manual scenarios from the brief, driven with real pointer events; screenshots in tests/out/sc-*.png.
import { mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer-core';

const HTML = fileURLToPath(new URL('../melon-jelly.html', import.meta.url));
const OUT = fileURLToPath(new URL('./out/', import.meta.url));
mkdirSync(OUT, { recursive: true });
const CHROME = [process.env.CHROME, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].filter(Boolean).find((p) => existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist'] });
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`); };
const page = await browser.newPage();
const logs = [];
page.on('console', (m) => { if (m.type() === 'error') logs.push(m.text()); });
page.on('pageerror', (e) => logs.push('pageerror: ' + e.message));
await page.setViewport({ width: 1440, height: 900 });
await page.goto(pathToFileURL(HTML).href);
await page.waitForFunction(() => window.__melon && (window.__melon.ready || window.__melon.failed), { timeout: 30000 });
const M = (fn, ...a) => page.evaluate(fn, ...a);
const anchors = () => M(() => __melon.anchors());
const state = () => M(() => ({ ...__melon.toolState(), inv: __melon.invariants(), st: __melon.stats() }));
const idle = async () => { for (let k = 0; k < 400; k++) { const s = await M(() => __melon.toolState()); if (!s.busy && s.knife !== 'pass' && s.spoon !== 'wait' && s.mallet === 'idle') return; await sleep(25); } };
async function shot(name) {
  const b = await M(() => __melon.screenBounds());
  const pad = 70, x = Math.max(0, b.left - pad), y = Math.max(0, b.top - pad);
  await page.screenshot({ path: OUT + `sc-${name}.png`, clip: { x, y, width: Math.min(1440 - x, b.right - b.left + 2 * pad), height: Math.min(900 - y, b.bottom - b.top + 2 * pad) } });
}
async function stroke(a, b, steps = 16) {
  await page.mouse.move(a.x, a.y); await page.mouse.down();
  for (let i = 1; i <= steps; i++) { await page.mouse.move(a.x + ((b.x - a.x) * i) / steps, a.y + ((b.y - a.y) * i) / steps); await sleep(16); }
  await page.mouse.up(); await sleep(60); await idle(); await sleep(900);
  console.log('   bodies', JSON.stringify(await M(() => { const sc = __melon.scene, sim = sc.sim, out = []; for (let b = 0; b < sim.nb; b++) out.push([sim.bodyTetN[b], +sim.bodyVolume[b].toFixed(4), sc.fading[b], +sc.fade[b].toFixed(2)]); return out; })));
}
async function scoop(p, d = { x: 14, y: 4 }) {
  await page.keyboard.press('s'); await sleep(100);
  await page.mouse.move(p.x, p.y); await sleep(80); await page.mouse.down();
  for (let i = 1; i <= 8; i++) { await page.mouse.move(p.x + (d.x * i) / 8, p.y + (d.y * i) / 8); await sleep(20); }
  await page.mouse.up(); await sleep(60); await idle(); await sleep(500);
  const s = await state();
  if (s.spoon === 'carry') { await page.mouse.move(p.x + 260, p.y - 160); await sleep(500); await page.mouse.down(); await page.mouse.up(); await sleep(1200); }
  return s;
}
async function strike(p, holdMs = 0) {
  await page.keyboard.press('m'); await sleep(100);
  await page.mouse.move(p.x, p.y); await sleep(150);
  await page.mouse.down(); await sleep(holdMs || 40); await page.mouse.up();
  await sleep(holdMs ? 260 : 230); const mid = await state(); await idle(); await sleep(700);
  return mid;
}
const healthy = (s) => s.inv.length === 0 && s.st.minJ > 0.05;
await sleep(2500);

// ---- knife
await page.keyboard.press('k');
let a = await anchors();
await stroke({ x: a.tip.x + 70, y: a.tip.y - 260 }, { x: a.tip.x + 40, y: a.tip.y + 260 });
let s = await state();
check('cut near the tip makes a small piece', s.pieces === 2 && healthy(s), `pieces ${s.pieces}, inv ${s.inv.join(';')}`);
await shot('tip-cut');
a = await anchors();
await stroke({ x: a.flesh.x - 420, y: a.flesh.y - 110 }, { x: a.flesh.x + 440, y: a.flesh.y + 110 });
s = await state();
check('cut through the seeds', s.pieces >= 3 && healthy(s), `pieces ${s.pieces}`);
await shot('seed-cut');
a = await anchors();
const rindMid = a.rind;
await stroke({ x: rindMid.x - 60, y: rindMid.y - 200 }, { x: rindMid.x - 60, y: rindMid.y + 200 });
s = await state();
check('cut along the rind', healthy(s), `pieces ${s.pieces}`);
await shot('rind-cut');
await page.keyboard.press('r'); await sleep(2500);
const before = 1;
a = await anchors();
await stroke({ x: a.center.x - 40, y: a.center.y - 240 }, { x: a.center.x - 10, y: a.center.y - 10 });
s = await state();
check('partial stroke leaves an incision (no new piece)', s.pieces === before && healthy(s), `pieces ${before} → ${s.pieces}`);
await shot('incision');

// ---- spoon
await page.keyboard.press('r'); await sleep(2500);
a = await anchors();
let r1 = await scoop({ x: (a.cornerA.x * 3 + a.flesh.x) / 4, y: (a.cornerA.y * 3 + a.flesh.y) / 4 });
check('scoop at an edge', r1.spoon === 'carry' || r1.spoon === 'lift', `spoon ${r1.spoon}`);
a = await anchors();
r1 = await scoop({ x: a.rind.x - 10, y: a.rind.y - 30 });
check('scoop through the rind', r1.spoon === 'carry' || r1.spoon === 'lift', `spoon ${r1.spoon}`);
a = await anchors();
const fl = a.flesh;
r1 = await scoop(fl);
const r2 = await scoop({ x: fl.x + 6, y: fl.y + 2 });
s = await state();
check('scoop inside a previous scoop', healthy(s) && (r1.spoon === 'carry' || r1.spoon === 'lift'), `first ${r1.spoon}, second ${r2.spoon}, pieces ${s.pieces}`);
await page.keyboard.press('h'); await sleep(1500);
await shot('scoops');
const massAfter = await M(() => document.getElementById('roMass').textContent);
check('mass readout falls only as material leaves', +massAfter <= 204, `mass ${massAfter} g`);

// discard with Esc
a = await anchors();
await page.keyboard.press('s'); await page.mouse.move(a.tip.x + 60, a.tip.y); await page.mouse.down(); await sleep(60); await page.mouse.up(); await idle(); await sleep(400);
const carrying = (await state()).spoon;
await page.keyboard.press('Escape'); await sleep(900);
s = await state();
check('Esc discards the scoop with a fade', (carrying === 'carry' || carrying === 'lift') && s.spoon === 'idle' && healthy(s), `was ${carrying}, now ${s.spoon}, pieces ${s.pieces}`);

// ---- mallet
await page.keyboard.press('r'); await sleep(2500);
a = await anchors();
let mid = await strike({ x: a.tip.x * 0.8 + a.center.x * 0.2, y: a.tip.y * 0.8 + a.center.y * 0.2 });
check('mallet on the tip', healthy(mid) && mid.st.minJ < 0.95, `minJ during ${mid.st.minJ.toFixed(2)}`);
mid = await strike({ x: a.rind.x - 20, y: a.rind.y - 20 }, 900);
check('charged strike on the rind throws juice', mid.drops > 0 && healthy(mid), `drops ${mid.drops}`);
await page.keyboard.press('k'); a = await anchors();
await stroke({ x: a.tip.x + 80, y: a.tip.y - 120 }, { x: a.tip.x + 50, y: a.tip.y + 120 });
a = await anchors();
mid = await strike({ x: a.tip.x + 10, y: a.tip.y });
s = await state();
check('mallet on a small piece', healthy(s), `pieces ${s.pieces}`);
// squash: press and drag down
await page.keyboard.press('m'); a = await anchors();
await page.mouse.move(a.flesh.x, a.flesh.y); await page.mouse.down();
for (let i = 1; i <= 12; i++) { await page.mouse.move(a.flesh.x, a.flesh.y + i * 6); await sleep(30); }
await sleep(300);
const sq = await state();
await page.screenshot({ path: OUT + 'sc-squash.png' });
await page.mouse.up(); await idle(); await sleep(1200);
check('press and drag down squashes', sq.mallet === 'squash' && sq.st.minJ < 0.9 && sq.inv.length === 0, `mallet ${sq.mallet}, minJ ${sq.st.minJ.toFixed(2)}`);

// ---- stacked pieces: lift one piece onto another
await page.keyboard.press('h'); a = await anchors();
await page.mouse.move(a.tip.x, a.tip.y); await page.mouse.down();
for (let i = 1; i <= 20; i++) { await page.mouse.move(a.tip.x + ((a.center.x - a.tip.x) * i) / 20, a.tip.y + ((a.center.y - 140 - a.tip.y) * i) / 20); await sleep(20); }
await sleep(300); await page.mouse.up(); await sleep(3000);
s = await state();
check('stacked pieces settle without exploding', healthy(s) && s.st.ke < 0.05, `ke ${s.st.ke.toExponential(1)}`);
await shot('stacked');

// ---- presets and sliders after surgery
for (const v of ['1', '2', '0']) { await page.evaluate((x) => document.querySelector(`input[name=preset][value="${x}"]`).click(), v); await sleep(500); }
await page.evaluate(() => { for (const [i, v] of [['firm', 90], ['damp', 10]]) { const el = document.getElementById(i); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); } });
await page.keyboard.press('n'); await sleep(2000);
s = await state();
check('presets and sliders apply to every piece', healthy(s), `pieces ${s.pieces}`);
await page.evaluate(() => { for (const [i, v] of [['firm', 25], ['damp', 35]]) { const el = document.getElementById(i); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); } });

// ---- repeated reset
let allPristine = true;
for (let k = 0; k < 4; k++) {
  await page.keyboard.press('k'); a = await anchors();
  await stroke({ x: a.center.x - 30, y: a.center.y - 250 }, { x: a.center.x + 10, y: a.center.y + 250 }, 8);
  await page.keyboard.press('r'); await sleep(300);
  allPristine = allPristine && await M(() => __melon.matchesPristine());
}
s = await state();
check('repeated cut + Reset returns the pristine slice', allPristine && s.pieces === 1, `pieces ${s.pieces}`);

const t = await M(() => __melon.timing());
check('no frame over 50 ms', t.frame < 50, JSON.stringify(t));
check('no errors', logs.length === 0 && (await M(() => __melon.errors)).length === 0, logs.slice(0, 3).join(' | '));
await browser.close();
const fails = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - fails}/${results.length} passed`);
process.exit(fails ? 1 : 0);
