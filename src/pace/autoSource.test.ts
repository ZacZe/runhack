import { describe, expect, it, vi } from 'vitest';

import { probeGps } from './autoSource';

type Success = Parameters<Geolocation['getCurrentPosition']>[0];
type Failure = NonNullable<Parameters<Geolocation['getCurrentPosition']>[1]>;

const fixAt = (accuracyM: number): Geolocation =>
  ({
    getCurrentPosition: (onSuccess: Success) =>
      onSuccess({
        coords: { accuracy: accuracyM } as GeolocationCoordinates,
        timestamp: 0,
      } as GeolocationPosition),
  }) as unknown as Geolocation;

const failsWith = (code: number): Geolocation =>
  ({
    getCurrentPosition: (_onSuccess: Success, onError: Failure) =>
      onError({
        code,
        message: 'nope',
        PERMISSION_DENIED: 1,
        POSITION_UNAVAILABLE: 2,
        TIMEOUT: 3,
      } as GeolocationPositionError),
  }) as unknown as Geolocation;

describe('probeGps', () => {
  it('accepts a fix accurate enough to measure laps with', async () => {
    await expect(probeGps(fixAt(8))).resolves.toEqual({ usable: true, accuracyM: 8 });
  });

  it('rejects a fix too coarse to tell running from drift', async () => {
    const probe = await probeGps(fixAt(120));
    expect(probe.usable).toBe(false);
  });

  it('reports why permission failures fall back', async () => {
    await expect(probeGps(failsWith(1))).resolves.toEqual({
      usable: false,
      reason: 'Location permission denied',
    });
    await expect(probeGps(failsWith(2))).resolves.toEqual({
      usable: false,
      reason: 'No GPS signal here',
    });
  });

  it('falls back when there is no geolocation at all', async () => {
    const probe = await probeGps(undefined);
    expect(probe.usable).toBe(false);
  });

  it('gives up on a prompt that is never answered', async () => {
    vi.useFakeTimers();
    try {
      const silent = { getCurrentPosition: () => {} } as unknown as Geolocation;
      const pending = probeGps(silent, 5_000);
      vi.advanceTimersByTime(5_000);
      await expect(pending).resolves.toEqual({ usable: false, reason: 'No GPS fix yet' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the first answer when a fix and the timeout race', async () => {
    vi.useFakeTimers();
    try {
      const pending = probeGps(fixAt(6), 5_000);
      vi.advanceTimersByTime(5_000);
      await expect(pending).resolves.toEqual({ usable: true, accuracyM: 6 });
    } finally {
      vi.useRealTimers();
    }
  });
});
