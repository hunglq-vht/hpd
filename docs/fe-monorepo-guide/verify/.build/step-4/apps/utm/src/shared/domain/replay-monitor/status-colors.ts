export const TRACK_STATUSES = ['NORMAL', 'WARNING', 'CRITICAL', 'LOST_LINK', 'PROCESSING', 'LOST_CONTROL'] as const

export const STATUS_COLORS = {
  NORMAL: 'var(--color-utm-replay-monitor-normal)',
  WARNING: 'var(--color-utm-replay-monitor-warning)',
  CRITICAL: 'var(--color-utm-replay-monitor-critical)',
  LOST_LINK: 'var(--color-utm-replay-monitor-lost-link)',
  PROCESSING: 'var(--color-utm-replay-monitor-processing)',
  LOST_CONTROL: 'var(--color-utm-replay-monitor-lost-control)',
} as const satisfies Record<(typeof TRACK_STATUSES)[number], string>

export type TrackStatus = (typeof TRACK_STATUSES)[number]
