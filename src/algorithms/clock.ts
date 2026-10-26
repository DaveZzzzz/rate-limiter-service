/**
 * Time source for refill/window math.
 * Production uses monotonic `performance.now()` mapped onto wall-clock
 * milliseconds so NTP jumps cannot rewind buckets.
 */
export interface Clock {
  nowMs(): number;
}

export class MonotonicClock implements Clock {
  private readonly originMs: number;

  constructor(wallMs: number = Date.now(), monotonicMs: number = performance.now()) {
    this.originMs = wallMs - monotonicMs;
  }

  nowMs(): number {
    return this.originMs + performance.now();
  }
}

export class FakeClock implements Clock {
  constructor(private currentMs: number) {}

  nowMs(): number {
    return this.currentMs;
  }

  advance(ms: number): void {
    this.currentMs += ms;
  }

  set(ms: number): void {
    this.currentMs = ms;
  }
}

export function unixSeconds(nowMs: number): number {
  return Math.floor(nowMs / 1000);
}
