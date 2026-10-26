import { useMountEffect } from '@platform/lib/shared/effects/use-mount-effect'
import { useSyncExternalStore } from 'react'

import { getTrackPerfSnapshot, startTrackPerf, subscribeTrackPerf } from './track-perf'

// DEVMODE: Shown with ?perf in dev builds only. Raw JSON on purpose: no UI copy to translate.
export function TrackPerfOverlay() {
  if (!import.meta.env.DEV || typeof location === 'undefined' || !new URLSearchParams(location.search).has('perf')) return null
  return <TrackPerfPanel />
}

function TrackPerfPanel() {
  useMountEffect(function startTrackPerfCounters() {
    return startTrackPerf()
  })
  const snapshot = useSyncExternalStore(subscribeTrackPerf, getTrackPerfSnapshot, () => null)
  return <pre className="pointer-events-none absolute top-2 left-2 z-50 text-xs">{JSON.stringify(snapshot, null, 1)}</pre>
}
