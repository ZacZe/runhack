import type { Lap } from '../engine/types';

/**
 * Accumulates distance from any source and emits a lap every `lapDistanceM`.
 * Distance-threshold laps work on a track, a street loop or a treadmill;
 * geometric loop detection does not.
 */
export class LapTracker {
  private progressM = 0;
  private lapStartedAtMs: number | null = null;
  private lastSampleAtMs: number | null = null;

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
    this.lastSampleAtMs = null;
  }

  /**
   * Starts the lap clock. Samples report distance covered since the previous
   * sample, so the first one has no interval start of its own — the run start
   * supplies it.
   */
  begin(nowMs: number): void {
    this.lapStartedAtMs = nowMs;
    this.lastSampleAtMs = nowMs;
  }

  /**
   * Feeds in distance covered since the previous sample. Without a preceding
   * `begin`, the first sample only starts the clock: its interval is unmeasured
   * and counting it would price the lap off a shorter duration than it took.
   *
   * A sample can cross several lap boundaries, so its elapsed time is split
   * across them in proportion to distance instead of being spent entirely on
   * the first lap.
   */
  add(distanceM: number, nowMs: number): Lap[] {
    const sampleStartMs = this.lastSampleAtMs;
    this.lastSampleAtMs = nowMs;
    if (this.lapStartedAtMs === null || sampleStartMs === null) {
      this.lapStartedAtMs ??= nowMs;
      return [];
    }
    if (distanceM <= 0) return [];

    const sampleMs = Math.max(0, nowMs - sampleStartMs);
    this.progressM += distanceM;
    const laps: Lap[] = [];
    while (this.progressM >= this.lapDistanceM) {
      const intoSampleM = distanceM - (this.progressM - this.lapDistanceM);
      const crossedAtMs = sampleStartMs + (sampleMs * intoSampleM) / distanceM;
      laps.push({
        distanceM: this.lapDistanceM,
        durationMs: Math.max(1, Math.round(crossedAtMs - this.lapStartedAtMs)),
        atMs: Math.round(crossedAtMs),
      });
      this.progressM -= this.lapDistanceM;
      this.lapStartedAtMs = crossedAtMs;
    }
    return laps;
  }
}
