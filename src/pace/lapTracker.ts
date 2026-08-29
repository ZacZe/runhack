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

  /** Feeds in distance covered since the previous sample. */
  add(distanceM: number, nowMs: number): Lap[] {
    if (this.lapStartedAtMs === null) this.lapStartedAtMs = nowMs;
    if (distanceM <= 0) return [];

    this.progressM += distanceM;
    const laps: Lap[] = [];
    while (this.progressM >= this.lapDistanceM) {
      const start = this.lapStartedAtMs ?? nowMs;
      laps.push({
        distanceM: this.lapDistanceM,
        durationMs: Math.max(1, nowMs - start),
        atMs: nowMs,
      });
      this.progressM -= this.lapDistanceM;
      this.lapStartedAtMs = nowMs;
    }
    return laps;
  }
}
