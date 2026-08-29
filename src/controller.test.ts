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
  it('starts a called sprint from the call, not from the sample that triggered it', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const session = new GameSession({
      baselinePace: 360,
      lapDistanceM: 100,
      sprintDistanceM: 200,
    });
    const source = new FakeSource();
    const controller = new RunController(session, source, () => {});
    controller.start();

    source.run(100, 60_000);
    source.run(100, 120_000);
    // A coarse sample finishes the lap that calls the sprint and keeps going.
    // That extra 60 m was run against the 100 m lap, before the call went out.
    source.run(160, 180_000);
    expect(session.snapshot().stats.laps).toBe(3);
    expect(session.snapshot().sprint?.distanceM).toBe(200);
    expect(session.snapshot().lapDistanceM).toBe(200);
    expect(session.snapshot().lapProgressM).toBe(0);

    // The 60 m the sprint doesn't count was still run, so the run keeps it.
    expect(session.snapshot().stats.totalDistanceM).toBe(360);

    source.run(199, 240_000);
    expect(session.snapshot().stats.laps).toBe(3);
    source.run(1, 241_000);
    expect(session.snapshot().stats.laps).toBe(4);
    expect(session.snapshot().sprint).toBeNull();
    expect(session.snapshot().lapDistanceM).toBe(100);
    expect(session.snapshot().stats.totalDistanceM).toBe(560);
    controller.stop();
  });

  it('stops defending on the speed of a fix that GPS never followed up', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const session = new GameSession({
      baselinePace: 360,
      lapDistanceM: 5000,
      speedThresholdKmh: 6,
    });
    const source = new FakeSource();
    const controller = new RunController(session, source, () => {});
    controller.start();
    const enemy = session.snapshot().enemy;

    // One fast fix, then nothing: the fix speaks for its own 10 s and no longer.
    source.run(30, 10_000);
    vi.setSystemTime(10_500);
    vi.advanceTimersByTime(1000);
    expect(session.snapshot().speedKmh).toBeCloseTo(10.8, 5);

    // Past the grace the silence is no longer credible as running, so the speed
    // it was measured at is gone and the enemy's blow lands.
    vi.setSystemTime(60_000);
    vi.advanceTimersByTime(1000);
    const after = session.snapshot();
    expect(after.speedKmh).toBe(0);
    expect(after.playerHp).toBeLessThan(after.playerMaxHp);
    expect(after.playerHp).toBeLessThanOrEqual(after.playerMaxHp - enemy.attackDamage);
    controller.stop();
  });

  it('hands the rest of a sample back to the ordinary lap when it finishes a sprint', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const session = new GameSession({
      baselinePace: 360,
      lapDistanceM: 100,
      sprintDistanceM: 50,
    });
    const source = new FakeSource();
    const controller = new RunController(session, source, () => {});
    controller.start();

    source.run(100, 60_000);
    source.run(100, 120_000);
    source.run(100, 180_000); // calls the 50 m sprint
    expect(session.snapshot().lapDistanceM).toBe(50);

    // One coarse fix covers the sprint and then some. Only the first 50 m answer
    // the sprint; the remaining 70 m belong to the 100 m lap that follows, so
    // they are ground towards the next attack rather than a second one.
    source.run(120, 240_000);
    expect(session.snapshot().stats.laps).toBe(4);
    expect(session.snapshot().sprint).toBeNull();
    expect(session.snapshot().lapDistanceM).toBe(100);
    expect(session.snapshot().lapProgressM).toBe(70);
    // Banked laps only — the 70 m are still in the lap in progress.
    expect(session.snapshot().stats.totalDistanceM).toBe(350);
    controller.stop();
  });

  it('starts a replacement sprint fresh when one sample retires and recalls it', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const session = new GameSession({ baselinePace: 360, lapDistanceM: 100 });
    const source = new FakeSource();
    const controller = new RunController(session, source, () => {});
    controller.start();

    source.run(100, 60_000);
    source.run(100, 120_000);
    source.run(100, 180_000); // calls a sprint
    expect(session.snapshot().sprint?.distanceM).toBe(100);
    // Retiring the call and covering three more laps in one coarse sample calls
    // a replacement: a standing sprint at both ends of the sample, but not the
    // same one, so the new call still starts from an empty lap.
    session.setSprintDistance(200);
    expect(session.snapshot().sprint).toBeNull();
    source.run(340, 300_000);
    expect(session.snapshot().sprint?.distanceM).toBe(200);
    expect(session.snapshot().lapProgressM).toBe(0);
    expect(session.snapshot().stats.totalDistanceM).toBe(640);
    controller.stop();
  });

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
    // The threshold is lowered so the deliberately slow lap still lands: the
    // test is about how the lap is priced, not whether it is fast enough.
    const session = new GameSession({ baselinePace: 360, lapDistanceM: 100, speedThresholdKmh: 1 });
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

  it('prices a retained-anchor sample over its own interval, not since the swap', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    // The threshold is lowered so the deliberately slow lap still lands: the
    // test is about how the lap is priced, not whether it is fast enough.
    const session = new GameSession({ baselinePace: 360, lapDistanceM: 100, speedThresholdKmh: 1 });
    const source = new FakeSource();
    const controller = new RunController(session, source, () => {});

    controller.start();
    source.run(50, 30_000);

    // The screen dims at t=30 s and wakes at t=90 s: the visibility handler
    // swaps the same GPS source back in, and its retained anchor dates the next
    // sample from t=30 s — 50 m run over the whole suspended minute plus 15 s.
    vi.setSystemTime(90_000);
    controller.swapSource(source);
    source.run(50, 105_000, 30_000);

    expect(session.snapshot().stats.laps).toBe(1);
    // 100 m in 105 s; pricing the second 50 m over only the 15 s since the swap
    // would sell the lap as a 45 s sprint.
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

  it('judges the enemy attack by the speed the runner eased off to, not the batch average', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const session = new GameSession({
      baselinePace: 360,
      lapDistanceM: 5000,
      speedThresholdKmh: 6,
    });
    const source = new FakeSource();
    const controller = new RunController(session, source, () => {});

    controller.start();
    const enemy = session.snapshot().enemy;
    // 10.8 km/h for 40 s, then eased off to 3.6 km/h — all inside one throttled
    // heartbeat that lands after the attack was due. Averaged, the batch reads
    // 9.9 km/h and the blow would miss; the runner is actually walking.
    for (let atMs = 1000; atMs <= 40_000; atMs += 1000) source.run(3, atMs);
    for (let atMs = 41_000; atMs <= 46_000; atMs += 1000) source.run(1, atMs);
    vi.setSystemTime(46_500);
    vi.advanceTimersByTime(1000);

    const after = session.snapshot();
    expect(after.speedKmh).toBeCloseTo(3.6, 5);
    expect(after.playerHp).toBe(after.playerMaxHp - enemy.attackDamage);
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

  it('does not price a lap off time the source never measured', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    // The threshold is lowered so the deliberately slow lap still lands: the
    // test is about how the lap is priced, not whether it is fast enough.
    const session = new GameSession({ baselinePace: 360, lapDistanceM: 100, speedThresholdKmh: 1 });
    const source = new FakeSource();
    const controller = new RunController(session, source, () => {});

    controller.start();
    source.run(50, 30_000);
    // A minute of dropped fixes, then 100 m measured over 30 s. The lap closes
    // halfway through that interval, at t=105 s — interpolating from the last
    // sample instead would place it at 75 s, inside time nothing was measured
    // over, and pay the lap for a sprint.
    source.run(100, 120_000, 90_000);

    expect(session.snapshot().stats.laps).toBe(1);
    expect(session.snapshot().stats.bestPaceRatio).toBeCloseTo(1050 / 360, 2);
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
