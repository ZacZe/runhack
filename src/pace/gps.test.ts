import { describe, expect, it } from 'vitest';
import { gpsStepFilter, haversineM } from './gps';

describe('haversineM', () => {
  it('measures short distances', () => {
    const a = { lat: 51.5007, lon: -0.1246 };
    const b = { lat: 51.5017, lon: -0.1246 };
    expect(haversineM(a, b)).toBeCloseTo(111, 0);
  });

  it('is zero for the same point', () => {
    expect(haversineM({ lat: 1, lon: 2 }, { lat: 1, lon: 2 })).toBe(0);
  });
});

describe('gpsStepFilter', () => {
  const fix = (lat: number, accuracyM = 5, atMs = 0) => ({ lat, lon: 0, accuracyM, atMs });

  it('needs two fixes before reporting distance', () => {
    const filter = gpsStepFilter();
    expect(filter(fix(51.5))).toBeNull();
    expect(filter(fix(51.5005, 5, 1000))).toMatchObject({ atMs: 1000 });
  });

  it('drops inaccurate fixes entirely', () => {
    const filter = gpsStepFilter();
    filter(fix(51.5));
    expect(filter(fix(51.5005, 80, 1000))).toBeNull();
    expect(filter(fix(51.5005, 5, 2000))).toMatchObject({ distanceM: expect.any(Number) });
  });

  it('reports stationary jitter as no distance, and drops teleports', () => {
    const filter = gpsStepFilter();
    filter(fix(51.5));
    expect(filter(fix(51.500005, 5, 1000))).toEqual({ distanceM: 0, atMs: 1000 });
    expect(filter(fix(51.52, 5, 2000))).toBeNull();
  });

  it('never turns creeping stationary drift into distance', () => {
    const filter = gpsStepFilter();
    filter(fix(51.5));
    // Drift that walks one way, ~1.1 m at a time: cumulatively over the
    // threshold, never over it in a single interval.
    for (let i = 1; i <= 10; i += 1) {
      expect(filter(fix(51.5 + i * 0.00001, 5, i * 1000))).toEqual({
        distanceM: 0,
        atMs: i * 1000,
      });
    }
  });
});
