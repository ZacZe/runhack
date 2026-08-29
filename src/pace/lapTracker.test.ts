import { describe, expect, it } from 'vitest';
import { LapTracker } from './lapTracker';

describe('LapTracker', () => {
  it('emits a lap once the distance threshold is crossed', () => {
    const tracker = new LapTracker(400);
    tracker.begin(0);
    expect(tracker.add(200, 1000)).toEqual([]);
    const laps = tracker.add(250, 121_000);
    expect(laps).toHaveLength(1);
    // The 400 m mark falls 200 m into a 250 m sample, so 96 s into its 120 s.
    expect(laps[0]).toMatchObject({ distanceM: 400, atMs: 97_000 });
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
    tracker.add(300, 108_000);
    tracker.setLapDistance(200);
    expect(tracker.add(0, 109_000)).toEqual([]);
    const laps = tracker.add(10, 110_000);
    expect(laps).toHaveLength(1);
    // The 200 m was run before this 10 m sample, so the lap is timed off the
    // interval that produced it — never as an instant 1 ms lap inside it — and
    // takes two thirds of it, the share its distance earned out of the 300 m.
    expect(laps[0]).toMatchObject({ distanceM: 200, durationMs: 72_667, atMs: 72_667 });
    expect(tracker.progress).toBe(110);

    // The remaining third stays with the partial lap: it does not restart from
    // the shrink and get credited as a sprint.
    const [next] = tracker.add(90, 140_000);
    expect(next?.durationMs).toBe(67_333);
  });

  it('spreads laps uncovered by a shorter lap distance over the run that made them', () => {
    const tracker = new LapTracker(1600);
    tracker.begin(0);
    tracker.add(900, 300_000); // 900 m in 5 min
    tracker.setLapDistance(100);
    const laps = tracker.add(50, 320_000);
    // Nine laps come due at once; each gets its share of the 300 s that produced
    // them rather than nine instant attacks.
    expect(laps).toHaveLength(9);
    for (const entry of laps) expect(entry.durationMs).toBeCloseTo(300_000 / 9, -1);
    expect(laps[8]).toMatchObject({ atMs: 300_000 });
    expect(tracker.progress).toBe(50);
  });

  it('times the first lap from the run start, not from the first sample', () => {
    const tracker = new LapTracker(100);
    tracker.begin(1000);
    const [first] = tracker.add(100, 41_000);
    expect(first?.durationMs).toBe(40_000);
  });

  it('splits one sample across every boundary it crosses', () => {
    const tracker = new LapTracker(100);
    tracker.begin(0);
    tracker.add(40, 20_000);
    // 160 m over the next 80 s crosses 100 m at t=50 s and 200 m at t=100 s;
    // neither lap may be priced as instant.
    const laps = tracker.add(160, 100_000);
    expect(laps).toHaveLength(2);
    expect(laps[0]).toMatchObject({ durationMs: 50_000, atMs: 50_000 });
    expect(laps[1]).toMatchObject({ durationMs: 50_000, atMs: 100_000 });
    expect(tracker.progress).toBe(0);
  });

  it('restarts the sample interval when a source is swapped mid-lap', () => {
    const tracker = new LapTracker(100);
    tracker.begin(0);
    tracker.add(50, 30_000);
    // The replacement measured its 100 m over 30 s, so its boundary falls at
    // t=105 s; billing it for the 60 s switching gap would place it at t=75 s.
    tracker.resumeSampling(90_000);
    const [lap] = tracker.add(100, 120_000);
    expect(lap).toMatchObject({ durationMs: 105_000, atMs: 105_000 });
    expect(tracker.progress).toBe(50);
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
