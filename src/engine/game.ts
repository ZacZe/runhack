import { ACHIEVEMENTS, LEVELS, SPELLS, WEAPONS, spellById, weaponById } from './content';
import { BALANCE, formatPace, paceSecPerKm, resolveAttack, updateBaseline } from './damage';
import type {
  Attack,
  Enemy,
  Lap,
  Level,
  RunStats,
  Spell,
  SprintChallenge,
  Weapon,
} from './types';

export type GameStatus = 'idle' | 'running' | 'victory' | 'defeat';

/** Things the renderer needs to animate, as they happen. */
export type GameEvent =
  | { type: 'attack'; damage: number; spellName: string | null; weakness: boolean; crit: boolean }
  | { type: 'enemyHit'; damage: number }
  | { type: 'enemyDefeated' }
  | { type: 'sprintCalled'; distanceM: number; targetPaceSecPerKm: number }
  | { type: 'sprintMissed' }
  | { type: 'achievement'; name: string; unlockedSpellName: string | null }
  | { type: 'rewardClaimed'; damageMultiplier: number; heal: number }
  | { type: 'levelStart'; levelName: string }
  | { type: 'victory' }
  | { type: 'defeat' };

export interface LogEntry {
  atMs: number;
  kind: 'attack' | 'enemy' | 'system' | 'achievement';
  text: string;
}

export interface GameOptions {
  /** Seed pace in seconds per kilometre, used until real laps are recorded. */
  baselinePace?: number;
  playerMaxHp?: number;
  /** Overrides every level's lap distance, so a runner can pick their loop. */
  lapDistanceM?: number | null;
}

export interface Snapshot {
  status: GameStatus;
  level: Level;
  enemy: Enemy;
  enemyHp: number;
  playerHp: number;
  playerMaxHp: number;
  energy: number;
  baselinePace: number;
  streakMs: number;
  weapon: Weapon;
  armedSpell: Spell | null;
  unlockedSpells: string[];
  achievements: string[];
  /** The sprint the game is asking for right now, if any. */
  sprint: SprintChallenge | null;
  /** Unclaimed achievement rewards waiting for a tap. */
  unclaimedRewards: number;
  /** Milliseconds left on a claimed reward's damage boost. */
  surgeMsLeft: number;
  stats: RunStats;
  lapProgressM: number;
  /** True while the runner is actually covering ground. */
  moving: boolean;
  log: LogEntry[];
}

const DEFAULT_BASELINE_PACE = 360;

/**
 * All game state lives here and is driven by two inputs only: completed laps
 * and the passage of time. Whatever measures the running (GPS, treadmill
 * simulator, a test) just calls `completeLap` and `tick`.
 */
export class GameSession {
  private status: GameStatus = 'idle';
  private levelIndex = 0;
  private enemyIndex = 0;
  private enemyHp: number;
  private playerHp: number;
  private readonly playerMaxHp: number;
  private energy = 0;
  private baselinePace: number;
  private streakMs = 0;
  private weapon: Weapon = WEAPONS[0]!;
  private armedSpell: Spell | null = null;
  private unlockedSpells = new Set(SPELLS.filter((s) => !s.unlockedBy).map((s) => s.id));
  private achievements = new Set<string>();
  private stats: RunStats = {
    laps: 0,
    totalDistanceM: 0,
    longestStreakMs: 0,
    bestPaceRatio: Infinity,
    enemiesDefeated: 0,
  };
  private lapProgressM = 0;
  private moving = false;
  private sprint: SprintChallenge | null = null;
  private sprintLive = false;
  private lapsSinceSprint = 0;
  private unclaimedRewards = 0;
  private surgeUntilMs: number | null = null;
  private lapDistanceOverrideM: number | null;
  private levelCache: { index: number; overrideM: number | null; level: Level } | null = null;
  private log: LogEntry[] = [];
  private lastTickMs: number | null = null;
  private lastMovedAtMs: number | null = null;
  private nextEnemyAttackAtMs: number | null = null;
  private listeners: Array<(snapshot: Snapshot) => void> = [];
  private eventListeners: Array<(event: GameEvent) => void> = [];

  constructor(options: GameOptions = {}) {
    this.baselinePace = options.baselinePace ?? DEFAULT_BASELINE_PACE;
    this.playerMaxHp = options.playerMaxHp ?? 100;
    this.playerHp = this.playerMaxHp;
    this.lapDistanceOverrideM = options.lapDistanceM ?? null;
    this.enemyHp = this.currentEnemy().maxHp;
  }

