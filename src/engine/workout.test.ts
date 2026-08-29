import { describe, expect, it } from 'vitest';

import {
  WORKOUT_LEVELS,
  WorkoutTracker,
  nextWorkoutLevel,
  workoutSession,
} from './workout';

const MIN = 60_000;

describe('workoutSession', () => {
  it('opens level one with the C25K week-one intervals after a warm-up walk', () => {
    const session = workoutSession(1);
    expect(session.segments[0]).toEqual({ kind: 'walk', durationMs: 5 * MIN });
    const runs = session.segments.filter((s) => s.kind === 'run');
    expect(runs).toHaveLength(8);
    for (const r of runs) expect(r.durationMs).toBe(1 * MIN);
    expect(session.totalRunMs).toBe(8 * MIN);
  });

  it('tops out at a continuous thirty-minute run', () => {
    const session = workoutSession(WORKOUT_LEVELS);
    expect(session.segments).toHaveLength(2);
    expect(session.segments[1]).toEqual({ kind: 'run', durationMs: 30 * MIN });
  });

  it('clamps levels outside the ladder', () => {
    expect(workoutSession(0).level).toBe(1);
    expect(workoutSession(99).level).toBe(WORKOUT_LEVELS);
  });
});

describe('nextWorkoutLevel', () => {
  it('moves up when the round was held comfortably', () => {
    expect(nextWorkoutLevel(3, 0.9)).toBe(4);
  });
  it('repeats a shaky round', () => {
    expect(nextWorkoutLevel(3, 0.7)).toBe(3);
  });
  it('steps back after a struggle, never below level one', () => {
    expect(nextWorkoutLevel(3, 0.3)).toBe(2);
    expect(nextWorkoutLevel(1, 0)).toBe(1);
  });
  it('never climbs past the top of the ladder', () => {
    expect(nextWorkoutLevel(WORKOUT_LEVELS, 1)).toBe(WORKOUT_LEVELS);
  });
});

describe('WorkoutTracker', () => {
  it('walks the segments on the wall clock', () => {
    const tracker = new WorkoutTracker(workoutSession(1), 0);
    const warm = tracker.tick(4 * MIN, 0, 6);
    expect(warm.segment).toEqual({ kind: 'walk', durationMs: 5 * MIN });
    expect(warm.segmentRemainingMs).toBe(1 * MIN);
    const firstRun = tracker.tick(5 * MIN + 30_000, 8, 6);
    expect(firstRun.segment?.kind).toBe('run');
    expect(firstRun.segmentRemainingMs).toBe(30_000);
  });

  it('credits run time only at run pace, across segment boundaries', () => {
    const tracker = new WorkoutTracker(workoutSession(1), 0);
    tracker.tick(5 * MIN, 8, 6); // warm-up done, nothing prescribed as running yet
    expect(tracker.progress(5 * MIN).performance).toBe(0);
    // One tick spans the whole first run segment and half the walk after it:
    // only the run minute counts, and it counts fully.
    tracker.tick(5 * MIN + 105_000, 8, 6);
    expect(tracker.progress(5 * MIN + 105_000).performance).toBeCloseTo(1 / 8, 5);
    // Walking through the next run segment earns nothing.
    tracker.tick(5 * MIN + 150_000, 2, 6);
    tracker.tick(5 * MIN + 210_000, 2, 6);
    expect(tracker.progress(5 * MIN + 210_000).performance).toBeCloseTo(1 / 8, 5);
  });

  it('stops the clock while paused, so hidden time neither finishes nor grades segments', () => {
    const tracker = new WorkoutTracker(workoutSession(1), 0);
    tracker.tick(1 * MIN, 8, 6);
    tracker.pause(1 * MIN);
    // Ticks while hidden change nothing, however long the page was gone.
    const during = tracker.tick(40 * MIN, 8, 6);
    expect(during.segment).toEqual({ kind: 'walk', durationMs: 5 * MIN });
    expect(during.segmentRemainingMs).toBe(4 * MIN);
    expect(during.performance).toBe(0);
    tracker.resume(41 * MIN);
    const after = tracker.tick(42 * MIN, 8, 6);
    // The hour away cost one visible minute of warm-up, nothing more.
    expect(after.segment).toEqual({ kind: 'walk', durationMs: 5 * MIN });
    expect(after.segmentRemainingMs).toBe(3 * MIN);
    expect(after.performance).toBe(0);
  });

  it('finishes with the performance the round earned', () => {
    const session = workoutSession(1);
    const total = session.segments.reduce((ms, s) => ms + s.durationMs, 0);
    const tracker = new WorkoutTracker(session, 0);
    // Run pace held the whole session: every prescribed run minute is earned.
    for (let at = 10_000; at <= total; at += 10_000) tracker.tick(at, 8, 6);
    const end = tracker.progress(total);
    expect(end.done).toBe(true);
    expect(end.segment).toBeNull();
    expect(end.performance).toBeCloseTo(1, 5);
  });
});
