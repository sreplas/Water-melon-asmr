// Runs the page's built-in self-test (?debug) in headless Chrome and prints its report.
import { mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer-core';

const HTML = fileURLToPath(new URL('../melon-jelly.html', import.meta.url));
const OUT = fileURLToPath(new URL('./out/', import.meta.url));
mkdirSync(OUT, { recursive: true });
const CHROME = [process.env.CHROME, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].filter(Boolean).find((p) => existsSync(p));
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist'], protocolTimeout: 900000 });
const page = await browser.newPage();
const logs = [];
page.on('console', (m) => { if (m.type() === 'error') logs.push(m.text()); });
page.on('pageerror', (e) => logs.push('pageerror: ' + e.message));
await page.setViewport({ width: 1440, height: 900 });
await page.goto(pathToFileURL(HTML).href + '?debug');
await page.waitForFunction(() => window.__melon && (window.__melon.ready || window.__melon.failed), { timeout: 30000 });
await new Promise((r) => setTimeout(r, 1500));
await page.evaluate(() => __melon.resetFrameMax());
const seed = +(process.argv[2] || 7);
const t0 = Date.now();
const r = await page.evaluate((sd) => __melon.selfTest({ seed: sd, onLog: (m) => console.log(m) }), seed);
const timing = await page.evaluate(() => __melon.timing());
await page.screenshot({ path: OUT + 'selftest-end.png' });
console.log(JSON.stringify(r, null, 1));
console.log('timing', JSON.stringify(timing), 'gpu errors', JSON.stringify(await page.evaluate(() => __melon.errors)), 'console', logs.slice(0, 5).join(' | '), `(${((Date.now() - t0) / 1000).toFixed(0)} s)`);
await browser.close();
process.exit(r.ok && !logs.length ? 0 : 1);
