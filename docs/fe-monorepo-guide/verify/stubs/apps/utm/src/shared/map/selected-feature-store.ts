import { create } from 'zustand'

import type { JsonValue } from '@platform/lib/shared/type-guards/static.types'

export type MapFeatureType =
  | 'track'
  | 'track_replay_static'
  | 'track_replay_dynamic'
  | 'station_5g'
  | 'tdoa_station'
  | 'bv5_station'
  | 'track_history'
  | 'flight_notification'
  | 'flight_corridor'
  | 'rtk_station'
  | 'radar_station'
  | 'remote_id_station'
  | 'assessment_patch'
  | 'network_station'
  | 'building'
  | 'airspace_zone'
  | 'landing_zone'

export type SelectedFeatureInfo = {
  type: MapFeatureType
  featureId: string | number
  sourceId: string
  layerId: string
  lngLat: [number, number]
  properties: Record<string, JsonValue>
}

type SelectedFeatureState = {
  selected: SelectedFeatureInfo | null
  isTargetFollowing: boolean
  setSelected: (featureInfo: SelectedFeatureInfo | null) => void
  setIsTargetFollowing: (following: boolean) => void
  clearSelected: () => void
  toggleSelected: (featureInfo: SelectedFeatureInfo) => void
}

export const useSelectedFeatureStore = create<SelectedFeatureState>()((set, get) => ({
  selected: null,
  isTargetFollowing: false,
  setSelected: info =>
    set({
      selected: info,
      isTargetFollowing: info?.type === 'track',
    }),
  setIsTargetFollowing: following => set({ isTargetFollowing: following }),
  clearSelected: () => set({ selected: null, isTargetFollowing: false }),
  toggleSelected: info => {
    const currentFeature = get().selected
    if (currentFeature?.featureId === info.featureId && currentFeature.type === info.type) {
      set({ selected: null, isTargetFollowing: false })
    } else {
      set({
        selected: info,
        isTargetFollowing: info.type === 'track',
      })
    }
  },
}))
