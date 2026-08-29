import { afterEach, describe, expect, it, vi } from 'vitest';
import { RunController } from './controller';
import { GameSession } from './engine/game';
import type { PaceSample, PaceSource } from './pace/source';

class FakeSource implements PaceSource {
  readonly id = 'sim';
  starts = 0;
  stops = 0;
  private onSample: ((sample: PaceSample) => void) | null = null;

  start(onSample: (sample: PaceSample) => void): void {
    this.starts += 1;
    this.onSample = onSample;
  }

  stop(): void {
    this.stops += 1;
    this.onSample = null;
  }

  get sampling(): boolean {
    return this.onSample !== null;
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
    vi.setSystemTime(0);
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

  it('only arms a source swapped in before the run starts', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const session = new GameSession({ baselinePace: 360, lapDistanceM: 100 });
    const first = new FakeSource();
    const second = new FakeSource();
    const controller = new RunController(session, first, () => {});

    controller.swapSource(second);
    expect(second.sampling).toBe(false);
    expect(first.stops).toBe(1);

    controller.start();
    expect(second.starts).toBe(1);
    expect(first.starts).toBe(0);

    // The first lap runs its full distance: nothing was banked before the start.
    second.run(50, Date.now() + 30_000);
    expect(session.snapshot().stats.laps).toBe(0);
    second.run(50, Date.now() + 60_000);
    expect(session.snapshot().stats.laps).toBe(1);
    controller.stop();
  });

  it('times the first lap from the start of the run', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const session = new GameSession({ baselinePace: 360, lapDistanceM: 100 });
    const source = new FakeSource();
    const controller = new RunController(session, source, () => {});

    controller.start();
    source.run(100, 60_000);
    expect(session.snapshot().stats.laps).toBe(1);
    // The lap is priced at its real 600 s/km, not at an instant, so the rolling
    // baseline gets slower rather than faster.
    expect(session.snapshot().baselinePace).toBeGreaterThan(360);
    controller.stop();
  });

  it('stops sampling and the heartbeat once stopped', () => {
    vi.useFakeTimers();
    const session = new GameSession({ baselinePace: 360 });
    const source = new FakeSource();
    const controller = new RunController(session, source, () => {});

    controller.start();
    controller.stop();
    expect(source.sampling).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
