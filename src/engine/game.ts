import { ACHIEVEMENTS, LEVELS, SPELLS, WEAPONS, spellById, weaponById } from './content';
import { BALANCE, formatPace, paceSecPerKm, resolveAttack, updateBaseline } from './damage';
import type {
  AchievementProgress,
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
  | { type: 'attackTooSlow'; speedKmh: number }
  | { type: 'enemyHit'; damage: number; crit: boolean }
  | { type: 'enemyMissed' }
  | { type: 'enemyDefeated' }
  | { type: 'sprintCalled'; distanceM: number; targetPaceSecPerKm: number }
  | { type: 'sprintMissed' }
  | { type: 'achievement'; name: string; unlockedSpellName: string | null }
  | { type: 'rewardClaimed'; damageMultiplier: number; heal: number }
  | { type: 'levelStart'; levelName: string }
  | { type: 'victory' }
  | { type: 'defeat' };

/**
 * When the distance reported to a tick was covered. A tick only carries a total,
 * which cannot tell continuous running under a throttled timer apart from
 * running resumed after a pause.
 */
export interface MovementWindow {
  firstAtMs: number;
  lastAtMs: number;
}

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
  /** Distance a called sprint is run over, or `null` to use the lap distance. */
  sprintDistanceM?: number | null;
  speedThresholdKmh?: number | null;
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
  /** Metres the lap in progress is being run over: the attack lands here. */
  lapDistanceM: number;
  /** Unearned achievement closest to being earned, `null` when all are earned. */
  nextAchievement: AchievementProgress | null;
  /** True while the runner is actually covering ground. */
  moving: boolean;
  /** Speed the source last measured, in km/h. */
  speedKmh: number;
  /** Hold this speed and the enemy can't reach you. */
  speedThresholdKmh: number;
  /** Run a lap at this speed and its attack lands as a critical. */
  sprintSpeedKmh: number;
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
    attacksLanded: 0,
    totalDistanceM: 0,
    longestStreakMs: 0,
    bestPaceRatio: Infinity,
    enemiesDefeated: 0,
  };
  private lapProgressM = 0;
  private moving = false;
  private sprint: SprintChallenge | null = null;
  private sprintLive = false;
  /** Identifies the standing call, so a replacement is never mistaken for it. */
  private sprintCalls = 0;
  private lapsSinceSprint = 0;
  private unclaimedRewards = 0;
  /**
   * The window a claimed reward covers. Kept after it lapses so a lap delivered
   * late is still priced by when it was run rather than by when it arrived.
   */
  private surge: { fromMs: number; untilMs: number } | null = null;
  private surgeFaded = false;
  private lapDistanceOverrideM: number | null;
  private sprintDistanceM: number | null;
  private levelCache: { index: number; overrideM: number | null; level: Level } | null = null;
  private log: LogEntry[] = [];
  private lastTickMs: number | null = null;
  private lastMovedAtMs: number | null = null;
  /** When movement was last measured, for animating between sparse fixes. */
  private lastMovementAtMs: number | null = null;
  /** Speed of the last measured movement, which the enemy hunts by. */
  private speedKmh = 0;
  /** When the runner last held the threshold, so a blow just after still misses. */
  private lastAtThresholdAtMs: number | null = null;
  private speedThresholdKmh: number;
  private nextEnemyAttackAtMs: number | null = null;
  private listeners: Array<(snapshot: Snapshot) => void> = [];
  private eventListeners: Array<(event: GameEvent) => void> = [];

  constructor(options: GameOptions = {}) {
    this.baselinePace = options.baselinePace ?? DEFAULT_BASELINE_PACE;
    this.playerMaxHp = options.playerMaxHp ?? 100;
    this.playerHp = this.playerMaxHp;
    this.lapDistanceOverrideM = positiveOrNull(options.lapDistanceM);
    this.sprintDistanceM = positiveOrNull(options.sprintDistanceM);
    this.speedThresholdKmh = positiveOrNull(options.speedThresholdKmh) ?? BALANCE.slowSpeedKmh;
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
    this.lapDistanceOverrideM = positiveOrNull(distanceM);
    this.levelCache = null;
    this.retireMismatchedSprint();
    this.push(
      this.lastTickMs ?? 0,
      'system',
      this.lapDistanceOverrideM === null
        ? 'Lap distance follows the level again.'
        : `Lap distance set to ${this.lapDistanceOverrideM} m.`,
    );
    this.emit();
  }

  /**
   * Sets the speed, in km/h, that keeps the runner out of the enemy's reach.
   * Hold it and its blows miss; drop under it and they land. `null` restores the
   * default, since a threshold of nothing would make the enemy harmless.
   */
  setSpeedThreshold(speedKmh: number | null): void {
    const next = positiveOrNull(speedKmh) ?? BALANCE.slowSpeedKmh;
    // Grace earned against the old threshold still holds when the bar stays or
    // drops — a speed that met the old bar meets the new one too. A raised bar
    // has to be reached before it protects anyone.
    if (next > this.speedThresholdKmh) this.lastAtThresholdAtMs = null;
    this.speedThresholdKmh = next;
    this.push(
      this.lastTickMs ?? 0,
      'system',
      `Hold ${this.speedThresholdKmh} km/h to stay out of reach.`,
    );
    this.emit();
  }

  /**
   * Sets the distance a called sprint is run over, or `null` to sprint the
   * ordinary lap. A shorter sprint than the lap is the point of the setting: an
   * all-out 200 m is a different ask from an all-out 800 m.
   */
  setSprintDistance(distanceM: number | null): void {
    this.sprintDistanceM = positiveOrNull(distanceM);
    this.retireMismatchedSprint();
    this.push(
      this.lastTickMs ?? 0,
      'system',
      this.sprintDistanceM === null
        ? 'Sprints are run over the lap distance.'
        : `Sprint distance set to ${this.sprintDistanceM} m.`,
    );
    this.emit();
  }

  /**
   * The lap in progress, which is the sprint distance while a sprint stands and
   * the ordinary lap distance otherwise. The attack lands when this much ground
   * has been covered, so it is what the pace source and the progress bar follow.
   */
  activeLapDistanceM(): number {
    if (this.sprintingNow()) return this.sprint!.distanceM;
    return this.currentLevel().lapDistanceM;
  }

  /**
   * True once a sprint call is the lap in progress. A call made partway through
   * a source's batch of laps only takes hold at the next sample boundary, since
   * the ground the batch covered was run before the call went out.
   */
  sprintingNow(): boolean {
    return this.sprint !== null && this.sprintLive;
  }

  /** Which call is being run, or `null` when the lap is an ordinary one. */
  sprintCallId(): number | null {
    return this.sprintingNow() ? this.sprintCalls : null;
  }

  /**
   * Credits ground the runner covered that no lap will ever bank — the stretch
   * run before a sprint call, which the sprint does not count. It was still run,
   * so the distance the run reports has to include it.
   */
  creditDistance(distanceM: number): void {
    if (this.status !== 'running' || distanceM <= 0) return;
    this.stats.totalDistanceM += distanceM;
    this.awardAchievements(this.lastTickMs ?? 0);
    this.emit();
  }

  /**
   * Progress towards the next lap, reported by the active pace source once per
   * sample. That is also the boundary a sprint call becomes answerable at: laps
   * the same sample completed were already run, so none of them can answer a
   * call made partway through the batch.
   */
  reportProgress(distanceM: number): void {
    if (this.status !== 'running') return;
    if (this.sprint !== null) this.sprintLive = true;
    this.lapProgressM = distanceM;
    this.emit();
  }

  /**
   * Advances the clock. `movedM` is the distance covered since the previous
   * tick, and `movement` when that distance came in: the streak breaks once the
   * grace window has passed since the last movement, and enemy attacks land on
   * their own timer.
   *
   * @param measuredToMs How far the source has measured. Silence past it is
   * unknown rather than still, so it defaults to `nowMs` for callers that only
   * have a clock.
   * @param speedKmh The speed of the *last* interval the source measured. A tick
   * can batch a fast stretch and a slow one, and the enemy hunts by how fast the
   * runner is going now rather than by the batch's average. Callers that only
   * have a total leave it out and the batch is averaged instead.
   */
  tick(
    nowMs: number,
    movedM: number,
    movement?: MovementWindow,
    measuredToMs: number = nowMs,
    speedKmh?: number | null,
  ): void {
    if (this.status !== 'running') return;
    const previous = this.lastTickMs ?? nowMs;
    const elapsed = Math.max(0, nowMs - previous);
    this.lastTickMs = nowMs;

    // A tick can cover a long interval when timers are throttled, so the streak
    // is judged on when the runner moved rather than on tick boundaries: the gap
    // runs up to the first movement of this tick, and the run continues from the
    // last one.
    const moved = movedM > 0 ? (movement ?? { firstAtMs: nowMs, lastAtMs: nowMs }) : null;
    if (moved !== null) this.lastMovementAtMs = moved.lastAtMs;
    const lastMovedAtMs = this.lastMovedAtMs;
    // A stop has to have been measured to count: a source that has gone quiet
    // leaves a gap nobody observed, and calling that a pause breaks the streak
    // of a runner whose fixes are merely sparse.
    const expired =
      lastMovedAtMs !== null &&
      (moved?.firstAtMs ?? measuredToMs) - lastMovedAtMs >= BALANCE.streakBreakMs;
    if (expired) this.streakMs = 0;

    // GPS fixes are sparser than the heartbeat and a stride under two metres is
    // indistinguishable from jitter, so "no distance this tick" is not standing
    // still: the runner is animated until movement has actually gone quiet for
    // longer than a fix is worth waiting for.
    this.moving =
      movedM > 0 ||
      (this.lastMovementAtMs !== null &&
        nowMs - this.lastMovementAtMs < BALANCE.movingGraceMs &&
        measuredToMs - this.lastMovementAtMs < BALANCE.movingGraceMs);
    // A runner whose movement has gone quiet is standing still, at no speed.
    if (moved === null && !this.moving) this.speedKmh = 0;
    if (speedKmh !== undefined && speedKmh !== null) this.speedKmh = Math.max(0, speedKmh);
    if (moved !== null) {
      // The measured window bounds the credit — one sparse fix pays for the whole
      // interval it covers, where the tick it landed in would pay for a second of
      // it. A caller that knows only a total gets the tick, as before.
      const windowMs = movement ? moved.lastAtMs - moved.firstAtMs : elapsed;
      // Speed is read off the interval the distance was measured over, so a
      // sparse fix reads as the pace it was run at rather than as a burst.
      const measuredMs = windowMs > 0 ? windowMs : elapsed;
      if (measuredMs > 0 && (speedKmh === undefined || speedKmh === null)) {
        this.speedKmh = (movedM / measuredMs) * 3600;
      }
      // A stretch that outlived the grace window restarts at its own first
      // movement rather than absorbing the pause it just came out of. Otherwise
      // the credit stops at the last movement already counted, so a pause under
      // the window is never paid for twice.
      this.streakMs += expired
        ? Math.max(0, moved.lastAtMs - moved.firstAtMs)
        : Math.max(0, Math.min(windowMs, moved.lastAtMs - (lastMovedAtMs ?? moved.firstAtMs)));
      this.lastMovedAtMs = moved.lastAtMs;
      this.stats.longestStreakMs = Math.max(this.stats.longestStreakMs, this.streakMs);
    }
    if (this.speedKmh >= this.speedThresholdKmh) this.lastAtThresholdAtMs = nowMs;

    if (this.surge !== null && nowMs >= this.surge.untilMs && !this.surgeFaded) {
      this.surgeFaded = true;
      this.push(nowMs, 'system', 'The surge fades.');
    }

    while (this.nextEnemyAttackAtMs !== null && nowMs >= this.nextEnemyAttackAtMs) {
      const enemy = this.currentEnemy();
      // Speed is the defence: keep it up and the blow misses. The attempt is
      // still spent, so the next one comes a whole interval later rather than
      // landing the moment the runner eases off.
      // A blow that falls just after the runner held the pace still misses:
      // GPS reports the road late, and a moment's easing-off is not a stop.
      const heldRecently =
        this.lastAtThresholdAtMs !== null &&
        nowMs - this.lastAtThresholdAtMs <= BALANCE.thresholdGraceMs;
      if (this.speedKmh >= this.speedThresholdKmh || (this.moving && heldRecently)) {
        this.nextEnemyAttackAtMs = nowMs + enemy.attackIntervalMs;
        this.push(nowMs, 'system', `You outrun ${enemy.name}. Keep the pace up.`);
        this.fire({ type: 'enemyMissed' });
        break;
      }
      // A runner standing still is not defending at all, so the blow lands clean.
      const crit = !this.moving;
      const damage = crit ? enemy.attackDamage * BALANCE.enemyCritMultiplier : enemy.attackDamage;
      this.playerHp = Math.max(0, this.playerHp - damage);
      this.push(
        nowMs,
        'enemy',
        crit
          ? `${enemy.taunt} You were standing still — CRITICAL (-${damage} HP)`
          : `${enemy.taunt} (-${damage} HP)`,
      );
      this.nextEnemyAttackAtMs += enemy.attackIntervalMs;
      this.fire({ type: 'enemyHit', damage, crit });
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

  /**
   * One lap = one attack, judged by the speed it was run at. Below the
   * threshold the runner never caught up, so the lap lands nothing; at
   * sprint speed the blow is a critical.
   */
  completeLap(lap: Lap): Attack | null {
    if (this.status !== 'running') return null;
    const enemy = this.currentEnemy();
    const pace = paceSecPerKm(lap);
    const lapSpeedKmh = lap.durationMs > 0 ? (lap.distanceM / lap.durationMs) * 3600 : 0;
    const called = this.sprintLive ? this.sprint : null;
    // Judged with leeway: a lap near the threshold still lands, since GPS lags
    // and measures a wandering line short.
    if (lapSpeedKmh < this.speedThresholdKmh * BALANCE.speedLeewayRatio) {
      // The ground still counts — it was run — but the lap was too slow to
      // reach the enemy, so no attack lands and an armed spell stays armed
      // rather than being spent on a whiff. A standing sprint call is answered
      // (and missed) by this lap all the same.
      this.stats.laps += 1;
      this.stats.totalDistanceM += lap.distanceM;
      this.stats.bestPaceRatio = Math.min(this.stats.bestPaceRatio, pace / this.baselinePace);
      this.baselinePace = updateBaseline(this.baselinePace, pace);
      this.energy = Math.min(BALANCE.maxEnergy, this.energy + BALANCE.energyPerLap);
      this.lapProgressM = 0;
      if (called !== null) {
        this.sprint = null;
        this.push(lap.atMs, 'system', 'Sprint missed — no critical this time.');
        this.fire({ type: 'sprintMissed' });
      }
      this.push(
        lap.atMs,
        'system',
        `Too slow to strike — hold ${this.speedThresholdKmh} km/h to land your attacks.`,
      );
      this.fire({ type: 'attackTooSlow', speedKmh: lapSpeedKmh });
      this.awardAchievements(lap.atMs);
      this.callSprintIfDue(lap.atMs, called !== null);
      this.emit();
      return null;
    }
    // The sprint is answered by the lap that ends it, whether or not it was fast
    // enough, so a called sprint never carries over into the next lap. A lap run
    // at sprint speed is a critical in its own right, call or no call — but the
    // call is judged only against its own advertised target, so a generic
    // critical cannot quietly pass off a missed call as answered.
    const calledMet =
      called !== null && pace <= called.targetPaceSecPerKm / BALANCE.speedLeewayRatio;
    const crit = calledMet || lapSpeedKmh >= this.sprintSpeedKmh() * BALANCE.speedLeewayRatio;
    if (called !== null) this.sprint = null;
    const attack = resolveAttack({
      lap,
      weapon: this.weapon,
      spell: this.armedSpell,
      enemy,
      baselinePace: this.baselinePace,
      streakMs: this.streakMs,
      crit,
      // Priced by when the lap was run, not when it was delivered: a throttled
      // heartbeat cannot pay out past the window, and a late lap cannot collect
      // on a window it was run before.
      surge:
        this.surge !== null && lap.atMs >= this.surge.fromMs && lap.atMs < this.surge.untilMs,
    });

    this.stats.laps += 1;
    this.stats.attacksLanded += 1;
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
    if (called !== null && !calledMet) {
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

  /**
   * A measured interval's own speed, dated at its end. A throttled heartbeat
   * can hold a fast stretch and a slow one, and the batch is judged by how it
   * ended — but the fast stretch still bought the threshold grace, so each
   * interval reports here as it is measured.
   */
  noteMeasuredSpeed(speedKmh: number, atMs: number): void {
    if (speedKmh < this.speedThresholdKmh) return;
    this.lastAtThresholdAtMs = Math.max(this.lastAtThresholdAtMs ?? atMs, atMs);
  }

  /** Speed at which a lap's attack lands as a critical. */
  sprintSpeedKmh(): number {
    return this.speedThresholdKmh * BALANCE.sprintZoneRatio;
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
        this.surge === null ? 0 : Math.max(0, this.surge.untilMs - (this.lastTickMs ?? 0)),
      stats: { ...this.stats },
      lapProgressM: this.lapProgressM,
      lapDistanceM: this.activeLapDistanceM(),
      nextAchievement: this.nextAchievement(),
      moving: this.moving,
      speedKmh: this.speedKmh,
      speedThresholdKmh: this.speedThresholdKmh,
      sprintSpeedKmh: this.sprintSpeedKmh(),
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
    // Claiming again while a surge runs extends the same window rather than
    // stacking, so a saved-up pile of rewards cannot end a level in one lap.
    const running = this.surge !== null && nowMs < this.surge.untilMs;
    this.surge = {
      fromMs: running ? this.surge!.fromMs : nowMs,
      untilMs: Math.max(this.surge?.untilMs ?? 0, nowMs) + BALANCE.surgeDurationMs,
    };
    this.surgeFaded = false;
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
    if (answeredOne) this.lapsSinceSprint = 0;
    // A call already standing is not re-announced, or a batch of laps would
    // reissue it with a fresh target while the runner is still reading the first.
    if (this.sprint !== null) return;
    if (!answeredOne) this.lapsSinceSprint += 1;
    if (this.lapsSinceSprint < BALANCE.sprintCooldownLaps) return;
    this.lapsSinceSprint = 0;
    const sprint: SprintChallenge = {
      distanceM: this.sprintDistanceM ?? this.currentLevel().lapDistanceM,
      // Never slower than the attack threshold: a target the runner can meet
      // and still whiff on speed would be a promise the lap cannot keep.
      targetPaceSecPerKm: Math.min(
        this.baselinePace * BALANCE.sprintPaceRatio,
        3600 / this.speedThresholdKmh,
      ),
    };
    this.sprint = sprint;
    this.sprintLive = false;
    this.sprintCalls += 1;
    this.push(
      atMs,
      'system',
      `SPRINT: next ${Math.round(sprint.distanceM)} m under ${formatPace(
        sprint.targetPaceSecPerKm,
      )}/km for a critical hit.`,
    );
    this.fire({ type: 'sprintCalled', ...sprint });
  }

  /**
   * A sprint advertises the distance it will be judged over, so a change to
   * either distance retires the call rather than settling it over a stretch the
   * runner was never asked to run.
   */
  private retireMismatchedSprint(): void {
    const asked = this.sprintDistanceM ?? this.currentLevel().lapDistanceM;
    if (this.sprint === null || this.sprint.distanceM === asked) return;
    this.sprint = null;
    this.lapsSinceSprint = 0;
    this.push(this.lastTickMs ?? 0, 'system', 'Sprint call is off — the distance changed.');
  }

  /** What the runner is closest to unlocking, so the HUD can name one target. */
  private nextAchievement(): AchievementProgress | null {
    let best: { achievement: (typeof ACHIEVEMENTS)[number]; progress: number } | null = null;
    for (const achievement of ACHIEVEMENTS) {
      if (this.achievements.has(achievement.id)) continue;
      const progress = achievement.progress(this.stats);
      if (best === null || progress > best.progress) best = { achievement, progress };
    }
    if (best === null) return null;
    return {
      id: best.achievement.id,
      name: best.achievement.name,
      description: best.achievement.description,
      progress: best.progress,
    };
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

/**
 * A distance or a speed has to be a positive, finite number. Zero metres would
 * leave the lap tracker unable to close a lap it has already covered, so an
 * unusable request falls back to the default rather than stalling the run.
 */
function positiveOrNull(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return Number.isFinite(value) && value > 0 ? value : null;
}
