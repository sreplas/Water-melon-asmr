// End-to-end checks in real Chrome with WebGPU (headless works on most desktops):
//   cd tests && npm install && node browser.test.mjs
// CHROME=/path/to/chrome overrides the browser; MELON_HTML overrides the page.
import { mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer-core';

const HTML = process.env.MELON_HTML || fileURLToPath(new URL('../melon-jelly.html', import.meta.url));
const URL_ = pathToFileURL(HTML).href;
const OUT = fileURLToPath(new URL('./out/', import.meta.url));
mkdirSync(OUT, { recursive: true });
const CANDIDATES = [
  process.env.CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].filter(Boolean);
const CHROME = CANDIDATES.find((p) => existsSync(p));
if (!CHROME) { console.error('No Chrome/Edge found; set CHROME=/path/to/browser'); process.exit(2); }

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist'], protocolTimeout: 600000 });

async function open(viewport, { reduce = false, noGpu = false, nullAdapter = false } = {}) {
  const page = await browser.newPage();
  const logs = [];
  page.on('console', (m) => { if (m.type() === 'error') logs.push(m.text()); });
  page.on('pageerror', (e) => logs.push('pageerror: ' + e.message));
  // window-level errors (e.g. "ResizeObserver loop …") never reach pageerror
  await page.evaluateOnNewDocument(() => { window.__winErrors = []; addEventListener('error', (e) => window.__winErrors.push(String(e.message))); });
  if (noGpu) await page.evaluateOnNewDocument(() => { delete Object.getPrototypeOf(navigator).gpu; });
  if (nullAdapter) await page.evaluateOnNewDocument(() => { if (navigator.gpu) navigator.gpu.requestAdapter = async () => null; });
  await page.setViewport(viewport);
  if (reduce) await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.goto(URL_);
  await page.waitForFunction(() => window.__melon && (window.__melon.ready || window.__melon.failed), { timeout: 30000 });
  return { page, logs };
}
const M = (page, fn, ...a) => page.evaluate(fn, ...a);
async function settle(page, ms = 2600) { await sleep(ms); }
async function health(page, label) {
  const r = await M(page, async () => ({ errs: __melon.errors.slice(), st: __melon.stats(), rb: await __melon.readback() }));
  const ok = r.errs.length === 0 && r.rb.nan === 0 && r.rb.minY > -0.005 && r.rb.maxErr < 1e-4 && r.rb.instErr < 1e-4 && r.rb.orthoErr < 1e-3 && r.st.minJ > 0.05;
  check(`${label}: healthy`, ok, `errors ${r.errs.length}, NaN ${r.rb.nan}, surface minY ${r.rb.minY.toFixed(4)}, seeds err ${r.rb.instErr.toExponential(1)}, minJ ${r.st.minJ.toFixed(2)}, vol ${(r.st.volume * 100).toFixed(1)} %`);
  return r;
}
async function dragMouse(page, from, to, { steps = 24, wheel = 0, holdMs = 400 } = {}) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  let grabbed = false;
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps);
    await sleep(16);
    if (i === 2) grabbed = await M(page, () => __melon.grabbing());
    if (wheel && i === steps >> 1) await page.mouse.wheel({ deltaY: wheel });
  }
  const mid = await M(page, () => __melon.stats());
  await sleep(holdMs);
  await page.mouse.up();
  return { grabbed, mid };
}

