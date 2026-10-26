// Checks the guide's code outside fe-monorepo: for each step it overlays code/step-0..N on small stubs of the
// dev modules the code imports, type-checks it (strict, noUncheckedIndexedAccess), and runs its unit tests.
// With --smoke it also runs the step 4 code in Chrome with MapLibre 6.12 and 5000 synthetic tracks.
//
//   npm ci
//   node check.mjs [--step 0|1|2|4] [--smoke] [--chrome <path to chrome or edge>] [--fe-monorepo <path, default ../../../fe-monorepo>]

import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

import { chromium } from 'playwright-core'
import { build } from 'rolldown'

const here = path.dirname(fileURLToPath(import.meta.url))
const { values: options } = parseArgs({ options: { step: { type: 'string', default: '4' }, smoke: { type: 'boolean', default: false }, chrome: { type: 'string' }, 'fe-monorepo': { type: 'string', default: path.join(here, '../../../fe-monorepo') } } })
const steps = ['0', '1', '2', '4'].filter(step => Number(step) <= Number(options.step))
let failures = 0

function listFiles(directory) {
  return readdirSync(directory).flatMap(name => {
    const file = path.join(directory, name)
    return statSync(file).isDirectory() ? listFiles(file) : [file]
  })
}

function aliasesFor(buildDirectory) {
  return {
    '@platform/utm': path.join(buildDirectory, 'apps/utm/src'),
    '@platform/lib': path.join(buildDirectory, 'packages/lib/src'),
    zustand: path.join(buildDirectory, 'zustand.ts'),
    'vite-plus/test': path.join(buildDirectory, 'vite-plus-test.ts'),
  }
}

function materialize(step) {
  const buildDirectory = path.join(here, '.build', `step-${step}`)
  rmSync(buildDirectory, { recursive: true, force: true })
  cpSync(path.join(here, 'stubs'), buildDirectory, { recursive: true })
  for (const included of steps.filter(candidate => Number(candidate) <= Number(step))) cpSync(path.join(here, '..', 'code', `step-${included}`), buildDirectory, { recursive: true })
  writeFileSync(
    path.join(buildDirectory, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2023',
          lib: ['ES2023', 'DOM', 'DOM.Iterable'],
          module: 'ESNext',
          moduleResolution: 'Bundler',
          jsx: 'react-jsx',
          strict: true,
          noUncheckedIndexedAccess: true,
          noEmit: true,
          skipLibCheck: true,
          typeRoots: [path.join(here, 'node_modules/@types')],
          types: ['geojson', 'node'],
          baseUrl: '.',
          paths: {
            '@platform/utm/*': ['apps/utm/src/*'],
            '@platform/lib/*': ['packages/lib/src/*'],
            zustand: ['zustand.ts'],
            'vite-plus/test': ['vite-plus-test.ts'],
            '@playwright/test': [path.join(here, 'node_modules/playwright-core')],
          },
        },
        include: ['apps/**/*.ts', 'apps/**/*.tsx'],
      },
      null,
      2,
    ),
  )
  return buildDirectory
}

function run(label, command, args) {
  try {
    execFileSync(command, args, { stdio: 'inherit' })
    console.log(`PASS ${label}`)
  } catch {
    failures++
    console.log(`FAIL ${label}`)
  }
}

for (const step of steps) {
  const buildDirectory = materialize(step)
  run(`step ${step}: type check`, process.execPath, [path.join(here, 'node_modules/typescript/bin/tsc'), '-p', path.join(buildDirectory, 'tsconfig.json')])
  const tests = listFiles(path.join(buildDirectory, 'apps')).filter(file => file.endsWith('.test.ts'))
  const bundles = []
  for (const test of tests) {
    const output = path.join(buildDirectory, 'out', `${path.basename(test, '.ts')}.mjs`)
    await build({ input: test, platform: 'node', resolve: { alias: aliasesFor(buildDirectory) }, output: { file: output, format: 'esm' }, logLevel: 'warn' })
    bundles.push(output)
  }
  if (bundles.length > 0) run(`step ${step}: unit tests`, process.execPath, ['--test', ...bundles])
}

