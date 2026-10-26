import { getCssColor } from '@platform/lib/shared/css/get-css-color'
import { useMountEffect } from '@platform/lib/shared/effects/use-mount-effect'
import { catchErrorAsync } from '@platform/lib/shared/error/handle-error'
import droneIconSource from '@platform/utm/assets/icons/drone1_out.png'
import { STATUS_COLORS, TRACK_STATUSES } from '@platform/utm/shared/domain/replay-monitor/status-colors'
import { useSelectedFeatureStore } from '@platform/utm/shared/map/selected-feature-store'
import type { Map as MapLibreMap, MapMouseEvent } from 'maplibre-gl'

import { getLiveTrackClockSeconds, releaseLiveTrackFrame, setHoveredLiveTrack, subscribeLiveTrackFrames } from './live-tracks-channel'
import { pickLiveTrackAt } from './pick-live-track'
import { startSelectedTrackFollow } from './track-follow'
import { createTrackGlLayer } from './track-gl-layer'
import type { Rgba, TrackGlColors, TrackGlLayer } from './track-gl-layer'

const TRACK_GL_LAYER_ID = 'track-gl-layer'

function toRgba(color: string): Rgba {
  const canvas = document.createElement('canvas')
  canvas.width = 1
  canvas.height = 1
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) return [1, 1, 1, 1]
  context.fillStyle = color
  context.fillRect(0, 0, 1, 1)
  const [red = 255, green = 255, blue = 255, alpha = 255] = context.getImageData(0, 0, 1, 1).data
  return [red / 255, green / 255, blue / 255, alpha / 255]
}

function getTrackGlColors(): TrackGlColors {
  return {
    status: TRACK_STATUSES.map(status => toRgba(getCssColor(STATUS_COLORS[status]))),
    pulse: [toRgba(getCssColor('var(--color-utm-replay-monitor-marker-outline-warning)')), toRgba(getCssColor('var(--color-utm-replay-monitor-marker-outline-danger-soft)'))],
    neutral: toRgba(getCssColor('var(--color-utm-replay-monitor-icon-neutral-pale)')),
  }
}

/** README: WebGL replacement for SelectedTrackCamera: per-frame follow, paused by a manual drag. */
export function SelectedTrackGlFollower({ mapTarget }: { mapTarget: MapLibreMap }) {
  useMountEffect(function followSelectedTrackWithWebGl() {
    const stopFollow = startSelectedTrackFollow(mapTarget, () => {
      const { selected, isTargetFollowing } = useSelectedFeatureStore.getState()
      return isTargetFollowing && selected?.type === 'track'
    })
    const handleDragStart = () => useSelectedFeatureStore.getState().setIsTargetFollowing(false)
    mapTarget.on('dragstart', handleDragStart)
    return () => {
      stopFollow()
      mapTarget.off('dragstart', handleDragStart)
    }
  })

  return null
}

/** README: Adds the WebGL drone layer under `beforeLayerId` and picks the hovered drone in the worker. */
export function TrackGlLayerView({ mapTarget, beforeLayerId }: { mapTarget: MapLibreMap; beforeLayerId: string }) {
  useMountEffect(function drawTracksWithWebGl() {
    let layer: TrackGlLayer | null = null
    let isDisposed = false
    let hoverFrame: number | null = null
    let hoveredId: number | null = null

    const icon = new Image()
    icon.src = droneIconSource
    void catchErrorAsync(() => icon.decode()).then(([error]) => {
      if (error || isDisposed) return
      layer = createTrackGlLayer({ id: TRACK_GL_LAYER_ID, icon, colors: getTrackGlColors(), getNow: getLiveTrackClockSeconds, releaseBuffer: releaseLiveTrackFrame })
      mapTarget.addLayer(layer, mapTarget.getLayer(beforeLayerId) ? beforeLayerId : undefined)
    })

    const unsubscribeFrames = subscribeLiveTrackFrames(frame => {
      if (layer) layer.setFrame(frame)
      else releaseLiveTrackFrame(frame.buffer)
    })

    const handleMouseMove = (event: MapMouseEvent) => {
      if (hoverFrame !== null) return
      hoverFrame = requestAnimationFrame(() => {
        hoverFrame = null
        void pickLiveTrackAt(mapTarget, event.point).then(track => {
          const id = track?.id ?? null
          if (isDisposed || id === hoveredId) return
          hoveredId = id
          setHoveredLiveTrack(id)
          mapTarget.getCanvas().style.cursor = id === null ? 'default' : 'pointer'
        })
      })
    }
    mapTarget.on('mousemove', handleMouseMove)

    return () => {
      isDisposed = true
      if (hoverFrame !== null) cancelAnimationFrame(hoverFrame)
      mapTarget.off('mousemove', handleMouseMove)
      unsubscribeFrames()
      setHoveredLiveTrack(null)
      if (mapTarget.getLayer(TRACK_GL_LAYER_ID)) mapTarget.removeLayer(TRACK_GL_LAYER_ID)
    }
  })

  return null
}
