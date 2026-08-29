import { afterEach, describe, expect, it, vi } from 'vitest';
import { RunController } from './controller';
import { GameSession } from './engine/game';
import type { PaceSample, PaceSource } from './pace/source';

class FakeSource implements PaceSource {
  readonly id = 'sim';
  private onSample: ((sample: PaceSample) => void) | null = null;

  start(onSample: (sample: PaceSample) => void): void {
    this.onSample = onSample;
  }

  stop(): void {
    this.onSample = null;
  }

  run(distanceM: number, atMs: number): void {
    this.onSample?.({ distanceM, atMs });
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe('RunController', () => {
  it('lands attacks at the lap distance the runner chose, not the level default', () => {
    vi.useFakeTimers();
    const session = new GameSession({ baselinePace: 360 });
    const source = new FakeSource();
    const controller = new RunController(session, source, () => {});
    session.setLapDistance(100);

    controller.start();
    source.run(100, 60_000);
    expect(session.snapshot().stats.laps).toBe(1);

    session.setLapDistance(null); // back to the level's own 400 m
    source.run(100, 120_000);
    expect(session.snapshot().stats.laps).toBe(1);
    source.run(300, 180_000);
    expect(session.snapshot().stats.laps).toBe(2);
    controller.stop();
  });
});
