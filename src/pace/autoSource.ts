/**
 * Picking the pace source is not the runner's job: they are outdoors with a
 * phone in an armband, or indoors at a desk, and the device already knows
 * which. A probe fix decides where to start, and the treadmill dial is the
 * answer to "no usable fix" rather than a mode the runner has to find.
 *
 * A usable probe is only permission to try GPS, never proof it will work: a
 * phone sitting indoors can hold a flawless fix and still measure nothing. The
 * threshold is the filter's own, so the probe cannot bless a fix the running
 * source would throw away.
 */
import { MAX_ACCURACY_M } from './gps';

const PROBE_TIMEOUT_MS = 8_000;

export type GpsProbe =
  | { usable: true; accuracyM: number }
  | { usable: false; reason: string };

export function probeGps(
  geolocation: Geolocation | undefined,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<GpsProbe> {
  if (!geolocation) {
    return Promise.resolve({
      usable: false,
      reason: 'This device has no GPS',
    });
  }
  return new Promise((resolve) => {
    let settled = false;
    const settle = (probe: GpsProbe): void => {
      if (settled) return;
      settled = true;
      resolve(probe);
    };
    geolocation.getCurrentPosition(
      (position) => {
        const accuracyM = position.coords.accuracy;
        settle(
          accuracyM <= MAX_ACCURACY_M
            ? { usable: true, accuracyM }
            : {
                usable: false,
                reason: `GPS is only accurate to ${Math.round(accuracyM)} m here`,
              },
        );
      },
      (error) => settle({ usable: false, reason: probeErrorReason(error) }),
      { enableHighAccuracy: true, maximumAge: 0, timeout: timeoutMs },
    );
    // `timeout` covers the fix, not the permission prompt: an unanswered prompt
    // leaves the callback pending forever, and the runner is left staring at a
    // game that will not start.
    setTimeout(() => settle({ usable: false, reason: 'No GPS fix yet' }), timeoutMs);
  });
}

function probeErrorReason(error: GeolocationPositionError): string {
  if (error.code === error.PERMISSION_DENIED) return 'Location permission denied';
  if (error.code === error.POSITION_UNAVAILABLE) return 'No GPS signal here';
  return 'GPS timed out';
}
