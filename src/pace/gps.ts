import type { PaceSample, PaceSource } from './source';

/** Fixes worse than this are dropped: urban GPS jitter otherwise fakes laps. */
const MAX_ACCURACY_M = 25;
/** Below this, movement is indistinguishable from a stationary fix wandering. */
const MIN_STEP_M = 2;
/** Above this between fixes is a teleport, not a stride. */
const MAX_STEP_M = 120;

export function haversineM(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const R = 6_371_000;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Filters a raw fix stream into usable per-sample distances. */
export function gpsStepFilter(): (fix: {
  lat: number;
  lon: number;
  accuracyM: number;
  atMs: number;
}) => PaceSample | null {
  let last: { lat: number; lon: number } | null = null;
  return (fix) => {
    if (fix.accuracyM > MAX_ACCURACY_M) return null;
    const previous = last;
    last = { lat: fix.lat, lon: fix.lon };
    if (!previous) return null;
    const step = haversineM(previous, fix);
    if (step < MIN_STEP_M || step > MAX_STEP_M) return null;
    return { distanceM: step, atMs: fix.atMs };
  };
}

export class GpsPaceSource implements PaceSource {
  readonly id = 'gps' as const;
  private watchId: number | null = null;

  start(onSample: (sample: PaceSample) => void, onError: (message: string) => void): void {
    if (!('geolocation' in navigator)) {
      onError('This device has no geolocation — use treadmill mode.');
      return;
    }
    const filter = gpsStepFilter();
    this.watchId = navigator.geolocation.watchPosition(
      (position) => {
        const sample = filter({
          lat: position.coords.latitude,
          lon: position.coords.longitude,
          accuracyM: position.coords.accuracy,
          atMs: position.timestamp,
        });
        if (sample) onSample(sample);
      },
      (error) => onError(`GPS error: ${error.message}`),
      { enableHighAccuracy: true, maximumAge: 0, timeout: 15_000 },
    );
  }

  stop(): void {
    if (this.watchId !== null) navigator.geolocation.clearWatch(this.watchId);
    this.watchId = null;
  }
}

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}