// ------------------------------------------------------------------ desktop
{
  const { page, logs } = await open({ width: 1440, height: 900, deviceScaleFactor: 1 });
  const status = await M(page, () => document.getElementById('statusText').textContent);
  check('renderer starts, status says LIVE', status === 'WEBGPU · LIVE', status);
  await settle(page, 3000);
  await health(page, 'at rest');
  await page.screenshot({ path: OUT + 'desktop-rest.png' });

  for (const [name, dx, dy] of [['tip', -260, -40], ['cornerA', 60, -260], ['cornerB', 220, 120], ['flesh', -40, -300], ['rind', 300, -60]]) {
    const a = (await M(page, () => __melon.anchors()))[name];
    const r = await dragMouse(page, a, { x: a.x + dx, y: a.y + dy });
    check(`drag from ${name}: grabs`, r.grabbed, `at ${a.x.toFixed(0)},${a.y.toFixed(0)}`);
    check(`drag from ${name}: sane while stretched`, r.mid.minJ > 0.05 && r.mid.volume > 0.88 && r.mid.volume < 1.12, `minJ ${r.mid.minJ.toFixed(2)} vol ${(r.mid.volume * 100).toFixed(1)} %`);
    await settle(page, 1800);
  }
  await health(page, 'after anchor drags');

  // twist with the wheel, and a drag that leaves the window (pointer capture)
  let a = (await M(page, () => __melon.anchors())).tip;
  const tw = await dragMouse(page, a, { x: a.x - 60, y: a.y - 160 }, { wheel: -400 });
  check('twist while holding', tw.grabbed && tw.mid.minJ > 0.05, `minJ ${tw.mid.minJ.toFixed(2)}`);
  await settle(page, 1500);
  a = (await M(page, () => __melon.anchors())).flesh;
  await page.mouse.move(a.x, a.y); await page.mouse.down(); await sleep(30);
  const began = await M(page, () => __melon.grabbing());
  for (let i = 1; i <= 20; i++) { await page.mouse.move(a.x + i * 60, a.y - i * 40); await sleep(16); }
  const still = await M(page, () => __melon.grabbing());
  await page.mouse.up(); await sleep(30);
  const ended = !(await M(page, () => __melon.grabbing()));
  check('drag continues outside the window (pointer capture)', began && still && ended, `began ${began}, still grabbing at ${(a.x + 1200).toFixed(0)},${(a.y - 800).toFixed(0)}: ${still}, released: ${ended}`);
  await settle(page, 2500);

  // repeated fast grabs and releases
  for (let k = 0; k < 12; k++) {
    const an = await M(page, () => __melon.anchors());
    const p = [an.tip, an.cornerA, an.cornerB, an.flesh, an.rind][k % 5];
    await dragMouse(page, p, { x: p.x + ((k * 97) % 300) - 150, y: p.y - 120 - (k % 3) * 60 }, { steps: 6, holdMs: 30 });
  }
  const keAfter = await M(page, () => __melon.stats().ke);
  await settle(page, 7000);
  const rest = await health(page, 'after 12 rapid grabs');
  check('returns to a stable rest', rest.st.ke < 2e-4 && rest.st.ke < keAfter, `KE ${keAfter.toExponential(1)} → ${rest.st.ke.toExponential(1)}`);

  // controls (from a fresh rest pose so every drag starts on the slice)
  await page.click('#reset'); await settle(page, 3000);
  const presetsOk = [];
  for (let i = 0; i < 3; i++) { await page.click(`input[name=preset][value="${i}"]`, { offset: undefined }).catch(() => page.evaluate((j) => document.querySelector(`input[name=preset][value="${j}"]`).click(), i)); await sleep(600); presetsOk.push(await M(page, () => document.querySelector('input[name=preset]:checked').value)); await page.screenshot({ path: OUT + `preset-${i}.png` }); }
  check('presets switch', presetsOk.join() === '0,1,2', presetsOk.join());
  await page.evaluate(() => document.querySelector('input[name=preset][value="0"]').click());
  for (const [id, out] of [['firm', 'firmOut'], ['damp', 'dampOut']]) {
    const vals = [];
    for (const v of [0, 100, 50]) {
      await page.evaluate((i, val) => { const el = document.getElementById(i); el.value = val; el.dispatchEvent(new Event('input', { bubbles: true })); }, id, v);
      vals.push(await M(page, (o) => document.getElementById(o).textContent, out));
      const f = (await M(page, () => __melon.anchors())).flesh;
      const r = await dragMouse(page, f, { x: f.x - 120, y: f.y - 160 }, { steps: 10, holdMs: 100 });
      await settle(page, 1200);
      if (!r.grabbed) vals.push('(no grab)');
    }
    check(`${id} slider updates value and stays stable`, new Set(vals).size >= 3 && !vals.includes('(no grab)'), vals.join(' → '));
  }
  await page.evaluate(() => { for (const [i, v] of [['firm', 45], ['damp', 50]]) { const el = document.getElementById(i); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); } });
  await page.click('#nudge'); await sleep(250);
  const kn = await M(page, () => __melon.stats().ke);
  check('nudge adds motion', kn > 1e-3, `KE ${kn.toExponential(1)}`);
  const lifted = await M(page, () => { document.getElementById('reset').click(); return __melon.sim.stats().minY; });
  check('reset lifts and drops the slice', lifted > 0.05, `lowest point right after reset ${lifted.toFixed(3)}`);
  await settle(page, 3000);
  await page.click('#slow'); await page.click('#nudge'); await sleep(1000);
  const slowKE = await M(page, () => __melon.stats().ke);
  await page.click('#slow');
  check('¼ speed runs', slowKE > 0, `KE ${slowKE.toExponential(1)}`);
  await settle(page, 3500);
  await page.click('#mesh'); await sleep(400); await page.screenshot({ path: OUT + 'mesh.png' }); await page.click('#mesh');
  await page.click('#pause');
  const f0 = await M(page, () => __melon.stats().ke), label = await M(page, () => document.getElementById('pause').textContent);
  await page.click('#nudge'); await sleep(300); await page.click('#pause'); await sleep(50); await page.click('#pause');
  check('pause/resume', label === 'Resume', `label ${label}, KE ${f0.toExponential(1)}`);
  // shortcuts: N/R work even with a button focused; Space pauses when no control is focused
  await page.keyboard.press('n'); await sleep(150);
  const kN = await M(page, () => __melon.stats().ke);
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  await page.keyboard.press(' ');
  const kbPaused = await M(page, () => __melon.paused);
  await page.keyboard.press(' ');
  check('keyboard shortcuts', kN > 1e-3 && kbPaused === true && !(await M(page, () => __melon.paused)), `KE after N ${kN.toExponential(1)}`);
  await page.click('#notes summary'); await sleep(200);
  check('"Inside the experiment" opens', await M(page, () => document.getElementById('notes').open));
  await settle(page, 3000);
  await health(page, 'after all controls');
  const winErr = await M(page, () => window.__winErrors);
  check('no console or window errors (desktop)', logs.length === 0 && winErr.length === 0, logs.concat(winErr).slice(0, 3).join(' | '));
  await page.close();
}

