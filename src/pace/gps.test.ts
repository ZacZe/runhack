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

  it('ignores stationary jitter and teleports', () => {
    const filter = gpsStepFilter();
    filter(fix(51.5));
    expect(filter(fix(51.500005, 5, 1000))).toBeNull();
    expect(filter(fix(51.52, 5, 2000))).toBeNull();
  });
});
