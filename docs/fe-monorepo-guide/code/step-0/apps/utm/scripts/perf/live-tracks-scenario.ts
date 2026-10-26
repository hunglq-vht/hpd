// DEVMODE: Repeatable live-track scenario for the before/after demonstrations of each MR.
// First run: --login (headed) to save a session. Then: --url <monitor URL> --renderer geojson|webgl --label <name>.
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'

import { chromium } from '@playwright/test'
import type { Page } from '@playwright/test'

const { values: options } = parseArgs({
  allowPositionals: true,
  options: {
    url: { type: 'string', default: 'https://utm-mock.localhost/monitor' },
    renderer: { type: 'string', default: 'geojson' },
    label: { type: 'string', default: 'run' },
    out: { type: 'string', default: 'perf-out' },
    login: { type: 'boolean', default: false },
  },
})
const authFile = path.resolve(options.out, 'auth-state.json')
const runDirectory = path.resolve(options.out, options.label, options.renderer)
mkdirSync(runDirectory, { recursive: true })

const samples: unknown[] = []

async function sampleFor(page: Page, phase: string, seconds: number, act?: (second: number) => Promise<void>) {
  for (let second = 0; second < seconds; second++) {
    await act?.(second)
    await page.waitForTimeout(1000)
    samples.push({ phase, second, perf: await page.evaluate(() => window.__TRACK_PERF__ ?? null) })
  }
}

if (options.login) {
  const browser = await chromium.launch({ headless: false })
  const context = await browser.newContext({ ignoreHTTPSErrors: true })
  const page = await context.newPage()
  await page.goto(options.url)
  // README: Log in by hand in the opened window; the session is saved when the monitor page loads.
  await page.waitForSelector('canvas.maplibregl-canvas', { timeout: 300_000 })
  await context.storageState({ path: authFile })
  await browser.close()
} else {
  const browser = await chromium.launch({ headless: true, args: ['--ignore-gpu-blocklist', '--enable-gpu-rasterization'] })
  const context = await browser.newContext({ ignoreHTTPSErrors: true, storageState: authFile, viewport: { width: 1600, height: 900 }, recordVideo: { dir: runDirectory, size: { width: 1600, height: 900 } } })
  const page = await context.newPage()
  await page.goto(`${options.url}?lat=21.22&lng=105.82&zoom=14&perf&trackRenderer=${options.renderer}`)
  await page.waitForSelector('canvas.maplibregl-canvas')
  await page.waitForFunction(() => window.__TRACK_PERF__ !== undefined, null, { timeout: 30_000 })
  await page.evaluate(async () => {
    const reactScan = window.__REACT_SCAN_DEBUG__
    if (!reactScan) return
    await reactScan.ready
    await reactScan.enable()
    reactScan.clear()
  })
  await browser.startTracing(page, { path: path.join(runDirectory, 'trace.json'), screenshots: true })

  const box = await page.locator('canvas.maplibregl-canvas').boundingBox()
  const centerX = (box?.x ?? 0) + (box?.width ?? 1600) / 2
  const centerY = (box?.y ?? 0) + (box?.height ?? 900) / 2
  await sampleFor(page, 'hold-z14', 15)
  await sampleFor(page, 'pan', 10, async second => {
    await page.mouse.move(centerX, centerY)
    await page.mouse.down()
    await page.mouse.move(centerX + (second % 2 === 0 ? 300 : -300), centerY, { steps: 20 })
    await page.mouse.up()
  })
  await page.mouse.move(centerX, centerY)
  await sampleFor(page, 'zoom-out-z8', 6, async () => page.mouse.wheel(0, 600))
  await sampleFor(page, 'hold-z8', 10)
  await sampleFor(page, 'zoom-in-z14', 6, async () => page.mouse.wheel(0, -600))
  await page.keyboard.down('Shift')
  await sampleFor(page, 'pitch-45', 3, async () => page.keyboard.press('ArrowUp'))
  await page.keyboard.up('Shift')
  await sampleFor(page, 'hold-pitched', 10)

  await browser.stopTracing()
  const reactRenders = await page.evaluate(() => window.__REACT_SCAN_DEBUG__?.getEvents() ?? [])
  writeFileSync(path.join(runDirectory, 'samples.json'), JSON.stringify(samples, null, 1))
  writeFileSync(path.join(runDirectory, 'react-renders.json'), JSON.stringify(reactRenders))
  await context.close()
  await browser.close()
}
