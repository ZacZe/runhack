import { afterEach, describe, expect, it, vi } from 'vitest';
import { RunController } from './controller';
import { BALANCE } from './engine/damage';
import { GameSession } from './engine/game';
import type { PaceSample, PaceSource } from './pace/source';

class FakeSource implements PaceSource {
  readonly id = 'sim';
  starts = 0;
  stops = 0;
  private onSample: ((sample: PaceSample) => void) | null = null;
  private measuredToMs = Date.now();

  start(onSample: (sample: PaceSample) => void): void {
    this.starts += 1;
    this.onSample = onSample;
    this.measuredToMs = Date.now();
  }

  stop(): void {
    this.stops += 1;
    this.onSample = null;
  }

  get sampling(): boolean {
    return this.onSample !== null;
  }

  /** Each sample covers the interval since the previous one, as a source does. */
  run(distanceM: number, atMs: number, fromMs = this.measuredToMs): void {
    this.measuredToMs = atMs;
    this.onSample?.({ fromMs, distanceM, atMs });
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

  it('does not charge a mid-run source swap gap to the lap in progress', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const session = new GameSession({ baselinePace: 360, lapDistanceM: 100 });
    const first = new FakeSource();
    const second = new FakeSource();
    const controller = new RunController(session, first, () => {});

    controller.start();
    first.run(50, 30_000);

    // Fiddling with the phone for a minute, then 100 m from the replacement: its
    // sample covers the 30 s it measured, not the 90 s since the last sample, so
    // the lap boundary lands halfway through it at t=105 s.
    vi.setSystemTime(90_000);
    controller.swapSource(second);
    second.run(100, 120_000);

    expect(session.snapshot().stats.laps).toBe(1);
    // 100 m in 105 s against the 360 s/km seed; charging the switching gap to
    // the sample would price the lap at 75 s and hand out free damage.
    expect(session.snapshot().stats.bestPaceRatio).toBeCloseTo(1050 / 360, 2);
    controller.stop();
  });

  it('keeps the streak alive when a throttled heartbeat covers continuous running', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const session = new GameSession({ baselinePace: 360, lapDistanceM: 100 });
    const source = new FakeSource();
    const controller = new RunController(session, source, () => {});

    controller.start();
    // Samples keep arriving while the tab is backgrounded and the 1 s heartbeat
    // does not fire for 60 s.
    for (let atMs = 1000; atMs <= 60_000; atMs += 1000) source.run(3, atMs);
    vi.setSystemTime(60_000);
    vi.advanceTimersByTime(1000);

    expect(session.snapshot().streakMs).toBe(60_000);
    controller.stop();
  });

  it('breaks the streak on a pause hidden inside one throttled heartbeat', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const session = new GameSession({ baselinePace: 360, lapDistanceM: 100 });
    const source = new FakeSource();
    const controller = new RunController(session, source, () => {});

    controller.start();
    // One heartbeat covers movement, a 35 s stop measured as zero distance, then
    // movement again: the stop must not disappear between the batch's first and
    // last sample.
    source.run(3, 1000);
    source.run(0, 20_000);
    source.run(0, 35_000);
    source.run(3, 36_000);
    vi.setSystemTime(36_500);
    vi.advanceTimersByTime(1000);

    // The pre-pause streak is gone; what is left is the one second of running
    // the last sample measured, which is a fresh streak rather than a continued
    // one — the 35 s stop is nowhere in it.
    expect(session.snapshot().streakMs).toBe(1000);
    expect(session.snapshot().stats.longestStreakMs).toBe(1000);
    controller.stop();
  });

  it('keeps the streak alive when movement is measured sparsely', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const session = new GameSession({ baselinePace: 360, lapDistanceM: 100 });
    const source = new FakeSource();
    const controller = new RunController(session, source, () => {});

    controller.start();
    // Two fixes 35 s apart, the second covering the distance run since the
    // first: sparse measurement is not a stop, so the streak survives.
    source.run(3, 1000);
    source.run(100, 36_000);
    vi.setSystemTime(36_500);
    vi.advanceTimersByTime(1000);

    expect(session.snapshot().streakMs).toBe(36_000);
    controller.stop();
  });

  it('keeps the streak alive when heartbeats outnumber sparse fixes', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const session = new GameSession({ baselinePace: 360, lapDistanceM: 100 });
    const source = new FakeSource();
    const controller = new RunController(session, source, () => {});

    controller.start();
    // Fixes 40 s apart while the 1 s heartbeat keeps firing: each fix covers the
    // running done since the one before it, so the forty ticks in between are
    // looking at an interval nobody has measured yet, not at a stopped runner.
    for (let atMs = 40_000; atMs <= 120_000; atMs += 40_000) {
      vi.advanceTimersByTime(40_000);
      source.run(100, atMs);
    }
    vi.advanceTimersByTime(1000);

    expect(session.snapshot().streakMs).toBe(120_000);
    controller.stop();
  });

  it('leaves time the source never measured out of the streak', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const session = new GameSession({ baselinePace: 360, lapDistanceM: 100 });
    const source = new FakeSource();
    const controller = new RunController(session, source, () => {});

    controller.start();
    source.run(3, 1000);
    // GPS reacquiring: the fixes in between were dropped, so this sample opens
    // at 40 s rather than at the last one. Whatever happened in the gap, it is
    // not running the runner gets paid for.
    vi.setSystemTime(41_500);
    source.run(3, 41_000, 40_000);
    vi.advanceTimersByTime(1000);

    expect(session.snapshot().streakMs).toBe(1000);
    controller.stop();
  });

  it('breaks the streak on a pause spent switching sources', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const session = new GameSession({ baselinePace: 360, lapDistanceM: 100 });
    const first = new FakeSource();
    const second = new FakeSource();
    const controller = new RunController(session, first, () => {});

    controller.start();
    first.run(3, 1000);
    // The heartbeat is throttled across the whole swap, so the batch would
    // otherwise reduce to one window running from the old source's movement to
    // the new source's — swallowing the 40 s spent switching.
    vi.setSystemTime(41_000);
    controller.swapSource(second);
    second.run(3, 42_000);
    vi.setSystemTime(42_500);
    vi.advanceTimersByTime(1000);

    // Restarted at the replacement's own first interval, not carried across the
    // switch: the 40 s gap is not in the streak.
    expect(session.snapshot().streakMs).toBe(1000);
    expect(session.snapshot().stats.longestStreakMs).toBe(1000);
    controller.stop();
  });

  it('expires the stale streak before the replacement can finish a lap', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const session = new GameSession({ baselinePace: 360, lapDistanceM: 100 });
    const first = new FakeSource();
    const second = new FakeSource();
    const controller = new RunController(session, second, () => {});

    controller.swapSource(first);
    controller.start();
    for (let atMs = 1000; atMs <= 60_000; atMs += 1000) {
      vi.advanceTimersByTime(1000);
      first.run(1, atMs);
    }
    vi.advanceTimersByTime(1000);
    const earned = session.snapshot().streakMs;
    expect(earned).toBeGreaterThan(BALANCE.streakBreakMs);

    // A minute of standing still while the phone changes source, then the
    // replacement finishes the lap on its very first sample — before any
    // heartbeat can notice the pause.
    vi.setSystemTime(120_000);
    controller.swapSource(second);
    expect(session.snapshot().streakMs).toBe(0);

    second.run(40, 121_000);
    expect(session.snapshot().stats.laps).toBe(1);
    // The lap is paid at the streak the runner actually has, and the minute
    // standing still is nowhere in the record.
    expect(session.snapshot().stats.longestStreakMs).toBe(earned);
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
