import type { Lap } from '../engine/types';

/**
 * Accumulates distance from any source and emits a lap every `lapDistanceM`.
 * Distance-threshold laps work on a track, a street loop or a treadmill;
 * geometric loop detection does not.
 */
export class LapTracker {
  private progressM = 0;
  private lapStartedAtMs: number | null = null;

  constructor(private lapDistanceM: number) {}

  setLapDistance(lapDistanceM: number): void {
    this.lapDistanceM = lapDistanceM;
  }

  get progress(): number {
    return this.progressM;
  }

  get lapDistance(): number {
    return this.lapDistanceM;
  }

  reset(): void {
    this.progressM = 0;
    this.lapStartedAtMs = null;
  }

  /**
   * Starts the lap clock. Samples report distance covered since the previous
   * sample, so the first one has no interval start of its own — the run start
   * supplies it.
   */
  begin(nowMs: number): void {
    this.lapStartedAtMs = nowMs;
  }

  /**
   * Feeds in distance covered since the previous sample. Without a preceding
   * `begin`, the first sample only starts the clock: its interval is unmeasured
   * and counting it would price the lap off a shorter duration than it took.
   */
  add(distanceM: number, nowMs: number): Lap[] {
    if (this.lapStartedAtMs === null) {
      this.lapStartedAtMs = nowMs;
      return [];
    }
    if (distanceM <= 0) return [];

    this.progressM += distanceM;
    const laps: Lap[] = [];
    while (this.progressM >= this.lapDistanceM) {
      laps.push({
        distanceM: this.lapDistanceM,
        durationMs: Math.max(1, nowMs - this.lapStartedAtMs),
        atMs: nowMs,
      });
      this.progressM -= this.lapDistanceM;
      this.lapStartedAtMs = nowMs;
    }
    return laps;
  }
}
