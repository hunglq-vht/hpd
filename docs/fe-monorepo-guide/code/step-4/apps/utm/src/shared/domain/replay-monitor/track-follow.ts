import type { Map as MapLibreMap } from 'maplibre-gl'

import { getLiveTrackClockSeconds, subscribeLiveTrackSelection } from './live-tracks-channel'
import type { TrackFrame } from './live-tracks.types'

function mercatorToLonLat(x: number, y: number): [number, number] {
  return [x * 360 - 180, (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI]
}

/** README: Centres the map on the selected drone's drawn (gliding) position every frame. Returns the cleanup. */
export function startSelectedTrackFollow(mapTarget: MapLibreMap, isFollowing: () => boolean): () => void {
  let selection: Pick<TrackFrame, 'selected' | 'origin' | 'glideSeconds'> | null = null
  let lastCenter: [number, number] | null = null
  const unsubscribeSelection = subscribeLiveTrackSelection(next => {
    selection = next
  })
  const followSelectedTrack = () => {
    animationFrame = requestAnimationFrame(followSelectedTrack)
    const instance = selection?.selected
    // README: Never fight a gesture or a flyTo; follow resumes when the camera stops.
    if (!selection || !instance || !isFollowing() || mapTarget.isMoving()) return
    const fraction = Math.min(1, Math.max(0, (getLiveTrackClockSeconds() - (instance[4] ?? 0)) / selection.glideSeconds))
    const [startX = 0, startY = 0, endX = 0, endY = 0] = instance
    const center = mercatorToLonLat(selection.origin[0] + startX + (endX - startX) * fraction, selection.origin[1] + startY + (endY - startY) * fraction)
    if (lastCenter?.[0] === center[0] && lastCenter[1] === center[1]) return
    lastCenter = center
    mapTarget.jumpTo({ center })
  }
  let animationFrame = requestAnimationFrame(followSelectedTrack)
  return () => {
    cancelAnimationFrame(animationFrame)
    unsubscribeSelection()
  }
}
