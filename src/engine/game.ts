import { ACHIEVEMENTS, LEVELS, SPELLS, WEAPONS, spellById, weaponById } from './content';
import { BALANCE, paceSecPerKm, resolveAttack, updateBaseline } from './damage';
import type { Attack, Enemy, Lap, Level, RunStats, Spell, Weapon } from './types';

export type GameStatus = 'idle' | 'running' | 'victory' | 'defeat';

/** Things the renderer needs to animate, as they happen. */
export type GameEvent =
  | { type: 'attack'; damage: number; spellName: string | null; weakness: boolean }
  | { type: 'enemyHit'; damage: number }
  | { type: 'enemyDefeated' }
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
  private log: LogEntry[] = [];
  private lastTickMs: number | null = null;
  private nextEnemyAttackAtMs: number | null = null;
  private listeners: Array<(snapshot: Snapshot) => void> = [];
  private eventListeners: Array<(event: GameEvent) => void> = [];

  constructor(options: GameOptions = {}) {
    this.baselinePace = options.baselinePace ?? DEFAULT_BASELINE_PACE;
    this.playerMaxHp = options.playerMaxHp ?? 100;
    this.playerHp = this.playerMaxHp;
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
    this.nextEnemyAttackAtMs = nowMs + this.currentEnemy().attackIntervalMs;
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

  /** Progress towards the next lap, reported by the active pace source. */
  reportProgress(distanceM: number): void {
    if (this.status !== 'running') return;
    this.lapProgressM = distanceM;
    this.emit();
  }

  /**
   * Advances the clock. `movingDistanceM` is the distance covered since the
   * previous tick; zero-distance ticks break the streak once the grace window
   * elapses, and enemy attacks land on their own timer.
   */
  tick(nowMs: number, movedM: number): void {
    if (this.status !== 'running') return;
    const previous = this.lastTickMs ?? nowMs;
    const elapsed = Math.max(0, nowMs - previous);
    this.lastTickMs = nowMs;

    this.moving = movedM > 0;
    if (movedM > 0) {
      this.streakMs += elapsed;
      this.stats.longestStreakMs = Math.max(this.stats.longestStreakMs, this.streakMs);
    } else if (elapsed >= BALANCE.streakBreakMs) {
      this.streakMs = 0;
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
    const attack = resolveAttack({
      lap,
      weapon: this.weapon,
      spell: this.armedSpell,
      enemy,
      baselinePace: this.baselinePace,
      streakMs: this.streakMs,
    });

    const pace = paceSecPerKm(lap);
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
    this.push(
      lap.atMs,
      'attack',
      `${spellText}${attack.weapon.name} hits ${enemy.name} for ${attack.damage}.${weaknessText}`,
    );
    this.fire({
      type: 'attack',
      damage: attack.damage,
      spellName: attack.spell?.name ?? null,
      weakness: attack.exploitedWeakness,
    });

    if (this.enemyHp === 0) {
      this.stats.enemiesDefeated += 1;
      this.push(lap.atMs, 'system', `${enemy.name} falls.`);
      this.fire({ type: 'enemyDefeated' });
      this.advance(lap.atMs);
    }
    this.awardAchievements(lap.atMs);
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
      stats: { ...this.stats },
      lapProgressM: this.lapProgressM,
      moving: this.moving,
      log: [...this.log],
    };
  }

  currentLevel(): Level {
    return LEVELS[Math.min(this.levelIndex, LEVELS.length - 1)]!;
  }

  currentEnemy(): Enemy {
    const enemies = this.currentLevel().enemies;
    return enemies[Math.min(this.enemyIndex, enemies.length - 1)]!;
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
      const unlocked = achievement.unlocksSpell;
      if (unlocked) this.unlockedSpells.add(unlocked);
      this.push(
        atMs,
        'achievement',
        unlocked
          ? `${achievement.name} unlocked ${spellById(unlocked).name}.`
          : `Achievement: ${achievement.name}.`,
      );
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
