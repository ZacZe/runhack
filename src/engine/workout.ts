/**
 * Structured run workouts.
 *
 * The session ladder is the Couch to 5K interval progression (Josh Clark,
 * 1996, as published in the NHS "Couch to 5K" programme, weeks 1 to 9): a
 * five-minute brisk-walk warm-up, then alternating timed run and
 * recovery-walk segments, building to a continuous thirty-minute run. Walk/run
 * interval training of exactly this shape is what trials on novice runners
 * test (e.g. Kluitenberg et al. 2015, "The NLstart2run study"), and its
 * gradual build is why level one is finishable by someone starting cold.
 *
 * Difficulty between rounds follows the runner's measured performance rather
 * than the calendar: repeating a week that was not comfortably completed is
 * the programme's own advice, and holding a struggling runner back keeps the
 * round-to-round load increase inside the ~10% weekly progression guideline
 * used in overuse-injury guidance (ACSM; Nielsen et al. 2014 on training-load
 * progression and injury risk).
 */

export interface WorkoutSegment {
  kind: 'run' | 'walk';
  durationMs: number;
}

export interface WorkoutSession {
  level: number;
  /** How the session reads on the setup screen, e.g. "8 × (run 1:00 / walk 1:30)". */
  name: string;
  segments: WorkoutSegment[];
  totalRunMs: number;
}

const MIN = 60_000;

const run = (ms: number): WorkoutSegment => ({ kind: 'run', durationMs: ms });
const walk = (ms: number): WorkoutSegment => ({ kind: 'walk', durationMs: ms });

/** Every session opens with the programme's five-minute brisk-walk warm-up. */
const WARM_UP_MS = 5 * MIN;

const repeat = (times: number, ...pattern: WorkoutSegment[]): WorkoutSegment[] =>
  Array.from({ length: times }, () => pattern).flat();

/** The nine C25K weeks, one level each. */
const LADDER: { name: string; segments: WorkoutSegment[] }[] = [
  { name: '8 × (run 1:00 / walk 1:30)', segments: repeat(8, run(1 * MIN), walk(1.5 * MIN)) },
  { name: '6 × (run 1:30 / walk 2:00)', segments: repeat(6, run(1.5 * MIN), walk(2 * MIN)) },
  {
    name: '2 × (run 1:30, walk 1:30, run 3:00, walk 3:00)',
    segments: repeat(2, run(1.5 * MIN), walk(1.5 * MIN), run(3 * MIN), walk(3 * MIN)),
  },
  {
    name: 'run 3:00, walk 1:30, run 5:00, walk 2:30, run 3:00, walk 1:30, run 5:00',
    segments: [
      run(3 * MIN),
      walk(1.5 * MIN),
      run(5 * MIN),
      walk(2.5 * MIN),
      run(3 * MIN),
      walk(1.5 * MIN),
      run(5 * MIN),
    ],
  },
  {
    name: '3 × (run 5:00 / walk 3:00)',
    segments: [run(5 * MIN), walk(3 * MIN), run(5 * MIN), walk(3 * MIN), run(5 * MIN)],
  },
  {
    name: 'run 5:00, walk 3:00, run 8:00, walk 3:00, run 5:00',
    segments: [run(5 * MIN), walk(3 * MIN), run(8 * MIN), walk(3 * MIN), run(5 * MIN)],
  },
  { name: 'run 25:00', segments: [run(25 * MIN)] },
  { name: 'run 28:00', segments: [run(28 * MIN)] },
  { name: 'run 30:00', segments: [run(30 * MIN)] },
];

export const WORKOUT_LEVELS = LADDER.length;

export function workoutSession(level: number): WorkoutSession {
  const clamped = Math.min(WORKOUT_LEVELS, Math.max(1, Math.floor(level)));
  const week = LADDER[clamped - 1]!;
  const segments = [walk(WARM_UP_MS), ...week.segments];
  return {
    level: clamped,
    name: week.name,
    segments,
    totalRunMs: segments.reduce((ms, s) => (s.kind === 'run' ? ms + s.durationMs : ms), 0),
  };
}

/**
 * Where the next round starts, judged on this round's performance — the share
 * of prescribed running time actually held at run pace. Comfortable (≥ 85%)
 * moves up a level; shaky repeats the level, the programme's own advice; a
 * struggle (< 55%) steps one back so the next round is winnable.
 */
export function nextWorkoutLevel(level: number, performance: number): number {
  if (performance >= 0.85) return Math.min(WORKOUT_LEVELS, level + 1);
  if (performance >= 0.55) return level;
  return Math.max(1, level - 1);
}

export interface WorkoutProgress {
  /** Null once the session is over. */
  segment: WorkoutSegment | null;
  segmentIndex: number;
  segmentRemainingMs: number;
  done: boolean;
  /** Share of prescribed run time held at run pace so far, 0..1. */
  performance: number;
}

/**
 * Walks a session on the wall clock, crediting run-segment time only while the
 * measured speed holds the run threshold.
 */
export class WorkoutTracker {
  private readonly session: WorkoutSession;
  private index = 0;
  private segmentStartMs: number;
  private lastTickMs: number;
  private compliantRunMs = 0;
  private pausedAtMs: number | null = null;

  constructor(session: WorkoutSession, nowMs: number) {
    this.session = session;
    this.segmentStartMs = nowMs;
    this.lastTickMs = nowMs;
  }

  /**
   * A page the OS suspended saw nobody run: the session clock stops with it,
   * so hidden time can neither finish segments unseen nor grade them off one
   * stale speed reading.
   */
  pause(nowMs: number): void {
    if (this.pausedAtMs === null) this.pausedAtMs = nowMs;
  }

  resume(nowMs: number): void {
    if (this.pausedAtMs === null) return;
    const gap = Math.max(0, nowMs - this.pausedAtMs);
    this.segmentStartMs += gap;
    this.lastTickMs += gap;
    this.pausedAtMs = null;
  }

  tick(nowMs: number, speedKmh: number, runThresholdKmh: number): WorkoutProgress {
    if (this.pausedAtMs !== null) return this.progress(this.pausedAtMs);
    let elapsed = Math.max(0, nowMs - this.lastTickMs);
    this.lastTickMs = nowMs;
    while (this.index < this.session.segments.length && elapsed > 0) {
      const segment = this.session.segments[this.index]!;
      const spentInSegment = nowMs - elapsed - this.segmentStartMs;
      const room = segment.durationMs - spentInSegment;
      const spend = Math.min(room, elapsed);
      if (segment.kind === 'run' && speedKmh >= runThresholdKmh) {
        this.compliantRunMs += spend;
      }
      elapsed -= spend;
      if (spend >= room) {
        this.index += 1;
        this.segmentStartMs = nowMs - elapsed;
      }
    }
    return this.progress(nowMs);
  }

  progress(nowMs: number): WorkoutProgress {
    const at = this.pausedAtMs ?? nowMs;
    const done = this.index >= this.session.segments.length;
    const segment = done ? null : this.session.segments[this.index]!;
    return {
      segment,
      segmentIndex: this.index,
      segmentRemainingMs: segment
        ? Math.max(0, segment.durationMs - (at - this.segmentStartMs))
        : 0,
      done,
      performance:
        this.session.totalRunMs === 0 ? 1 : this.compliantRunMs / this.session.totalRunMs,
    };
  }
}
