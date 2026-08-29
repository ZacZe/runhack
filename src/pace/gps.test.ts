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

  it('ignores stationary jitter and teleports', () => {
    const filter = gpsStepFilter();
    filter(fix(51.5));
    expect(filter(fix(51.500005, 5, 1000))).toBeNull();
    expect(filter(fix(51.52, 5, 2000))).toBeNull();
  });
});

describe('GpsPaceSource', () => {
  const watching = (): {
    geolocation: Geolocation;
    emit: (accuracyM: number) => void;
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
      emit: (accuracyM: number) =>
        onPosition?.({
          coords: { latitude: 51.5, longitude: 0, accuracy: accuracyM } as GeolocationCoordinates,
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
});
