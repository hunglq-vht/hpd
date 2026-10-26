// Stub of the global from packages/lib/src/plugins/react-grab/react-scan-debug.ts.
declare global {
  interface Window {
    __REACT_SCAN_DEBUG__?: { ready: Promise<void>; enable: () => Promise<void>; clear: () => void; getEvents: () => unknown[] }
  }
}
export {}
