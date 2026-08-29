import { afterEach, describe, expect, it, vi } from 'vitest';
import { SimPaceSource } from './sim';
import type { PaceSample } from './source';

describe('SimPaceSource', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('pays each sample for the interval it actually covered', () => {
    vi.useFakeTimers();
    const samples: PaceSample[] = [];
    // 36 km/h is 10 m/s, so the arithmetic is readable.
    const source = new SimPaceSource(36);
    source.start((sample) => samples.push(sample));

    vi.advanceTimersByTime(1000);
    expect(samples).toHaveLength(1);
    expect(samples[0]!.distanceM).toBeCloseTo(10, 3);

    // A backgrounded tab throttles the timer: the clock moves without the
    // callback firing, so the next interval spans far more than one tick.
    vi.setSystemTime(Date.now() + 5000);
    vi.advanceTimersByTime(1000);
    expect(samples).toHaveLength(2);
    const throttled = samples[1]!;
    expect(throttled.atMs - throttled.fromMs).toBe(6000);
    expect(throttled.distanceM).toBeCloseTo(60, 3);

    source.stop();
  });

  it('reports no distance while the dial is at zero', () => {
    vi.useFakeTimers();
    const samples: PaceSample[] = [];
    const source = new SimPaceSource(0);
    source.start((sample) => samples.push(sample));
    vi.advanceTimersByTime(3000);
    expect(samples).toHaveLength(3);
    expect(samples.every((sample) => sample.distanceM === 0)).toBe(true);
    source.stop();
  });
});
