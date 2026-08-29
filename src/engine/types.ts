export type Element = 'fire' | 'ice' | 'arcane' | 'physical';

export interface Weapon {
  id: string;
  name: string;
  /** Damage of one lap run exactly at the runner's baseline pace. */
  baseDamage: number;
  /**
   * How hard damage reacts to pace. Applied as an exponent on
   * (baselinePace / lapPace), so 0.5 is forgiving and 2 is sprint-or-nothing.
   */
  paceScaling: number;
  element: Element;
  /** Extra words the voice parser accepts for this weapon. */
  aliases: string[];
}

export interface Spell {
  id: string;
  name: string;
  /** Energy spent to arm the spell. */
  cost: number;
  /** Multiplier applied to the next landed lap. */
  multiplier: number;
  element: Element;
  aliases: string[];
  /** Achievement that must be earned before the spell can be cast. */
  unlockedBy?: string;
}

export interface Enemy {
  id: string;
  name: string;
  maxHp: number;
  /** Elements this enemy takes extra damage from. */
  weakTo: Element[];
  /** Milliseconds between enemy attacks while the run is active. */
  attackIntervalMs: number;
  attackDamage: number;
  taunt: string;
}

export interface Level {
  id: string;
  name: string;
  /** Metres of running that count as one lap (one attack) on this level. */
  lapDistanceM: number;
  enemies: Enemy[];
}

export interface Achievement {
  id: string;
  name: string;
  description: string;
  /** Spell unlocked by earning this achievement. */
  unlocksSpell?: string;
  test: (stats: RunStats) => boolean;
}

export interface RunStats {
  laps: number;
  totalDistanceM: number;
  /** Longest unbroken stretch of movement, in milliseconds. */
  longestStreakMs: number;
  /** Best (lowest) ratio of lap pace to baseline pace; < 1 means faster than baseline. */
  bestPaceRatio: number;
  enemiesDefeated: number;
}

/**
 * A stretch the game asks the runner to sprint. Set by the game rather than
 * chosen, and worth a critical hit: the lap that ends it crits if it came in at
 * or under `targetPaceSecPerKm`.
 */
export interface SprintChallenge {
  distanceM: number;
  targetPaceSecPerKm: number;
}

/** One completed lap, as measured by whichever pace source is active. */
export interface Lap {
  distanceM: number;
  durationMs: number;
  /** Wall-clock time the lap completed. */
  atMs: number;
}

export interface Attack {
  lap: Lap;
  weapon: Weapon;
  spell: Spell | null;
  paceSecPerKm: number;
  paceMultiplier: number;
  streakMultiplier: number;
  spellMultiplier: number;
  /** True when the armed spell's element matched an enemy weakness. */
  exploitedWeakness: boolean;
  /** True when the lap answered a sprint challenge. */
  crit: boolean;
  critMultiplier: number;
  /** Multiplier from a claimed achievement reward, 1 when none is running. */
  surgeMultiplier: number;
  damage: number;
}
