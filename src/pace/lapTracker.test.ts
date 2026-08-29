import { describe, expect, it } from 'vitest';
import { LapTracker } from './lapTracker';

describe('LapTracker', () => {
  it('emits a lap once the distance threshold is crossed', () => {
    const tracker = new LapTracker(400);
    tracker.begin(0);
    expect(tracker.add(200, 1000)).toEqual([]);
    const laps = tracker.add(250, 121_000);
    expect(laps).toHaveLength(1);
    expect(laps[0]).toMatchObject({ distanceM: 400, atMs: 121_000 });
    expect(tracker.progress).toBe(50);
  });

  it('times a lap from the previous lap, not from the run start', () => {
    const tracker = new LapTracker(100);
    tracker.begin(0);
    tracker.add(100, 10_000);
    const [second] = tracker.add(100, 25_000);
    expect(second?.durationMs).toBe(15_000);
  });

  it('emits several laps for one huge sample', () => {
    const tracker = new LapTracker(100);
    tracker.begin(0);
    expect(tracker.add(350, 5000)).toHaveLength(3);
    expect(tracker.progress).toBe(50);
  });

  it('ignores non-positive samples', () => {
    const tracker = new LapTracker(400);
    tracker.begin(0);
    expect(tracker.add(0, 1000)).toEqual([]);
    expect(tracker.add(-5, 2000)).toEqual([]);
    expect(tracker.progress).toBe(0);
  });

  it('changes lap length between levels without losing progress', () => {
    const tracker = new LapTracker(400);
    tracker.begin(0);
    tracker.add(300, 1000);
    tracker.setLapDistance(200);
    expect(tracker.add(0, 2000)).toEqual([]);
    expect(tracker.add(10, 3000)).toHaveLength(1);
  });

  it('times the first lap from the run start, not from the first sample', () => {
    const tracker = new LapTracker(100);
    tracker.begin(1000);
    const [first] = tracker.add(100, 41_000);
    expect(first?.durationMs).toBe(40_000);
  });

  it('spends an unbegun first sample on starting the clock', () => {
    const tracker = new LapTracker(100);
    // A large first GPS step covers an interval of unknown length, so it can't
    // be priced as if it happened at the sample timestamp.
    expect(tracker.add(120, 10_000)).toEqual([]);
    expect(tracker.progress).toBe(0);
    const [first] = tracker.add(100, 40_000);
    expect(first?.durationMs).toBe(30_000);
  });
});