  subscribe(listener: (snapshot: Snapshot) => void): () => void {
    this.listeners.push(listener);
    listener(this.snapshot());
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  /** Fires for each in-game moment worth animating. */
  onEvent(listener: (event: GameEvent) => void): () => void {
    this.eventListeners.push(listener);
    return () => {
      this.eventListeners = this.eventListeners.filter((l) => l !== listener);
    };
  }

  start(nowMs: number): void {
    if (this.status !== 'idle') return;
    this.status = 'running';
    this.lastTickMs = nowMs;
    this.lastMovedAtMs = nowMs;
    this.nextEnemyAttackAtMs = nowMs + this.currentEnemy().attackIntervalMs;
    this.lapsSinceSprint = 0;
    this.push(nowMs, 'system', `${this.currentLevel().name}: ${this.currentEnemy().name} appears.`);
    this.fire({ type: 'levelStart', levelName: this.currentLevel().name });
    this.emit();
  }

  selectWeapon(id: string): void {
    this.weapon = weaponById(id);
    this.push(this.lastTickMs ?? 0, 'system', `Equipped ${this.weapon.name}.`);
    this.emit();
  }

  /** Arms a spell for the next completed lap. Returns false when it can't be cast. */
  armSpell(id: string): boolean {
    const spell = spellById(id);
    if (!this.unlockedSpells.has(spell.id)) {
      this.push(this.lastTickMs ?? 0, 'system', `${spell.name} is still locked.`);
      this.emit();
      return false;
    }
    if (this.energy < spell.cost) {
      this.push(
        this.lastTickMs ?? 0,
        'system',
        `Not enough energy for ${spell.name} (${Math.floor(this.energy)}/${spell.cost}).`,
      );
      this.emit();
      return false;
    }
    this.energy -= spell.cost;
    this.armedSpell = spell;
    this.push(this.lastTickMs ?? 0, 'system', `${spell.name} armed — land your next lap.`);
    this.emit();
    return true;
  }

  /**
   * Sets the lap distance for every level, or `null` to use each level's own.
   * Short laps make a treadmill session or a small block playable; long ones
   * suit a track. Takes effect from the next lap.
   */
  setLapDistance(distanceM: number | null): void {
    this.lapDistanceOverrideM = distanceM;
    this.levelCache = null;
    // A sprint advertises the distance it will be judged over, so a new lap
    // length retires the call rather than settling it over a stretch the runner
    // was never asked to run.
    if (this.sprint !== null && this.sprint.distanceM !== this.currentLevel().lapDistanceM) {
      this.sprint = null;
      this.lapsSinceSprint = 0;
      this.push(this.lastTickMs ?? 0, 'system', 'Sprint call is off — the lap changed length.');
    }
    this.push(
      this.lastTickMs ?? 0,
      'system',
      distanceM === null
        ? 'Lap distance follows the level again.'
        : `Lap distance set to ${distanceM} m.`,
    );
    this.emit();
  }

  /** Progress towards the next lap, reported by the active pace source. */
  reportProgress(distanceM: number): void {
    if (this.status !== 'running') return;
    this.lapProgressM = distanceM;
    this.emit();
  }

  /**
   * Advances the clock. `movingDistanceM` is the distance covered since the
   * previous tick; the streak breaks once the grace window has passed since the
   * last movement, and enemy attacks land on their own timer.
   */
  tick(nowMs: number, movedM: number): void {
    if (this.status !== 'running') return;
    const previous = this.lastTickMs ?? nowMs;
    const elapsed = Math.max(0, nowMs - previous);
    this.lastTickMs = nowMs;

    // Measured from the last movement, not from the last tick: heartbeats are a
    // second apart (and can be throttled), so no single interval spans the
    // grace window.
    const stationaryMs = nowMs - (this.lastMovedAtMs ?? nowMs);
    const expired = stationaryMs >= BALANCE.streakBreakMs;
    if (expired) this.streakMs = 0;

    this.moving = movedM > 0;
    if (movedM > 0) {
      // A stretch that outlived the grace window restarts here rather than
      // absorbing the pause it just came out of.
      this.streakMs += expired ? 0 : elapsed;
      this.lastMovedAtMs = nowMs;
      this.stats.longestStreakMs = Math.max(this.stats.longestStreakMs, this.streakMs);
    }

    // A sprint called partway through a batch of laps is not live until the next
    // heartbeat: laps still in that batch were already run, so one of them
    // answering the call would settle it before the runner ever heard it.
    if (this.sprint !== null) this.sprintLive = true;

    if (this.surgeUntilMs !== null && nowMs >= this.surgeUntilMs) {
      this.surgeUntilMs = null;
      this.push(nowMs, 'system', 'The surge fades.');
    }

    while (this.nextEnemyAttackAtMs !== null && nowMs >= this.nextEnemyAttackAtMs) {
      const enemy = this.currentEnemy();
      this.playerHp = Math.max(0, this.playerHp - enemy.attackDamage);
      this.push(nowMs, 'enemy', `${enemy.taunt} (-${enemy.attackDamage} HP)`);
      this.nextEnemyAttackAtMs += enemy.attackIntervalMs;
      this.fire({ type: 'enemyHit', damage: enemy.attackDamage });
      if (this.playerHp === 0) {
        this.status = 'defeat';
        this.nextEnemyAttackAtMs = null;
        this.sprint = null;
        this.push(nowMs, 'system', 'You slow to a walk. The run is over.');
        this.fire({ type: 'defeat' });
        break;
      }
    }
    this.emit();
  }

  /** One lap = one attack. */
  completeLap(lap: Lap): Attack | null {
    if (this.status !== 'running') return null;
    const enemy = this.currentEnemy();
    const pace = paceSecPerKm(lap);
    const called = this.sprintLive ? this.sprint : null;
    // The sprint is answered by the lap that ends it, whether or not it was fast
    // enough, so a called sprint never carries over into the next lap.
    const crit = called !== null && pace <= called.targetPaceSecPerKm;
    if (called !== null) this.sprint = null;
    const attack = resolveAttack({
      lap,
      weapon: this.weapon,
      spell: this.armedSpell,
      enemy,
      baselinePace: this.baselinePace,
      streakMs: this.streakMs,
      crit,
      // The lap is priced at the time it ended, so a heartbeat throttled past the
      // surge's life cannot keep paying out after it should have faded.
      surge: this.surgeUntilMs !== null && lap.atMs < this.surgeUntilMs,
    });

    this.stats.laps += 1;
    this.stats.totalDistanceM += lap.distanceM;
    this.stats.bestPaceRatio = Math.min(this.stats.bestPaceRatio, pace / this.baselinePace);
    this.baselinePace = updateBaseline(this.baselinePace, pace);
    this.energy = Math.min(BALANCE.maxEnergy, this.energy + BALANCE.energyPerLap);
    this.armedSpell = null;
    this.lapProgressM = 0;
    this.enemyHp = Math.max(0, this.enemyHp - attack.damage);

    const spellText = attack.spell ? `${attack.spell.name} + ` : '';
    const weaknessText = attack.exploitedWeakness ? ' Weakness!' : '';
    const critText = attack.crit ? ' CRITICAL!' : '';
    this.push(
      lap.atMs,
      'attack',
      `${spellText}${attack.weapon.name} hits ${enemy.name} for ${attack.damage}.${critText}${weaknessText}`,
    );
    this.fire({
      type: 'attack',
      damage: attack.damage,
      spellName: attack.spell?.name ?? null,
      weakness: attack.exploitedWeakness,
      crit: attack.crit,
    });
    if (called !== null && !crit) {
      this.push(lap.atMs, 'system', 'Sprint missed — no critical this time.');
      this.fire({ type: 'sprintMissed' });
    }

    if (this.enemyHp === 0) {
      this.stats.enemiesDefeated += 1;
      this.push(lap.atMs, 'system', `${enemy.name} falls.`);
      this.fire({ type: 'enemyDefeated' });
      this.advance(lap.atMs);
    }
    this.awardAchievements(lap.atMs);
    this.callSprintIfDue(lap.atMs, called !== null);
    this.emit();
    return attack;
  }

  snapshot(): Snapshot {
    return {
      status: this.status,
      level: this.currentLevel(),
      enemy: this.currentEnemy(),
      enemyHp: this.enemyHp,
      playerHp: this.playerHp,
      playerMaxHp: this.playerMaxHp,
      energy: this.energy,
      baselinePace: this.baselinePace,
      streakMs: this.streakMs,
      weapon: this.weapon,
      armedSpell: this.armedSpell,
      unlockedSpells: [...this.unlockedSpells],
      achievements: [...this.achievements],
      sprint: this.sprint,
      unclaimedRewards: this.unclaimedRewards,
      surgeMsLeft:
        this.surgeUntilMs === null ? 0 : Math.max(0, this.surgeUntilMs - (this.lastTickMs ?? 0)),
      stats: { ...this.stats },
      lapProgressM: this.lapProgressM,
      moving: this.moving,
      log: [...this.log],
    };
  }

  currentLevel(): Level {
    const index = Math.min(this.levelIndex, LEVELS.length - 1);
    const override = this.lapDistanceOverrideM;
    // Cached so subscribers can compare levels by identity across snapshots.
    if (this.levelCache?.index === index && this.levelCache.overrideM === override) {
      return this.levelCache.level;
    }
    const base = LEVELS[index]!;
    const level = override === null ? base : { ...base, lapDistanceM: override };
    this.levelCache = { index, overrideM: override, level };
    return level;
  }

  currentEnemy(): Enemy {
    const enemies = this.currentLevel().enemies;
    return enemies[Math.min(this.enemyIndex, enemies.length - 1)]!;
  }

  /**
   * Spends one achievement reward: a burst of damage for the next stretch of the
   * run, and some HP back. Returns false when there is nothing to claim.
   */
  claimReward(nowMs: number): boolean {
    if (this.status !== 'running' || this.unclaimedRewards === 0) return false;
    this.unclaimedRewards -= 1;
    // Claiming again while a surge runs extends it rather than stacking, so a
    // saved-up pile of rewards cannot end a level in one lap.
    this.surgeUntilMs = Math.max(this.surgeUntilMs ?? 0, nowMs) + BALANCE.surgeDurationMs;
    this.playerHp = Math.min(this.playerMaxHp, this.playerHp + BALANCE.surgeHeal);
    this.push(
      nowMs,
      'system',
      `Reward claimed: x${BALANCE.surgeMultiplier} damage for ${Math.round(
        BALANCE.surgeDurationMs / 1000,
      )}s, +${BALANCE.surgeHeal} HP.`,
    );
    this.fire({
      type: 'rewardClaimed',
      damageMultiplier: BALANCE.surgeMultiplier,
      heal: BALANCE.surgeHeal,
    });
    this.emit();
    return true;
  }

  /**
   * The game picks the sprints, so the runner is never grinding a time trial:
   * one is called only after a quiet stretch of laps, and the target is drawn
   * from their own baseline so it is a push rather than a fitness gate.
   */
  private callSprintIfDue(atMs: number, answeredOne: boolean): void {
    if (this.status !== 'running') return;
    this.lapsSinceSprint = answeredOne ? 0 : this.lapsSinceSprint + 1;
    if (this.lapsSinceSprint < BALANCE.sprintCooldownLaps) return;
    this.lapsSinceSprint = 0;
    const sprint: SprintChallenge = {
      distanceM: this.currentLevel().lapDistanceM,
      targetPaceSecPerKm: this.baselinePace * BALANCE.sprintPaceRatio,
    };
    this.sprint = sprint;
    this.sprintLive = false;
    this.push(
      atMs,
      'system',
      `SPRINT: next ${Math.round(sprint.distanceM)} m under ${formatPace(
        sprint.targetPaceSecPerKm,
      )}/km for a critical hit.`,
    );
    this.fire({ type: 'sprintCalled', ...sprint });
  }

  private advance(atMs: number): void {
    const enemies = this.currentLevel().enemies;
    if (this.enemyIndex + 1 < enemies.length) {
      this.enemyIndex += 1;
    } else if (this.levelIndex + 1 < LEVELS.length) {
      this.levelIndex += 1;
      this.enemyIndex = 0;
      this.push(atMs, 'system', `Level cleared. Entering ${this.currentLevel().name}.`);
      this.fire({ type: 'levelStart', levelName: this.currentLevel().name });
    } else {
      this.status = 'victory';
      this.nextEnemyAttackAtMs = null;
      this.sprint = null;
      this.push(atMs, 'system', 'Chronarch shatters. You win the run.');
      this.fire({ type: 'victory' });
      return;
    }
    this.enemyHp = this.currentEnemy().maxHp;
    this.nextEnemyAttackAtMs = atMs + this.currentEnemy().attackIntervalMs;
    this.push(atMs, 'system', `${this.currentEnemy().name} appears.`);
  }

  private awardAchievements(atMs: number): void {
    for (const achievement of ACHIEVEMENTS) {
      if (this.achievements.has(achievement.id) || !achievement.test(this.stats)) continue;
      this.achievements.add(achievement.id);
      this.unclaimedRewards += 1;
      const unlocked = achievement.unlocksSpell;
      const unlockedSpellName = unlocked ? spellById(unlocked).name : null;
      if (unlocked) this.unlockedSpells.add(unlocked);
      this.push(
        atMs,
        'achievement',
        unlockedSpellName
          ? `${achievement.name} unlocked ${unlockedSpellName}.`
          : `Achievement: ${achievement.name}.`,
      );
      this.fire({ type: 'achievement', name: achievement.name, unlockedSpellName });
    }
  }

  private push(atMs: number, kind: LogEntry['kind'], text: string): void {
    this.log = [...this.log.slice(-49), { atMs, kind, text }];
  }

  private emit(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }

  private fire(event: GameEvent): void {
    for (const listener of this.eventListeners) listener(event);
  }
}
