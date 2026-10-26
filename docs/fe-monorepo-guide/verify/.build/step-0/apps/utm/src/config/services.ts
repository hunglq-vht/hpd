// Stub of apps/utm/src/config/services.ts (u1 prefix, no overrides).
export function utmServicePath(service: string, path: string): string {
  return `/u1-${service}${path.startsWith('/') || path === '' ? path : `/${path}`}`
}