if (options.smoke && steps.includes('4')) {
  const buildDirectory = path.join(here, '.build', 'step-4')
  const smokeDirectory = path.join(buildDirectory, 'smoke')
  mkdirSync(smokeDirectory, { recursive: true })
  const alias = aliasesFor(buildDirectory)
  await build({ input: path.join(here, 'smoke/main.ts'), external: ['maplibre-gl'], resolve: { alias }, output: { file: path.join(smokeDirectory, 'main.mjs'), format: 'esm' }, logLevel: 'warn' })
  await build({ input: path.join(buildDirectory, 'apps/utm/src/worker/live-tracks-worker.ts'), resolve: { alias }, output: { file: path.join(smokeDirectory, 'worker.mjs'), format: 'esm' }, logLevel: 'warn' })
  const tokens = '--color-utm-replay-monitor-normal:#39FF14;--color-utm-replay-monitor-warning:#FFD600;--color-utm-replay-monitor-critical:#FF2B2B;--color-utm-replay-monitor-lost-link:#9CA3AF;--color-utm-replay-monitor-processing:#00BFFF;--color-utm-replay-monitor-lost-control:#FF2B2B'
  writeFileSync(
    path.join(smokeDirectory, 'index.html'),
    `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="./maplibre/maplibre-gl.css"><style>:root{${tokens}}html,body,#map{margin:0;width:100%;height:100%;background:#000}</style><div id="map"></div><script type="importmap">{"imports":{"maplibre-gl":"./maplibre/maplibre-gl.mjs"}}</script><script type="module" src="./main.mjs"></script>`,
  )
  // README: The drone icon is fe-monorepo's own asset, read from the clone next to this repo.
  const files = { '/drone1_out.png': path.join(options['fe-monorepo'], 'apps/utm/src/assets/icons/drone1_out.png') }
  for (const name of ['maplibre-gl.mjs', 'maplibre-gl-shared.mjs', 'maplibre-gl-worker.mjs', 'maplibre-gl.css']) files[`/maplibre/${name}`] = path.join(here, 'node_modules/maplibre-gl/dist', name)
  const types = { '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.html': 'text/html' }
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost').pathname
    const file = files[url] ?? path.join(smokeDirectory, url === '/' ? 'index.html' : url)
    if (!existsSync(file)) return response.writeHead(404).end()
    response.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file))
  })
  await new Promise(resolve => server.listen(0, resolve))
  const chromePath = [options.chrome, process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(
    candidate => candidate && existsSync(candidate),
  )
  const browser = await chromium.launch({ executablePath: chromePath, headless: true, args: ['--ignore-gpu-blocklist', '--use-angle=default'] })
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  const pageErrors = []
  page.on('pageerror', error => pageErrors.push(String(error)))
  await page.goto(`http://localhost:${server.address().port}/`)
  await page.waitForFunction(() => globalThis.__smoke?.frames > 5, null, { timeout: 20_000 }).catch(() => undefined)
  await page.waitForTimeout(2500)
  const atZoom14 = await page.evaluate(() => ({ ...globalThis.__smoke }))
  await page.evaluate(() => globalThis.__map.jumpTo({ zoom: 10 }))
  await page.waitForTimeout(1500)
  const atZoom10 = await page.evaluate(() => ({ clusterFeatures: globalThis.__smoke.clusterFeatures, green: globalThis.__countColor(0x39, 0xff, 0x14) }))
  await page.evaluate(() => globalThis.__map.jumpTo({ zoom: 17 }))
  await page.waitForTimeout(1500)
  const atZoom17 = await page.evaluate(() => ({ clusterFeatures: globalThis.__smoke.clusterFeatures, green: globalThis.__countColor(0x39, 0xff, 0x14) }))
  const first = await page.evaluate(() => globalThis.__firstTrack())
  await page.evaluate(([longitude, latitude]) => globalThis.__pickAt(longitude, latitude), [first.Longitude, first.Latitude])
  await page.waitForTimeout(300)
  const picked = await page.evaluate(() => globalThis.__smoke.replies.at(-1))
  const before = await page.screenshot()
  await page.waitForTimeout(200)
  const isAnimating = !before.equals(await page.screenshot())
  await page.evaluate(([longitude, latitude]) => globalThis.__map.jumpTo({ center: [longitude, latitude], zoom: 18 }), [first.Longitude, first.Latitude])
  await page.waitForTimeout(1500)
  const alertRedPixels = await page.evaluate(() => globalThis.__countColor(0xff, 0x2b, 0x2b))
  await page.evaluate(() => globalThis.__map.jumpTo({ center: [105.9, 21.1], zoom: 16 }))
  await page.evaluate(() => globalThis.__startFollow())
  await page.waitForTimeout(3000)
  const followError = await page.evaluate(() => {
    const { lng, lat } = globalThis.__map.getCenter()
    const track = globalThis.__firstTrack()
    return Math.hypot(lng - track.Longitude, lat - track.Latitude)
  })
  await page.screenshot({ path: path.join(smokeDirectory, 'selected-alert.png') })
  await browser.close()
  server.close()

  const checks = [
    ['no page or worker errors', pageErrors.length === 0 && atZoom14.errors.length === 0, [...pageErrors, ...atZoom14.errors].join('; ')],
    ['worker sends GPU frames with the whole fleet', atZoom14.frames > 5 && atZoom14.lastCount === 5000, `${atZoom14.frames} frames, ${atZoom14.lastCount} tracks`],
    ['view updates reach the map view', atZoom14.viewUpdates > 3, `${atZoom14.viewUpdates} updates`],
    ['main-thread store still receives batches', atZoom14.batchesToStore > 10, `${atZoom14.batchesToStore} batches`],
    ['zoom 10: grid clusters, no drone icons', atZoom10.clusterFeatures > 0 && atZoom10.green === 0, JSON.stringify(atZoom10)],
    ['zoom 17: no clusters, drone icons drawn', atZoom17.clusterFeatures === 0 && atZoom17.green > 1000, JSON.stringify(atZoom17)],
    ['pick finds the drone and its CRITICAL alert (queued before the worker, keyed by TrackNumber)', picked?.[0]?.id === 1 && picked[0].status === 'CRITICAL', JSON.stringify(picked)],
    ['drones glide between reports', isAnimating, ''],
    ['selected alert drone drawn red with pulse', alertRedPixels > 100, `${alertRedPixels} red pixels`],
    ['follow keeps the selected drone at the map centre (within its glide lag)', followError < 0.0005, `centre is ${followError.toFixed(6)} degrees from the newest report`],
  ]
  for (const [label, isPassing, detail] of checks) {
    if (!isPassing) failures++
    console.log(`${isPassing ? 'PASS' : 'FAIL'} smoke: ${label}${detail ? ` (${detail})` : ''}`)
  }
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
