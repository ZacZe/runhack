import { speak } from './speech';

/** Every moment the announcer has words for. */
export type AnnouncementKind =
  | 'monsterApproaches'
  | 'enemyHit'
  | 'enemyCrit'
  | 'holdingPace'
  | 'fallingBack'
  | 'stopped'
  | 'playerAttack'
  | 'playerCrit'
  | 'enemyDown'
  | 'sprintCalled'
  | 'sprintMissed'
  | 'tooSlow'
  | 'rewardClaimed'
  | 'victory'
  | 'defeat';

/**
 * The announcer's script. `{name}` is filled with the enemy's name where the
 * line mentions one; lines without it simply ignore the substitution.
 */
export const ANNOUNCEMENTS: Record<AnnouncementKind, readonly string[]> = {
  monsterApproaches: [
    'A {name} approaches. Start running!',
    '{name} ahead. Get moving!',
    'Here comes a {name}. On your feet!',
    'A wild {name} blocks the road. Run it down!',
  ],
  enemyHit: [
    'You took a hit. Pick up the pace!',
    'It caught you. Push harder!',
    'That one landed. Speed up!',
  ],
  enemyCrit: [
    'Critical hit against you! Move, now!',
    'Standing still is getting you killed. Run!',
    'A crushing blow! Get running!',
  ],
  holdingPace: [
    'Great pace. Keep it rolling!',
    "You're flying. Stay on it!",
    'Strong running. It cannot touch you!',
    'Looking good. Hold that stride!',
  ],
  fallingBack: [
    "You're falling back. Careful!",
    "Losing ground. It's closing in!",
    'Pace is slipping. Watch out!',
  ],
  stopped: [
    "You've stopped. It will crit you!",
    'Standing still is dangerous. Move!',
    "Don't stop now. It's right behind you!",
  ],
  playerAttack: [
    'Clean hit!',
    'That one landed!',
    'Strike!',
  ],
  playerCrit: [
    'Critical hit!',
    'Devastating blow!',
    'Massive damage!',
  ],
  enemyDown: [
    'Enemy down!',
    'You got it!',
    'Another one bites the dust!',
  ],
  sprintCalled: [
    'Sprint! Go go go!',
    'Sprint time. Empty the tank!',
    'All out, now! Sprint!',
  ],
  sprintMissed: [
    'Sprint missed. Next one soon.',
    'Not this time. Catch the next call.',
    "The sprint got away. You'll get the next one.",
  ],
  tooSlow: [
    'Too slow to strike. Hold the pace!',
    'The blow glanced off. Faster!',
    'No damage at that pace. Push!',
  ],
  rewardClaimed: [
    'Surge! Hit harder!',
    'Power up! Make it count!',
    'Reward claimed. Unleash it!',
  ],
  victory: [
    'Victory! What a run!',
    'You win! Legendary!',
    'The road is clear. You did it!',
  ],
  defeat: [
    'Defeated. Rest up and run again.',
    "It got you this time. You'll be back.",
    'Down, but not done. Try again!',
  ],
};

/** How long the running commentary (pace praise and warnings) stays quiet between lines. */
export const COMMENTARY_QUIET_MS = 15_000;

/** Which kinds are commentary rather than moments: spoken at most once per quiet window. */
const COMMENTARY: ReadonlySet<AnnouncementKind> = new Set([
  'holdingPace',
  'fallingBack',
  'stopped',
]);

/**
 * Picks lines for the game's moments, never repeating a kind's last line, and
 * keeping the running commentary sparse enough not to talk over the moments.
 */
export class Announcer {
  private lastIndex = new Map<AnnouncementKind, number>();
  private lastCommentaryAtMs: number | null = null;

  constructor(private readonly random: () => number = Math.random) {}

  /** The line to speak, or `null` when commentary is still in its quiet window. */
  line(kind: AnnouncementKind, nowMs: number, name = ''): string | null {
    if (COMMENTARY.has(kind)) {
      if (
        this.lastCommentaryAtMs !== null &&
        nowMs - this.lastCommentaryAtMs < COMMENTARY_QUIET_MS
      ) {
        return null;
      }
      this.lastCommentaryAtMs = nowMs;
    }
    const lines = ANNOUNCEMENTS[kind];
    const previous = this.lastIndex.get(kind);
    let index = Math.min(lines.length - 1, Math.floor(this.random() * lines.length));
    if (index === previous) index = (index + 1) % lines.length;
    this.lastIndex.set(kind, index);
    return lines[index]!.replaceAll('{name}', name);
  }

  say(kind: AnnouncementKind, nowMs: number, name = ''): void {
    const line = this.line(kind, nowMs, name);
    if (line !== null) speak(line);
  }
}
