import type { Attack, Element, Enemy, Lap, Spell, Weapon } from './types';

export const BALANCE = {
  /** Pace multiplier is clamped so slow runners can still win and sprinters can't trivialise a level. */
  minPaceMultiplier: 0.5,
  maxPaceMultiplier: 2.5,
  /** Streak bonus per continuous minute of movement, and its ceiling. */
  streakBonusPerMinute: 0.02,
  maxStreakBonus: 0.5,
  /** Damage multiplier when a spell's element matches an enemy weakness. */
  weaknessMultiplier: 1.5,
  /** Energy granted per completed lap. */
  energyPerLap: 25,
  maxEnergy: 100,
  /** A stretch of movement ends after this long without progress. */
  streakBreakMs: 30_000,
  /**
   * How long the runner keeps being animated after the last measured movement.
   * GPS fixes are sparser than the heartbeat, so a runner in full flight has
   * ticks with no distance in them; only a real stop outlasts this.
   */
  movingGraceMs: 6_000,
  /** Damage multiplier for a lap that answers a sprint challenge. */
  critMultiplier: 2,
  /**
   * Laps between sprint challenges. A crit is meant to be an event, so the game
   * asks for one rarely rather than turning every lap into a time trial.
   */
  sprintCooldownLaps: 3,
  /** Sprint target, as a fraction of the runner's own baseline pace. */
  sprintPaceRatio: 0.85,
  /** Claimed achievement reward: damage multiplier, its life, and the HP it gives back. */
  surgeMultiplier: 1.5,
  surgeDurationMs: 45_000,
  surgeHeal: 15,
} as const;

export function paceSecPerKm(lap: Lap): number {
  if (lap.distanceM <= 0) return Infinity;
  return lap.durationMs / 1000 / (lap.distanceM / 1000);
}

/**
 * Damage reacts to pace relative to the runner's own baseline, not an absolute
 * speed, so the difficulty curve is personal rather than a fitness gate.
 */
export function paceMultiplier(lapPace: number, baselinePace: number, scaling: number): number {
  if (!Number.isFinite(lapPace) || lapPace <= 0 || baselinePace <= 0) {
    return BALANCE.minPaceMultiplier;
  }
  const raw = (baselinePace / lapPace) ** scaling;
  return clamp(raw, BALANCE.minPaceMultiplier, BALANCE.maxPaceMultiplier);
}

export function streakMultiplier(streakMs: number): number {
  const minutes = Math.max(0, streakMs) / 60_000;
  return 1 + Math.min(BALANCE.maxStreakBonus, minutes * BALANCE.streakBonusPerMinute);
}

/** Rolling baseline over completed laps, weighted towards recent effort. */
export function updateBaseline(baselinePace: number, lapPace: number, weight = 0.25): number {
  if (!Number.isFinite(lapPace) || lapPace <= 0) return baselinePace;
  return baselinePace * (1 - weight) + lapPace * weight;
}

export function isWeakness(element: Element, enemy: Enemy): boolean {
  return enemy.weakTo.includes(element);
}

export function resolveAttack(args: {
  lap: Lap;
  weapon: Weapon;
  spell: Spell | null;
  enemy: Enemy;
  baselinePace: number;
  streakMs: number;
  crit?: boolean;
  surge?: boolean;
}): Attack {
  const { lap, weapon, spell, enemy, baselinePace, streakMs, crit = false, surge = false } = args;
  const pace = paceSecPerKm(lap);
  const paceMult = paceMultiplier(pace, baselinePace, weapon.paceScaling);
  const streakMult = streakMultiplier(streakMs);
  const element = spell?.element ?? weapon.element;
  const exploitedWeakness = isWeakness(element, enemy);
  const spellMult =
    (spell?.multiplier ?? 1) * (exploitedWeakness ? BALANCE.weaknessMultiplier : 1);

  return {
    lap,
    weapon,
    spell,
    paceSecPerKm: pace,
    paceMultiplier: paceMult,
    streakMultiplier: streakMult,
    spellMultiplier: spellMult,
    exploitedWeakness,
    crit,
    critMultiplier: crit ? BALANCE.critMultiplier : 1,
    surgeMultiplier: surge ? BALANCE.surgeMultiplier : 1,
    damage: Math.max(
      1,
      Math.round(
        weapon.baseDamage *
          paceMult *
          streakMult *
          spellMult *
          (crit ? BALANCE.critMultiplier : 1) *
          (surge ? BALANCE.surgeMultiplier : 1),
      ),
    ),
  };
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function formatPace(secPerKm: number): string {
  if (!Number.isFinite(secPerKm) || secPerKm <= 0) return '--:--';
  const minutes = Math.floor(secPerKm / 60);
  const seconds = Math.round(secPerKm % 60);
  const carry = seconds === 60;
  return `${carry ? minutes + 1 : minutes}:${String(carry ? 0 : seconds).padStart(2, '0')}`;
}
