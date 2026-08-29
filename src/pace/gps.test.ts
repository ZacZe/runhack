import { describe, expect, it, vi } from 'vitest';
import { GpsPaceSource, gpsStepFilter, haversineM } from './gps';

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
    expect(filter(fix(51.500005, 5, 1000))).toEqual({ fromMs: 0, distanceM: 0, atMs: 1000 });
    expect(filter(fix(51.52, 5, 2000))).toBeNull();
  });

  it('opens the next interval where the last measured one ended', () => {
    const filter = gpsStepFilter();
    // Acquiring the anchor and dropping a teleport both consume time without
    // measuring it, so the following sample must not claim that time.
    filter(fix(51.5, 5, 30_000));
    expect(filter(fix(51.52, 5, 60_000))).toBeNull();
    expect(filter(fix(51.5202, 5, 61_000))).toMatchObject({ fromMs: 60_000, atMs: 61_000 });
    // An inaccurate fix leaves the anchor alone, so the step after it is
    // measured from — and covers — the interval that started at 61 s.
    expect(filter(fix(51.5203, 80, 62_000))).toBeNull();
    expect(filter(fix(51.5205, 5, 63_000))).toMatchObject({ fromMs: 61_000, atMs: 63_000 });
  });

  it('never turns creeping stationary drift into distance', () => {
    const filter = gpsStepFilter();
    filter(fix(51.5));
    // Drift that walks one way, ~1.1 m at a time: cumulatively over the
    // threshold, never over it in a single interval.
    for (let i = 1; i <= 10; i += 1) {
      expect(filter(fix(51.5 + i * 0.00001, 5, i * 1000))).toEqual({
        fromMs: (i - 1) * 1000,
        distanceM: 0,
        atMs: i * 1000,
      });
    }
  });
});

describe('GpsPaceSource', () => {
  const watching = (): {
    geolocation: Geolocation;
    emit: (accuracyM: number, lat?: number) => void;
  } => {
    let onPosition: PositionCallback | null = null;
    const geolocation = {
      watchPosition: (success: PositionCallback) => {
        onPosition = success;
        return 1;
      },
      clearWatch: () => {},
    } as unknown as Geolocation;
    return {
      geolocation,
      emit: (accuracyM: number, lat = 51.5) =>
        onPosition?.({
          coords: { latitude: lat, longitude: 0, accuracy: accuracyM } as GeolocationCoordinates,
          timestamp: Date.now(),
        } as GeolocationPosition),
    };
  };

  it('gives up on a watch that only returns fixes it cannot measure with', () => {
    vi.useFakeTimers();
    try {
      const { geolocation, emit } = watching();
      vi.stubGlobal('navigator', { geolocation });
      const errors: string[] = [];
      const source = new GpsPaceSource();
      source.start(() => {}, (message) => errors.push(message));

      // Fixes keep arriving, all far too coarse for the filter, so the runner
      // would stand in a frozen game with no error to explain it.
      for (let i = 0; i < 30; i += 1) {
        vi.advanceTimersByTime(1000);
        emit(120);
      }
      expect(errors).toHaveLength(1);

      source.stop();
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it('keeps measuring while accurate fixes arrive, even from a runner standing still', () => {
    vi.useFakeTimers();
    try {
      const { geolocation, emit } = watching();
      vi.stubGlobal('navigator', { geolocation });
      const errors: string[] = [];
      const source = new GpsPaceSource();
      source.start(() => {}, (message) => errors.push(message));

      for (let i = 0; i < 60; i += 1) {
        vi.advanceTimersByTime(1000);
        emit(5);
      }
      expect(errors).toEqual([]);

      source.stop();
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it('gives up on accurate fixes that keep teleporting', () => {
    vi.useFakeTimers();
    try {
      const { geolocation, emit } = watching();
      vi.stubGlobal('navigator', { geolocation });
      const errors: string[] = [];
      const samples: unknown[] = [];
      const source = new GpsPaceSource();
      source.start((sample) => samples.push(sample), (message) => errors.push(message));

      // Every fix is accurate and every step is a kilometre-wide jump, so the
      // filter measures nothing: arriving is not the same as measuring.
      for (let i = 0; i < 30; i += 1) {
        vi.advanceTimersByTime(1000);
        emit(5, 51.5 + i * 0.05);
      }
      expect(samples).toEqual([]);
      expect(errors).toHaveLength(1);

      source.stop();
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });
});
