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
  private movedFirstAtMs: number | null = null;
  private movedLastAtMs: number | null = null;
  private running = false;

  constructor(
    readonly session: GameSession,
    private source: PaceSource,
    private readonly onError: (message: string) => void,
  ) {
    this.tracker = new LapTracker(session.currentLevel().lapDistanceM);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const now = Date.now();
    this.session.start(now);
    this.tracker.begin(now);
    this.source.start((sample) => this.handleSample(sample.distanceM, sample.atMs), this.onError);
    this.heartbeat = setInterval(() => this.flush(Date.now()), TICK_MS);
  }

  stop(): void {
    this.running = false;
    this.source.stop();
    if (this.heartbeat !== null) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  /**
   * Swaps GPS for the treadmill simulator (or back). Before the run starts the
   * replacement is only armed: sampling then would spend distance on a lap the
   * session hasn't begun, and `start` would open a second GPS watch.
   */
  swapSource(source: PaceSource): void {
    this.source.stop();
    this.source = source;
    if (!this.running) return;
    // The replacement measures from its own start, so the lap keeps its distance
    // but the sample clock restarts and the switching gap is charged to nobody.
    this.tracker.resumeSampling(Date.now());
    this.source.start((sample) => this.handleSample(sample.distanceM, sample.atMs), this.onError);
  }

  /**
   * Hands the distance gathered since the last tick to the session, along with
   * when it was covered: a throttled heartbeat can span far more than TICK_MS,
   * and only the sample times say whether the runner kept going.
   */
  private flush(nowMs: number): void {
    const movement =
      this.movedFirstAtMs !== null && this.movedLastAtMs !== null
        ? { firstAtMs: this.movedFirstAtMs, lastAtMs: this.movedLastAtMs }
        : undefined;
    this.session.tick(nowMs, this.movedSinceTickM, movement);
    this.movedSinceTickM = 0;
    this.movedFirstAtMs = null;
    this.movedLastAtMs = null;
  }

  private handleSample(distanceM: number, atMs: number): void {
    if (distanceM > 0) {
      this.movedFirstAtMs ??= atMs;
      this.movedLastAtMs = atMs;
    } else if (this.movedLastAtMs !== null) {
      // A sample covers the interval since the one before it, so silence between
      // two positive samples says nothing: the runner may simply have been
      // measured sparsely. Zero distance is different — it is measured
      // stillness, and it ends the movement here so a throttled heartbeat can't
      // reduce the batch to a window spanning the stop. Flushing at the last
      // movement keeps the session's clock behind the next sample's interval,
      // where laps are still to be interpolated.
      this.flush(this.movedLastAtMs);
    }
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