// ------------------------------------------------------------------ touch
{
  const { page, logs } = await open({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await settle(page, 3000);
  const cdp = await page.createCDPSession();
  const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map((p, i) => ({ x: p.x, y: p.y, id: i })) });
  let a = (await M(page, () => __melon.anchors())).tip;
  await touch('touchStart', [a]);
  for (let i = 1; i <= 15; i++) { await touch('touchMove', [{ x: a.x - i * 4, y: a.y - i * 12 }]); await sleep(16); }
  const g1 = await M(page, () => __melon.grabbing());
  const b = { x: a.x - 60, y: a.y - 180 };
  await touch('touchMove', [b, { x: b.x + 90, y: b.y }]);
  for (let i = 1; i <= 10; i++) { const ang = i * 0.08; await touch('touchMove', [b, { x: b.x + 90 * Math.cos(ang), y: b.y + 90 * Math.sin(ang) }]); await sleep(16); }
  const tw = await M(page, () => __melon.sim.grab.twist);
  await touch('touchEnd', []);
  check('touch drag grabs', g1);
  check('two-finger twist follows the fingers', tw > 0.3, `fingers turned clockwise → twist ${tw.toFixed(2)} rad (positive = clockwise on screen)`);
  await settle(page, 3000);
  await health(page, 'after touch');
  check('no console errors (touch)', logs.length === 0, logs.slice(0, 3).join(' | '));
  await page.close();
}

