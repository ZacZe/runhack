import type { PaceSample, PaceSource } from './source';

/** Fixes worse than this are dropped: urban GPS jitter otherwise fakes laps. */
export const MAX_ACCURACY_M = 25;
/**
 * A watch that has gone this long without a fix worth measuring has stopped
 * being a pace source, whether it fell silent or is only returning fixes the
 * filter throws away. Either way the run would freeze in place without saying
 * so, so it is reported as an error and the dial takes over.
 */
const STALL_MS = 20_000;
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
  private stall: ReturnType<typeof setTimeout> | null = null;

  start(onSample: (sample: PaceSample) => void, onError: (message: string) => void): void {
    if (!('geolocation' in navigator)) {
      onError('This device has no geolocation — use treadmill mode.');
      return;
    }
    const filter = gpsStepFilter();
    const armStall = (): void => {
      if (this.stall !== null) clearTimeout(this.stall);
      this.stall = setTimeout(
        () => onError('GPS is not accurate enough here'),
        STALL_MS,
      );
    };
    armStall();
    this.watchId = navigator.geolocation.watchPosition(
      (position) => {
        // Accuracy, not distance: a runner standing still is being measured
        // perfectly well, while a stream of coarse fixes measures nothing.
        if (position.coords.accuracy <= MAX_ACCURACY_M) armStall();
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
    if (this.stall !== null) clearTimeout(this.stall);
    this.stall = null;
  }
}

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}
