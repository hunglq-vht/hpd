// Small, allocation-free helpers for throughput and latency metrics (worker + benchmark).

/** Reservoir of latency samples (ms) for one reporting window. */
export class LatencyWindow {
  private buf: Float64Array;
  private n = 0;
  private seen = 0;
  constructor(size = 8192) {
    this.buf = new Float64Array(size);
  }
  add(ms: number) {
    this.seen++;
    if (this.n < this.buf.length) {
      this.buf[this.n++] = ms;
    } else {
      // reservoir sampling keeps an unbiased sample when messages outnumber slots
      const j = Math.floor(Math.random() * this.seen);
      if (j < this.buf.length) this.buf[j] = ms;
    }
  }
  /** Returns percentiles and resets the window. */
  take(): LatencySummary {
    const s = this.buf.subarray(0, this.n).sort();
    const p = (q: number) => (s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : 0);
    const out = { p50: p(0.5), p95: p(0.95), p99: p(0.99), max: s.length ? s[s.length - 1] : 0, samples: this.seen };
    this.n = 0;
    this.seen = 0;
    return out;
  }
}

export interface LatencySummary {
  p50: number;
  p95: number;
  p99: number;
  max: number;
  samples: number;
}

/** NTP-style clock offset estimate from request/reply samples: keep the lowest-RTT sample. */
export class ClockOffset {
  offsetMs = 0;
  rttMs = Infinity;
  add(sentAt: number, serverTime: number, receivedAt: number) {
    const rtt = receivedAt - sentAt;
    if (rtt <= this.rttMs) {
      this.rttMs = rtt;
      this.offsetMs = serverTime - (sentAt + receivedAt) / 2;
    }
  }
}
