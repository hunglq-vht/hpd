// Smoke page for the step 4 code: MapLibre 6.12 + live-tracks-channel + live-tracks-worker + track GL layer, fed with 5000 synthetic tracks in 10 batches per second.
import { Map as MapLibreMap } from 'maplibre-gl'

import {
  attachLiveTracksWorker,
  forwardLiveTrackBatch,
  getLiveTrackClockSeconds,
  releaseLiveTrackFrame,
  sendLiveTrackAlerts,
  setLiveTrackView,
  subscribeLiveTrackFrames,
  subscribeLiveTrackView,
} from '@platform/utm/shared/domain/replay-monitor/live-tracks-channel'
import type { TrackView } from '@platform/utm/shared/domain/replay-monitor/live-tracks.types'
import { pickLiveTrackAt } from '@platform/utm/shared/domain/replay-monitor/pick-live-track'
import { startSelectedTrackFollow } from '@platform/utm/shared/domain/replay-monitor/track-follow'
import { createTrackGlLayer } from '@platform/utm/shared/domain/replay-monitor/track-gl-layer'
import type { Rgba } from '@platform/utm/shared/domain/replay-monitor/track-gl-layer'

const smoke = { viewUpdates: 0, lastFeatures: 0, lastHasAlert: false, frames: 0, lastCount: 0, errors: [] as string[], replies: [] as unknown[], clusterFeatures: 0, batchesToStore: 0 }
Object.assign(globalThis, { __smoke: smoke })
addEventListener('error', event => smoke.errors.push(String(event.message)))

function toRgba(color: string): Rgba {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 1
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) return [1, 1, 1, 1]
  context.fillStyle = color
  context.fillRect(0, 0, 1, 1)
  const [r = 255, g = 255, b = 255, a = 255] = context.getImageData(0, 0, 1, 1).data
  return [r / 255, g / 255, b / 255, a / 255]
}

// The alerts arrive before the worker exists: they must be queued by the channel.
const COUNT = 5000
const tracks = Array.from({ length: COUNT }, (_, index) => ({
  ID: index + 1,
  TrackNumber: index + 10001,
  Longitude: 105.84 + (((index * 7919) % 1000) / 1000) * 0.06 - 0.03,
  Latitude: 21.03 + (((index * 104729) % 1000) / 1000) * 0.04 - 0.02,
  Altitude: 100,
  AircraftType: 1,
  Identification: 1,
  Heading: (index * 37) % 360,
  Velocity: 10,
  Serial: '',
  CreatedAt: 0,
  UpdatedAt: 0,
  ListSources: [],
  Mode3a: `UAV-${index + 1}`,
}))
sendLiveTrackAlerts(tracks.slice(0, 50).map(track => ({ trackId: track.TrackNumber, type: 'socket.collision', level: 'CRITICAL' as const })), [])

const icon = new Image()
icon.src = './drone1_out.png'
await icon.decode()

const map = new MapLibreMap({
  container: 'map',
  style: { version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#000000' } }] },
  center: [105.84, 21.03],
  zoom: 14,
  canvasContextAttributes: { preserveDrawingBuffer: true },
})
await map.once('load')

const layer = createTrackGlLayer({
  id: 'track-gl',
  icon,
  colors: { status: ['#39FF14', '#FFD600', '#FF2B2B', '#9CA3AF', '#00BFFF', '#FF2B2B'].map(toRgba), pulse: [toRgba('#FFD600'), toRgba('#FF2B2B')], neutral: toRgba('#FFFFFF') },
  getNow: getLiveTrackClockSeconds,
  releaseBuffer: releaseLiveTrackFrame,
})
map.addLayer(layer)

subscribeLiveTrackFrames(frame => {
  smoke.frames++
  smoke.lastCount = frame.count
  layer.setFrame(frame)
})
subscribeLiveTrackView(1, update => {
  smoke.viewUpdates++
  smoke.lastHasAlert = update.hasAlertInView
  smoke.lastFeatures = update.data?.features.length ?? smoke.lastFeatures
  smoke.clusterFeatures = update.data?.features.filter(feature => 'cluster' in feature.properties).length ?? smoke.clusterFeatures
})

function getView(): TrackView {
  const canvas = map.getCanvas()
  const corners = [
    [-128, -128],
    [canvas.clientWidth + 128, -128],
    [canvas.clientWidth + 128, canvas.clientHeight + 128],
    [-128, canvas.clientHeight + 128],
  ].map(([x = 0, y = 0]): [number, number] => {
    const { lng, lat } = map.unproject([x, y])
    return [lng, lat]
  })
  return { corners, zoom: map.getZoom(), selectedId: 10001, watchlistIds: null, renderer: 'webgl' }
}
// View registered before the worker exists: it must be re-sent on attach. selectedId is a TrackNumber alias.
setLiveTrackView(1, getView(), true)
map.on('moveend', () => setLiveTrackView(1, getView()))

const worker = new Worker('./worker.mjs', { type: 'module' })
worker.onerror = event => smoke.errors.push(`worker: ${event.message}`)
attachLiveTracksWorker(worker, () => smoke.batchesToStore++)

let batch = 0
setInterval(() => {
  const batchSize = COUNT / 10
  const slice = tracks.slice(batch * batchSize, (batch + 1) * batchSize)
  for (const track of slice) {
    const heading = (track.Heading * Math.PI) / 180
    track.Longitude += Math.sin(heading) * 0.00008
    track.Latitude += Math.cos(heading) * 0.00008
    track.UpdatedAt = Date.now()
  }
  forwardLiveTrackBatch(JSON.stringify(slice))
  batch = (batch + 1) % 10
}, 100)

Object.assign(globalThis, {
  __pickAt(longitude: number, latitude: number) {
    void pickLiveTrackAt(map, map.project([longitude, latitude])).then(track => smoke.replies.push(track ? [track] : []))
  },
  __firstTrack: () => tracks[0],
  __startFollow: () => startSelectedTrackFollow(map, () => true),
  __map: map,
  __countColor(r: number, g: number, b: number) {
    const canvas = map.getCanvas()
    const copy = document.createElement('canvas')
    copy.width = canvas.width
    copy.height = canvas.height
    const context = copy.getContext('2d')
    if (!context) return -1
    context.drawImage(canvas, 0, 0)
    const data = context.getImageData(0, 0, copy.width, copy.height).data
    let matches = 0
    for (let index = 0; index < data.length; index += 4) {
      if (Math.abs((data[index] ?? 0) - r) < 40 && Math.abs((data[index + 1] ?? 0) - g) < 40 && Math.abs((data[index + 2] ?? 0) - b) < 40) matches++
    }
    return matches
  },
})