// ------------------------------------------------------------------ tools (desktop)
{
  const { page, logs } = await open({ width: 1440, height: 900, deviceScaleFactor: 1 });
  await settle(page, 2500);
  const ts = () => M(page, () => ({ ...__melon.toolState(), inv: __melon.invariants(), st: __melon.stats() }));
  const idle = async () => { for (let k = 0; k < 400; k++) { const s = await M(page, () => __melon.toolState()); if (!s.busy && s.knife !== 'pass' && s.spoon !== 'wait' && s.mallet === 'idle') return; await sleep(25); } };
  const pressed = () => M(page, () => [...document.querySelectorAll('.tool')].filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.dataset.tool).join());
  // rail + shortcuts + hint + cursor
  const seen = [];
  for (const [key, name] of [['2', 'knife'], ['3', 'mallet'], ['4', 'spoon'], ['1', 'hand'], ['k', 'knife'], ['m', 'mallet'], ['s', 'spoon'], ['h', 'hand']]) {
    await page.keyboard.press(key); await sleep(60);
    seen.push((await M(page, () => __melon.tool())) === name && (await pressed()) === name);
  }
  check('tools: keys 1–4 and H K M S select tools', seen.every(Boolean), seen.join());
  await page.click('.tool[data-tool="mallet"]'); await sleep(80);
  const ui = await M(page, () => ({ tool: __melon.tool(), hint: document.querySelector('.hint .desk').textContent, cursor: getComputedStyle(document.getElementById('stage')).cursor }));
  check('tools: rail button selects, hint and cursor follow the tool', ui.tool === 'mallet' && /strike/i.test(ui.hint) && /url\(/.test(ui.cursor), `${ui.tool} · "${ui.hint.slice(0, 40)}…"`);
  const railR = await M(page, () => { const r = document.getElementById('tools').getBoundingClientRect(), m = document.querySelector('.masthead').getBoundingClientRect(), f = document.getElementById('foot').getBoundingClientRect(); return { left: r.left, top: r.top, bottom: r.bottom, mb: m.bottom, ft: f.top }; });
  check('tools: rail on the left edge, between title and readouts', railR.left < 60 && railR.top > railR.mb && railR.bottom < railR.ft, JSON.stringify(railR));
  await M(page, () => __melon.resetFrameMax());

  // mallet
  let a = await M(page, () => __melon.anchors());
  const fp = { x: a.flesh.x * 0.7 + a.center.x * 0.3, y: a.flesh.y * 0.7 + a.center.y * 0.3 };
  await page.mouse.move(fp.x, fp.y); await sleep(200);
  const hoverDraws = (await ts()).draws;
  await page.mouse.down(); await sleep(40); await page.mouse.up(); await sleep(230);
  const hit = await ts();
  await idle(); await settle(page, 1800);
  const after = await ts();
  check('mallet: 3D head follows the pointer; a click strikes, dents and recovers', hoverDraws >= 2 && hit.st.minJ < 0.97 && hit.inv.length === 0 && after.st.minJ > 0.85 && after.pieces === 1, `draws ${hoverDraws}, minJ at impact ${hit.st.minJ.toFixed(2)} → ${after.st.minJ.toFixed(2)}`);

  // knife
  await page.keyboard.press('k'); a = await M(page, () => __melon.anchors());
  await page.mouse.move(a.center.x + 20, a.center.y - 330); await page.mouse.down();
  for (let i = 1; i <= 16; i++) { await page.mouse.move(a.center.x + 20 - i * 2, a.center.y - 330 + i * 42); await sleep(16); }
  const line = await M(page, () => getComputedStyle(document.getElementById('overlay')).opacity);
  await page.mouse.up(); await sleep(40);
  const passing = (await ts()).knife;
  await idle(); await settle(page, 1200);
  let s = await ts();
  check('knife: stroke preview, blade pass, a full stroke cuts the slice in two', line === '1' && passing === 'pass' && s.pieces === 2 && s.inv.length === 0, `line ${line}, phase ${passing}, pieces ${s.pieces}`);
  const massCut = await M(page, () => +document.getElementById('roMass').textContent);
  check('readouts: pieces counted, mass kept by a cut', (await M(page, () => document.getElementById('roPieces').textContent)) === '2' && Math.abs(massCut - 204) <= 3, `mass ${massCut} g`);

  // spoon: scoop, carry, set down; then scoop and discard with Esc
  await page.keyboard.press('s'); a = await M(page, () => __melon.anchors());
  const sp = { x: a.flesh.x * 0.6 + a.cornerA.x * 0.4, y: a.flesh.y * 0.6 + a.cornerA.y * 0.4 };
  await page.mouse.move(sp.x, sp.y); await sleep(150); await page.mouse.down();
  for (let i = 1; i <= 8; i++) { await page.mouse.move(sp.x + i * 2, sp.y + i); await sleep(20); }
  await page.mouse.up(); await idle(); await sleep(500);
  const carry = await ts();
  await page.mouse.move(sp.x + 250, sp.y - 120); await sleep(500);
  await page.mouse.down(); await page.mouse.up(); await settle(page, 1500);
  s = await ts();
  check('spoon: scoop rides in the bowl, a click sets it down as a new piece', (carry.spoon === 'carry' || carry.spoon === 'lift') && s.spoon === 'idle' && s.pieces === 3 && s.inv.length === 0, `carry ${carry.spoon}, pieces ${s.pieces}`);
  a = await M(page, () => __melon.anchors());
  await page.mouse.move(a.tip.x * 0.7 + a.center.x * 0.3, a.tip.y * 0.7 + a.center.y * 0.3); await sleep(120); await page.mouse.down(); await sleep(50); await page.mouse.up(); await idle(); await sleep(400);
  const massCarry = await M(page, () => +document.getElementById('roMass').textContent);
  await page.keyboard.press('Escape'); await settle(page, 1400);
  s = await ts();
  const massGone = await M(page, () => +document.getElementById('roMass').textContent);
  check('spoon: Esc discards the scoop (fades out, mass goes down)', s.spoon === 'idle' && s.pieces === 3 && massGone < massCarry && s.inv.length === 0, `pieces ${s.pieces}, mass ${massCarry} → ${massGone} g`);

  // hand still grabs any piece
  await page.keyboard.press('h'); a = await M(page, () => __melon.anchors());
  const g = await dragMouse(page, a.center, { x: a.center.x - 60, y: a.center.y - 140 }, { steps: 10, holdMs: 200 });
  check('hand: grabs a piece after surgery', g.grabbed && g.mid.minJ > 0.05, `minJ ${g.mid.minJ.toFixed(2)}`);
  await settle(page, 2000);

  // paused: a tool resumes the simulation; show mesh draws the new edges
  await page.click('#pause'); await page.keyboard.press('m'); a = await M(page, () => __melon.anchors());
  await page.mouse.move(a.center.x, a.center.y); await sleep(100); await page.mouse.down(); await sleep(40); await page.mouse.up(); await sleep(150);
  check('tools: using a tool while paused resumes', !(await M(page, () => __melon.paused)));
  await page.click('#mesh'); await sleep(300); await page.screenshot({ path: OUT + 'tools-mesh.png' }); await page.click('#mesh');
  await idle(); await settle(page, 1500);

  // Reset: the pristine slice, presets and sliders kept
  await page.evaluate(() => document.querySelector('input[name=preset][value="2"]').click());
  await page.evaluate(() => { const el = document.getElementById('firm'); el.value = 70; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.click('#reset'); await sleep(200);
  const rs = await M(page, () => ({ p: __melon.matchesPristine(), pieces: __melon.toolState().pieces, preset: document.querySelector('input[name=preset]:checked').value, firm: document.getElementById('firmOut').textContent, mass: document.getElementById('roMass').textContent }));
  check('Reset restores the pristine slice and keeps preset and sliders', rs.p && rs.pieces === 1 && rs.preset === '2' && rs.firm === '70', JSON.stringify(rs));
  await page.evaluate(() => { document.querySelector('input[name=preset][value="0"]').click(); const el = document.getElementById('firm'); el.value = 25; el.dispatchEvent(new Event('input', { bubbles: true })); });
  const t = await M(page, () => __melon.timing());
  check('tools: no frame over 50 ms while cutting and scooping', t.frame < 50, `worst frame ${t.frame.toFixed(1)} ms · surgery step ${Math.max(0, ...Object.values(t.steps || {})).toFixed(1)} ms · upload ${t.upload.toFixed(1)} ms`);
  await settle(page, 2500);
  await health(page, 'after tools');
  const winErr = await M(page, () => window.__winErrors);
  check('no console or window errors (tools)', logs.length === 0 && winErr.length === 0, logs.concat(winErr).slice(0, 3).join(' | '));
  await page.close();
}

// ------------------------------------------------------------------ tools (touch)
{
  const { page, logs } = await open({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await settle(page, 2500);
  const cdp = await page.createCDPSession();
  const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map((p, i) => ({ x: p.x, y: p.y, id: i })) });
  const idle = async () => { for (let k = 0; k < 400; k++) { const s = await M(page, () => __melon.toolState()); if (!s.busy && s.knife !== 'pass' && s.spoon !== 'wait' && s.mallet === 'idle') return; await sleep(25); } };
  await page.tap('.tool[data-tool="knife"]'); await sleep(100);
  let a = await M(page, () => __melon.anchors());
  const top = { x: a.center.x + 10, y: a.center.y - 170 };
  await touch('touchStart', [top]);
  for (let i = 1; i <= 12; i++) { await touch('touchMove', [{ x: top.x - i, y: top.y + i * 28 }]); await sleep(16); }
  await touch('touchEnd', []); await sleep(60); await idle(); await settle(page, 1200);
  let s = await M(page, () => __melon.toolState());
  check('touch: a swipe with the knife cuts', s.pieces === 2, `pieces ${s.pieces}`);
  await page.tap('.tool[data-tool="mallet"]'); await sleep(100);
  a = await M(page, () => __melon.anchors());
  await touch('touchStart', [a.flesh]); await sleep(40); await touch('touchEnd', []); await sleep(230);
  const j = await M(page, () => __melon.stats().minJ);
  check('touch: a tap strikes with the mallet', j < 0.97, `minJ ${j.toFixed(2)}`);
  await idle(); await settle(page, 1200);
  await page.tap('.tool[data-tool="spoon"]'); await sleep(100);
  a = await M(page, () => __melon.anchors());
  await touch('touchStart', [a.flesh]);
  for (let i = 1; i <= 6; i++) { await touch('touchMove', [{ x: a.flesh.x + i * 2, y: a.flesh.y + i }]); await sleep(20); }
  await touch('touchEnd', []); await idle(); await sleep(500);
  const c = (await M(page, () => __melon.toolState())).spoon;
  await touch('touchStart', [{ x: 60, y: 300 }]); await touch('touchEnd', []); await settle(page, 1200);
  s = await M(page, () => __melon.toolState());
  check('touch: press-drag scoops, a second tap sets it down', (c === 'carry' || c === 'lift') && s.spoon === 'idle', `carry ${c}, now ${s.spoon}, pieces ${s.pieces}`);
  await page.screenshot({ path: OUT + 'tools-touch.png' });
  await health(page, 'after touch tools');
  check('no console errors (touch tools)', logs.length === 0, logs.slice(0, 3).join(' | '));
  await page.close();
}

// ------------------------------------------------------------------ tools with reduced motion; self-test (?debug)
{
  const { page } = await open({ width: 1280, height: 800 }, { reduce: true });
  await sleep(600);
  await page.keyboard.press('m');
  const a = await M(page, () => __melon.anchors());
  await page.mouse.move(a.rind.x - 20, a.rind.y - 20); await sleep(100);
  await page.mouse.down(); await sleep(1000); await page.mouse.up();
  let drops = 0;
  for (let k = 0; k < 12; k++) { await sleep(40); drops = Math.max(drops, (await M(page, () => __melon.toolState())).drops); }
  await page.keyboard.press('k');
  await page.mouse.move(a.center.x, a.center.y - 300); await page.mouse.down(); await page.mouse.move(a.center.x, a.center.y + 300, { steps: 8 }); await page.mouse.up();
  const ph = (await M(page, () => __melon.toolState())).knife;
  check('reduced motion: no juice, no blade swing', drops === 0 && ph !== 'pass', `drops ${drops}, knife ${ph}`);
  await page.close();
}
{
  const { page } = await open({ width: 1440, height: 900 });
  await page.goto(URL_ + '?debug');
  await page.waitForFunction(() => window.__melon && window.__melon.ready, { timeout: 30000 });
  const hasBox = await M(page, () => !!document.querySelector('.debug #dbgRun') && /particles/.test(document.getElementById('dbgText').textContent));
  await sleep(1500);
  const r = await page.evaluate(() => __melon.selfTest({ rounds: 1, seed: 3 }));
  check('?debug overlay and self-test (1 round: cuts, scoops, strikes, drags, reset)', hasBox && r.ok, `${r.summary} ${r.failures.slice(0, 2).join(' | ')}`);
  await page.close();
}

// ------------------------------------------------------------------ layout: controls never cover the slice
for (const vp of [
  { width: 1440, height: 900 }, { width: 1280, height: 720 }, { width: 1920, height: 1080 }, { width: 1024, height: 768 },
  { width: 768, height: 1024, hasTouch: true }, { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
  { width: 360, height: 640, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  { width: 844, height: 390, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
  { width: 667, height: 375, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  { width: 568, height: 320, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  { width: 700, height: 900 },
]) {
  const { page } = await open({ deviceScaleFactor: 1, ...vp });
  await settle(page, 3000);
  const shapes = ['closed'];
  const sheet = await M(page, () => getComputedStyle(document.getElementById('sheetToggle')).display !== 'none');
  if (sheet) shapes.push('sheet open');
  shapes.push('notes open');
  let closedW = 0;
  const hintShown = await M(page, () => [...document.querySelectorAll('.hint > span')].some((e) => e.offsetWidth > 0));
  check(`layout ${vp.width}x${vp.height}: grab hint visible`, hintShown);
  for (const s of shapes) {
    if (s === 'sheet open') { await page.click('#sheetToggle'); await settle(page, 1200); }
    if (s === 'notes open') { await page.click('#notes summary'); await settle(page, 1200); }
    const o = await M(page, () => {
      const b = __melon.screenBounds();
      const R = (sel) => { const r = document.querySelector(sel).getBoundingClientRect(); return r.width && r.height ? r : null; };
      const over = (r, q) => r && q && r.left < q.right && r.right > q.left && r.top < q.bottom && r.bottom > q.top;
      const hit = [];
      for (const sel of ['.panel', '.foot .readouts', '.notes', '.status']) if (over(R(sel), { left: b.left, right: b.right, top: b.top, bottom: b.bottom })) hit.push(sel);
      if (over(R('.notes'), R('.panel'))) hit.push('notes over panel');
      if (over(R('.tools'), { left: b.left, right: b.right, top: b.top, bottom: b.bottom })) hit.push('.tools');
      for (const sel of ['.foot', '.panel', '.notes', '.masthead h1', '.caption', '.status']) if (over(R('.tools'), R(sel))) hit.push('tools over ' + sel);
      if (over(R('.notes'), R('.foot'))) hit.push('notes over readouts/hint');
      const onScreen = ['.panel', '.foot', '.notes'].every((sel) => { const r = R(sel); return !r || (r.top >= -1 && r.bottom <= innerHeight + 1); });
      if (!onScreen) hit.push('UI pushed off-screen');
      return { hit, b, hscroll: document.documentElement.scrollWidth > innerWidth };
    });
    const tag = `${vp.width}x${vp.height}${s === 'closed' ? '' : ' (' + s + ')'}`;
    const w = o.b.right - o.b.left;
    if (s === 'closed') closedW = w;
    const bigEnough = s === 'closed' ? w > Math.min(vp.width, vp.height) * 0.28 : w > closedW * 0.45;
    check(`layout ${tag}: controls clear of the slice`, o.hit.length === 0 && !o.hscroll && bigEnough, (o.hit.join(', ') || '') + ` slice ${o.b.left.toFixed(0)}–${o.b.right.toFixed(0)} × ${o.b.top.toFixed(0)}–${o.b.bottom.toFixed(0)} (${w.toFixed(0)} px wide)`);
    await page.screenshot({ path: OUT + `layout-${vp.width}x${vp.height}-${s.replace(' ', '-')}.png` });
    if (s === 'notes open') { await page.click('#notes summary'); await settle(page, 600); }
  }
  const winErr = await M(page, () => window.__winErrors);
  check(`layout ${vp.width}x${vp.height}: no window errors`, winErr.length === 0, winErr.join(' | '));
  await page.close();
}

// ------------------------------------------------------------------ the title only steps back when the slice is on it
for (const vp of [{ width: 1024, height: 768 }, { width: 1180, height: 820 }, { width: 1440, height: 900 }]) {
  const { page } = await open(vp);
  await settle(page, 3500);
  const atRest = await M(page, () => document.querySelector('.masthead').classList.contains('veiled'));
  const f = (await M(page, () => __melon.anchors())).flesh;
  const h = await M(page, () => { const r = document.querySelector('.masthead h1').getBoundingClientRect(); return { x: r.left + r.width * 0.45, y: r.top + r.height * 0.5 }; });
  await page.mouse.move(f.x, f.y); await page.mouse.down();
  for (let i = 1; i <= 20; i++) { await page.mouse.move(f.x + ((h.x - f.x) * i) / 20, f.y + ((h.y - f.y) * i) / 20); await sleep(20); }
  await sleep(600);
  const onTitle = await M(page, () => document.querySelector('.masthead').classList.contains('veiled'));
  await page.mouse.up();
  check(`title veil ${vp.width}x${vp.height}: clear at rest, fades under the slice`, !atRest && onTitle, `at rest ${atRest ? 'veiled' : 'clear'}, dragged onto the title ${onTitle ? 'veiled' : 'clear'}`);
  await page.close();
}

// ------------------------------------------------------------------ reduced motion & no WebGPU
{
  const { page } = await open({ width: 1280, height: 800 }, { reduce: true });
  await sleep(300);
  const st = await M(page, () => __melon.stats());
  check('reduced motion: no drop on load', st.ke < 1e-3 && st.minY < 0.01, `KE ${st.ke.toExponential(1)}, lowest point ${st.minY.toFixed(3)}`);
  await page.close();
}
for (const [label, opt] of [['no navigator.gpu', { noGpu: true }], ['no adapter', { nullAdapter: true }]]) {
  const { page } = await open({ width: 1280, height: 800 }, opt);
  const r = await M(page, () => ({ shown: !document.getElementById('fallback').hidden, text: document.getElementById('fallbackReason').textContent, status: document.getElementById('statusText').textContent }));
  check(`fallback (${label}) explains, never fakes`, r.shown && r.text.length > 20 && !/LIVE/.test(r.status), `${r.status}: ${r.text}`);
  await page.screenshot({ path: OUT + `fallback-${opt.noGpu ? 'nogpu' : 'noadapter'}.png` });
  await page.close();
}

await browser.close();
const w = Math.max(...results.map((r) => r.name.length));
let fails = 0;
for (const r of results) { if (!r.ok) fails++; console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(w)}  ${r.detail}`); }
console.log(`\n${results.length - fails}/${results.length} passed · screenshots in ${OUT}`);
process.exit(fails ? 1 : 0);
