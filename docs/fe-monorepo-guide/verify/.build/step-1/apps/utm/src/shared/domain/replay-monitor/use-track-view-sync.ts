import { useMountEffect } from '@platform/lib/shared/effects/use-mount-effect'
import { useAsRef } from '@platform/lib/shared/refs/use-as-ref'
import { useConstant } from '@platform/lib/shared/state/use-constant'
import { useSelectedFeatureStore } from '@platform/utm/shared/map/selected-feature-store'
import type { GeoJSONSource, Map as MapLibreMap, MapSourceDataEvent } from 'maplibre-gl'

import { setLiveTrackView, subscribeLiveTrackView } from './live-tracks-channel'
import type { TrackRenderer, TrackView } from './live-tracks.types'

type TrackViewSyncOptions = {
  mapTarget: MapLibreMap
  sourceId: string
  renderer: TrackRenderer
  watchlistTrackIds: ReadonlyArray<number | string> | undefined
  onAlertInViewChange: (hasAlertInView: boolean) => void
}

let nextViewId = 1
// README: Same padding as the old track-viewport.ts, so icons and labels near the edge exist during camera motion.
const VIEW_PADDING_PX = 128
const VIEW_UPDATE_MS = 250

function getSelectedTrackId(): number | null {
  const selected = useSelectedFeatureStore.getState().selected
  if (selected?.type !== 'track') return null
  const id = Number(selected.properties['track_id'] ?? selected.featureId)
  return Number.isFinite(id) ? id : null
}

function getTrackView(mapTarget: MapLibreMap, watchlistTrackIds: ReadonlyArray<number | string> | undefined, renderer: TrackRenderer): TrackView {
  const canvas = mapTarget.getCanvas()
  const right = canvas.clientWidth + VIEW_PADDING_PX
  const bottom = canvas.clientHeight + VIEW_PADDING_PX
  const corners = [
    [-VIEW_PADDING_PX, -VIEW_PADDING_PX],
    [right, -VIEW_PADDING_PX],
    [right, bottom],
    [-VIEW_PADDING_PX, bottom],
  ].map(([x = 0, y = 0]): [number, number] => {
    const { lng, lat } = mapTarget.unproject([x, y])
    return [lng, lat]
  })
  return { corners, zoom: mapTarget.getZoom(), selectedId: getSelectedTrackId(), watchlistIds: watchlistTrackIds?.map(String) ?? null, renderer }
}

/** README: Registers this map as a view of the live-tracks worker and applies the worker's GeoJSON output to the track source. */
export function useTrackViewSync({ mapTarget, sourceId, renderer, watchlistTrackIds, onAlertInViewChange }: TrackViewSyncOptions): void {
  const viewId = useConstant(() => nextViewId++)
  const watchlistRef = useAsRef(watchlistTrackIds)
  const onAlertInViewChangeRef = useAsRef(onAlertInViewChange)

  useMountEffect(function syncTrackView() {
    let needsReset = false
    let viewFrame: number | null = null
    let lastViewAt = 0
    const sendView = (shouldReset = false) => setLiveTrackView(viewId, getTrackView(mapTarget, watchlistRef.current, renderer), shouldReset)

    const unsubscribeView = subscribeLiveTrackView(viewId, update => {
      const source = mapTarget.getSource<GeoJSONSource>(sourceId)
      if (source?.type !== 'geojson') {
        needsReset = true
        return
      }
      if (update.data) void source.setData(update.data)
      if (update.diff) void source.updateData(update.diff)
      onAlertInViewChangeRef.current(update.hasAlertInView)
    })
    const handleMove = () => {
      viewFrame ??= requestAnimationFrame(() => {
        viewFrame = null
        if (performance.now() - lastViewAt < VIEW_UPDATE_MS) return
        lastViewAt = performance.now()
        sendView()
      })
    }
    const handleMoveEnd = () => sendView()
    // README: A style reload recreates the source empty, so the worker must send full data again.
    const handleStyleLoad = () => sendView(true)
    const handleSourceData = (event: MapSourceDataEvent) => {
      if (!needsReset || event.sourceId !== sourceId) return
      needsReset = false
      sendView(true)
    }
    const unsubscribeSelection = useSelectedFeatureStore.subscribe(() => sendView())

    mapTarget.on('move', handleMove)
    mapTarget.on('moveend', handleMoveEnd)
    mapTarget.on('style.load', handleStyleLoad)
    mapTarget.on('sourcedata', handleSourceData)
    sendView(true)

    return () => {
      if (viewFrame !== null) cancelAnimationFrame(viewFrame)
      mapTarget.off('move', handleMove)
      mapTarget.off('moveend', handleMoveEnd)
      mapTarget.off('style.load', handleStyleLoad)
      mapTarget.off('sourcedata', handleSourceData)
      unsubscribeSelection()
      unsubscribeView()
      setLiveTrackView(viewId, null)
    }
  })
}
