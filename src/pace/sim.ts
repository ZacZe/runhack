import type { PaceSample, PaceSource } from './source';

const TICK_MS = 1000;

/**
 * Treadmill mode: a speed dial stands in for GPS so the game is playable and
 * testable indoors, at a desk, and in CI.
 */
export class SimPaceSource implements PaceSource {
  readonly id = 'sim' as const;
  private timer: ReturnType<typeof setInterval> | null = null;
  private speedKmh: number;

  constructor(initialSpeedKmh = 10) {
    this.speedKmh = initialSpeedKmh;
  }

  setSpeed(speedKmh: number): void {
    this.speedKmh = Math.max(0, speedKmh);
  }

  get speed(): number {
    return this.speedKmh;
  }

  start(onSample: (sample: PaceSample) => void): void {
    this.stop();
    let fromMs = Date.now();
    this.timer = setInterval(() => {
      const atMs = Date.now();
      onSample({
        fromMs,
        distanceM: (this.speedKmh * 1000 * (TICK_MS / 1000)) / 3600,
        atMs,
      });
      fromMs = atMs;
    }, TICK_MS);
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }
}
