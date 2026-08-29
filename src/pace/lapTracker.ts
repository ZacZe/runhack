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
   * Restarts the sample interval without disturbing lap progress. A replacement
   * pace source measures from its own start, so its first sample must not be
   * priced as if it covered the gap since the retired source's last one.
   */
  resumeSampling(nowMs: number): void {
    if (this.lapStartedAtMs === null) return;
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

    const laps: Lap[] = [];
    // Shortening the lap distance can leave whole laps already covered before
    // this sample began. That distance was run before it, so those laps are
    // timed off the interval that produced it instead of landing inside — and
    // being priced as instant. Each lap takes the share of that interval its
    // distance earned, which leaves the residual distance holding the rest:
    // spending it all on the completed laps would hand the partial lap a
    // sprint it never ran.
    const pending = Math.floor(this.progressM / this.lapDistanceM);
    if (pending > 0) {
      const share = ((sampleStartMs - this.lapStartedAtMs) * this.lapDistanceM) / this.progressM;
      let boundaryMs = this.lapStartedAtMs;
      for (let i = 0; i < pending; i += 1) {
        boundaryMs += share;
        laps.push(this.closeLap(boundaryMs));
      }
    }

    const sampleMs = Math.max(0, nowMs - sampleStartMs);
    this.progressM += distanceM;
    while (this.progressM >= this.lapDistanceM) {
      const intoSampleM = distanceM - (this.progressM - this.lapDistanceM);
      laps.push(this.closeLap(sampleStartMs + (sampleMs * intoSampleM) / distanceM));
    }
    return laps;
  }

  /** Banks a lap that ended at `crossedAtMs`; the next one starts there. */
  private closeLap(crossedAtMs: number): Lap {
    const lap: Lap = {
      distanceM: this.lapDistanceM,
      durationMs: Math.max(1, Math.round(crossedAtMs - (this.lapStartedAtMs ?? crossedAtMs))),
      atMs: Math.round(crossedAtMs),
    };
    this.progressM -= this.lapDistanceM;
    this.lapStartedAtMs = crossedAtMs;
    return lap;
  }
}
