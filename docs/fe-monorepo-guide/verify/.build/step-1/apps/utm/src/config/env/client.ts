// Stub of @platform/utm/config/env/client (feature flag only), with the catalog change from step 4.
type UtmFeatureKey = 'track-webgl'
export const runtimeConfig: { featureFlag: { isMaintained: boolean; enabledFeatures: ReadonlySet<UtmFeatureKey> } } = { featureFlag: { isMaintained: false, enabledFeatures: new Set() } }
