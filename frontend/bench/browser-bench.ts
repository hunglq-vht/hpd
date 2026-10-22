// Drives the real app in Chrome (playwright-core + the installed browser) to
//  * take smoke-test screenshots of every mode:   node bench/browser-bench.ts smoke
//  * measure the UI under load, per scenario:      node bench/browser-bench.ts perf
// Options: --url http://localhost:3000  --out bench/out  --duration 20  --headed  --chrome <path>
//
// Metrics are read from window.__perf, which the app refreshes every second
// (worker stats + UI thread fps/upload stats), so these are the same numbers as the HUD.

import { chromium, type Page } from "playwright-core";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const opt = (k: string, d: string) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : d;
};
const cmd = args[0] ?? "smoke";
const url = opt("url", "http://localhost:3000");
const out = opt("out", "bench/out");
const duration = Number(opt("duration", "20"));
const chromePath =
  opt("chrome", "") ||
  ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "/usr/bin/google-chrome"].find(
    existsSync,
  )!;
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({
  executablePath: chromePath,
  headless: !args.includes("--headed"),
  args: ["--ignore-gpu-blocklist", "--enable-gpu-rasterization", "--use-angle=default", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
const logs: string[] = [];
page.on("console", (m) => (m.type() === "error" || m.type() === "warning") && logs.push(`[${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Perf = Record<string, any>;
const perf = (p: Page) => p.evaluate(() => (window as any).__perf as Perf | undefined);

async function open(params: Record<string, string | number>) {
  const q = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
  await page.goto(`${url}/?${q}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".toolbar", { timeout: 20_000 });
}

async function shot(name: string) {
  await page.screenshot({ path: join(out, `${name}.png`) });
  console.log(`  screenshot ${name}.png`);
}

async function smoke() {
  console.log("world clusters");
  await open({ lon: 30, lat: 22, zoom: 1.7 });
  await sleep(5000);
  await shot("1-clusters-world");

  console.log("city clusters (Singapore z11.5)");
  await open({ lon: 103.8198, lat: 1.3521, zoom: 11.5 });
  await sleep(5000);
  await shot("2-clusters-city");

  console.log("realtime (Singapore z14.5)");
  await open({ lon: 103.8198, lat: 1.3521, zoom: 14.5 });
  await sleep(6000);
  await shot("3-realtime");
  const p = await perf(page);
  console.log(`  tracks=${p?.tracks} msgs/s=${p?.msgsPerSec} p50=${p?.latency?.p50?.toFixed?.(1)}ms fps=${p?.main?.fps}`);

  console.log("select + follow");
  for (const [dx, dy] of [[0, 0], [20, 10], [-25, 15], [10, -30], [40, 40]]) {
    await page.mouse.click(800 + dx, 450 + dy);
    await sleep(400);
    if (await page.locator(".panel.track").count()) break;
  }
  await sleep(2500);
  await shot("4-selected");
  const panel = await page.locator(".panel.track").innerText().catch(() => "(no panel)");
  console.log("  panel:", panel.replace(/\s+/g, " ").slice(0, 200));
  await sleep(4000);
  await shot("5-following");

  console.log("zoom out to clusters while following");
  await page.evaluate(() => (window as any).__app?.map?.zoomTo(11.5, { duration: 0 }));
  await sleep(3500);
  await shot("6-selected-in-cluster-mode");
}

async function measure(name: string, params: Record<string, string | number>) {
  await open(params);
  await sleep(6000); // warm up: connect, clock sync, first frames
  const samples: Perf[] = [];
  for (let i = 0; i < duration; i++) {
    await sleep(1000);
    const p = await perf(page);
    if (p) samples.push(JSON.parse(JSON.stringify(p)));
  }
  await shot(`perf-${name}`);
  const avg = (f: (p: Perf) => number) => samples.reduce((a, p) => a + (f(p) || 0), 0) / Math.max(1, samples.length);
  const maxOf = (f: (p: Perf) => number) => Math.max(...samples.map((p) => f(p) || 0));
  const row = {
    scenario: name,
    subscriptions: Math.round(avg((p) => p.subscriptions)),
    tracksInMemory: Math.round(avg((p) => p.tracks)),
    msgsPerSec: Math.round(avg((p) => p.msgsPerSec)),
    tracksPerSec: Math.round(avg((p) => p.tracksPerSec)),
    MBps: +(avg((p) => p.bytesPerSec) / 1e6).toFixed(2),
    decodeUsPerMsg: +avg((p) => p.decodeUsPerMsg).toFixed(1),
    workerBusyPct: +(avg((p) => p.busyMsPerSec) / 10).toFixed(1),
    latP50: +avg((p) => p.latency.p50).toFixed(1),
    latP99: +avg((p) => p.latency.p99).toFixed(1),
    latMax: +maxOf((p) => p.latency.max).toFixed(1),
    fps: Math.round(avg((p) => p.main?.fps)),
    fpsMin: Math.min(...samples.map((p) => p.main?.fps ?? 0)),
    uploadMBps: +avg((p) => p.main?.uploadMBps).toFixed(1),
    uploadMs: +avg((p) => p.main?.uploadMsAvg).toFixed(2),
    framesSkipped: Math.round(avg((p) => p.framesSkipped)),
    slowConsumer: maxOf((p) => p.slowConsumer),
  };
  console.log(JSON.stringify(row));
  return row;
}

async function perfSuite() {
  const scenarios: [string, Record<string, string | number>][] = [
    ["tokyo-z14-m0.5", { lon: 139.6917, lat: 35.6895, zoom: 14, margin: 0.5 }],
    ["tokyo-z13-m0.5", { lon: 139.6917, lat: 35.6895, zoom: 13, margin: 0.5 }],
    ["singapore-z13-m1", { lon: 103.8198, lat: 1.3521, zoom: 13, margin: 1 }],
    ["singapore-z13-m2", { lon: 103.8198, lat: 1.3521, zoom: 13, margin: 2 }],
    ["stress-top100", { lon: 103.8198, lat: 1.3521, zoom: 13, stress: 100 }],
    ["stress-top200", { lon: 103.8198, lat: 1.3521, zoom: 13, stress: 200 }],
    ["stress-top400", { lon: 103.8198, lat: 1.3521, zoom: 13, stress: 400 }],
    ["stress-top1000", { lon: 103.8198, lat: 1.3521, zoom: 13, stress: 1000 }],
    ["firehose-1M", { lon: 103.8198, lat: 1.3521, zoom: 13, stress: "all" }],
  ];
  const only = opt("only", "");
  const rows = [];
  for (const [name, p] of scenarios) {
    if (only && !name.includes(only)) continue;
    console.log(`scenario ${name}`);
    rows.push(await measure(name, p));
  }
  writeFileSync(join(out, "browser-perf.json"), JSON.stringify(rows, null, 2));
}

try {
  if (cmd === "perf") await perfSuite();
  else await smoke();
} finally {
  if (logs.length) console.log("console:\n" + [...new Set(logs)].slice(0, 30).join("\n"));
  await browser.close();
}
