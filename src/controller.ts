import { GameSession } from './engine/game';
import { LapTracker } from './pace/lapTracker';
import type { PaceSample, PaceSource } from './pace/source';

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
  /** How far the source has actually measured; silence past it says nothing. */
  private measuredToMs: number | null = null;
  /** The sprint call the lap in progress answers, if any. */
  private sprintCallId: number | null = null;
  private running = false;

  constructor(
    readonly session: GameSession,
    private source: PaceSource,
    private readonly onError: (message: string) => void,
  ) {
    this.tracker = new LapTracker(session.activeLapDistanceM());
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const now = Date.now();
    this.session.start(now);
    this.tracker.begin(now);
    this.measuredToMs = now;
    this.source.start((sample) => this.handleSample(sample), this.onError);
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
    const now = Date.now();
    // Movement the old source measured ends at the swap. Leaving the batch open
    // would let one window span both sources, and a pause spent switching would
    // vanish between the last sample of one and the first of the other.
    if (this.movedLastAtMs !== null) this.flush(this.movedLastAtMs);
    // The replacement measures from its own start, so the lap keeps its distance
    // while the sample clock restarts: no interval spans the switching gap.
    this.measuredToMs = now;
    this.tracker.resumeSampling(now);
    // The swap is a measured boundary, so the session hears about it here rather
    // than at the next heartbeat: a lap the replacement completes first would
    // otherwise be paid at the streak the runner had before the pause.
    this.flush(now);
    this.source.start((sample) => this.handleSample(sample), this.onError);
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
    this.session.tick(nowMs, this.movedSinceTickM, movement, this.measuredToMs ?? nowMs);
    this.movedSinceTickM = 0;
    this.movedFirstAtMs = null;
    this.movedLastAtMs = null;
  }

  private handleSample({ fromMs, distanceM, atMs }: PaceSample): void {
    // A sample's distance belongs to the interval it was measured over, so that
    // interval's *start* is when this movement began. Dating it at `atMs`
    // instead would turn every sparse fix into a runner who just set off after
    // standing still for the whole interval.
    //
    // A sample that opens later than the last one closed leaves an interval the
    // source never measured (GPS reacquiring, a fix dropped as a teleport).
    // Closing the batch there keeps that hole out of the movement window, which
    // would otherwise span it and pay for it. The lap clock skips the hole for
    // the same reason: interpolating across it would let a boundary land in time
    // the runner was never measured over, pricing the lap as a sprint.
    if (this.measuredToMs !== null && fromMs > this.measuredToMs) {
      if (this.movedLastAtMs !== null) this.flush(this.movedLastAtMs);
      this.tracker.resumeSampling(fromMs);
    }
    this.measuredToMs = atMs;
    if (distanceM > 0) {
      this.movedFirstAtMs ??= fromMs;
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
    this.tracker.setLapDistance(this.session.activeLapDistanceM());
    for (const lap of this.tracker.add(distanceM, atMs)) {
      this.session.completeLap(lap);
      this.tracker.setLapDistance(this.session.activeLapDistanceM());
    }
    this.session.reportProgress(this.tracker.progress);
    // A sprint called by one of those laps becomes answerable at this boundary,
    // and it asks for its distance from here. The rest of this sample was run
    // against the ordinary lap, before the call went out, so the sprint starts
    // from an empty lap instead of being handed that head start. The call is
    // identified rather than merely counted as present: a retired call replaced
    // within one sample is a different sprint, and it starts fresh too.
    const callId = this.session.sprintCallId();
    if (callId !== this.sprintCallId) {
      this.sprintCallId = callId;
      if (callId !== null) {
        // Those metres were run, so the run's distance keeps them even though
        // no lap will ever bank them.
        this.session.creditDistance(this.tracker.progress);
        this.tracker.restartLap(atMs);
        this.tracker.setLapDistance(this.session.activeLapDistanceM());
        this.session.reportProgress(this.tracker.progress);
      }
    }
  }
}
