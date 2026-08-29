/** A sample of movement since the previous sample. */
export interface PaceSample {
  distanceM: number;
  atMs: number;
}

export interface PaceSource {
  readonly id: 'gps' | 'sim';
  start(onSample: (sample: PaceSample) => void, onError: (message: string) => void): void;
  stop(): void;
}
