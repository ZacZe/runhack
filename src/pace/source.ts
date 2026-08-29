/**
 * A sample of movement over a measured interval. `distanceM` covers exactly
 * `fromMs`..`atMs`; a source that consumed time without measuring it (GPS
 * acquiring its first anchor, a fix rejected as a teleport) opens the next
 * sample later than the previous one ended, and that gap is nobody's movement.
 */
export interface PaceSample {
  fromMs: number;
  distanceM: number;
  atMs: number;
}

export interface PaceSource {
  readonly id: 'gps' | 'sim';
  start(onSample: (sample: PaceSample) => void, onError: (message: string) => void): void;
  stop(): void;
}
