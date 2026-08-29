import { GameSession } from './engine/game';
import { LapTracker } from './pace/lapTracker';
import type { PaceSource } from './pace/source';

const TICK_MS = 1000;

/**
 * Wires a pace source into the game: samples become lap progress, laps become
 * attacks, and a heartbeat keeps enemy timers and the streak honest even when
 * the runner has stopped and no samples arrive.
 */
export class RunController {
  private readonly tracker: LapTracker;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private movedSinceTickM = 0;

  constructor(
    readonly session: GameSession,
    private source: PaceSource,
    private readonly onError: (message: string) => void,
  ) {
    this.tracker = new LapTracker(session.currentLevel().lapDistanceM);
  }

  start(): void {
    this.session.start(Date.now());
    this.source.start((sample) => this.handleSample(sample.distanceM, sample.atMs), this.onError);
    this.heartbeat = setInterval(() => {
      this.session.tick(Date.now(), this.movedSinceTickM);
      this.movedSinceTickM = 0;
    }, TICK_MS);
  }

  stop(): void {
    this.source.stop();
    if (this.heartbeat !== null) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  /** Swaps GPS for the treadmill simulator (or back) mid-run. */
  swapSource(source: PaceSource): void {
    this.source.stop();
    this.source = source;
    this.source.start((sample) => this.handleSample(sample.distanceM, sample.atMs), this.onError);
  }

  private handleSample(distanceM: number, atMs: number): void {
    this.movedSinceTickM += distanceM;
    // Picked up per sample, so a level change or a runner-chosen distance takes
    // effect on the lap in progress.
    this.tracker.setLapDistance(this.session.currentLevel().lapDistanceM);
    for (const lap of this.tracker.add(distanceM, atMs)) {
      this.session.completeLap(lap);
      this.tracker.setLapDistance(this.session.currentLevel().lapDistanceM);
    }
    this.session.reportProgress(this.tracker.progress);
  }
}
