import { runtimeConfig } from '@platform/utm/config/env/client'

/** TEMP: Remove with the GeoJSON drone layers once WebGL is the default (step 5). */
export function isTrackWebGlEnabled(): boolean {
  // DEVMODE: ?trackRenderer=webgl or ?trackRenderer=geojson overrides the flag, for side-by-side demos.
  if (import.meta.env.DEV && typeof location !== 'undefined') {
    const renderer = new URLSearchParams(location.search).get('trackRenderer')
    if (renderer) return renderer === 'webgl'
  }
  return runtimeConfig.featureFlag.enabledFeatures.has('track-webgl')
}
