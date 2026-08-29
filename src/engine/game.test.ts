import { describe, expect, it } from 'vitest';
import { BALANCE } from './damage';
import { GameSession } from './game';
import { LEVELS } from './content';

const lap = (atMs: number, secPerKm = 300, distanceM = 400) => ({
  distanceM,
  durationMs: (secPerKm * distanceM) / 1000 * 1000,
  atMs,
});

function startedSession(): GameSession {
  const session = new GameSession({ baselinePace: 360 });
  session.start(0);
  return session;
}

describe('GameSession', () => {
  it('ignores laps until the run is started', () => {
    const session = new GameSession();
    expect(session.completeLap(lap(0))).toBeNull();
  });

  it('damages the current enemy and grants energy per lap', () => {
    const session = startedSession();
    const attack = session.completeLap(lap(1000));
    expect(attack).not.toBeNull();
    const snapshot = session.snapshot();
    expect(snapshot.enemyHp).toBe(snapshot.enemy.maxHp - attack!.damage);
    expect(snapshot.energy).toBe(BALANCE.energyPerLap);
    expect(snapshot.stats.laps).toBe(1);
  });

  it('advances to the next enemy, then the next level, then victory', () => {
    const session = startedSession();
    let clock = 1000;
    const seen = new Set<string>();
    for (let i = 0; i < 400 && session.snapshot().status === 'running'; i += 1) {
      seen.add(session.snapshot().enemy.id);
      clock += 60_000;
      session.completeLap(lap(clock, 200));
    }
    const snapshot = session.snapshot();
    expect(snapshot.status).toBe('victory');
    expect(seen.size).toBe(LEVELS.flatMap((l) => l.enemies).length);
  });

  it('lets the enemy whittle the player down when no laps land', () => {
    const session = startedSession();
    session.tick(60 * 60_000, 0);
    expect(session.snapshot().status).toBe('defeat');
    expect(session.snapshot().playerHp).toBe(0);
  });

  it('breaks the streak after a long stationary gap but keeps the record', () => {
    const session = startedSession();
    session.tick(10_000, 50);
    session.tick(20_000, 50);
    expect(session.snapshot().streakMs).toBe(20_000);
    session.tick(20_000 + BALANCE.streakBreakMs, 0);
    expect(session.snapshot().streakMs).toBe(0);
    expect(session.snapshot().stats.longestStreakMs).toBe(20_000);
  });

  it('breaks the streak across a pause made of one-second heartbeats', () => {
    const session = startedSession();
    session.tick(1000, 5);
    session.tick(2000, 5);
    expect(session.snapshot().streakMs).toBe(2000);
    for (let now = 3000; now <= 2000 + BALANCE.streakBreakMs; now += 1000) {
      session.tick(now, 0);
    }
    expect(session.snapshot().streakMs).toBe(0);
    session.tick(2000 + BALANCE.streakBreakMs + 1000, 5);
    session.tick(2000 + BALANCE.streakBreakMs + 2000, 5);
    expect(session.snapshot().streakMs).toBe(1000);
    expect(session.snapshot().stats.longestStreakMs).toBe(2000);
  });

  it('expires the streak on resumed movement even without a tick during the gap', () => {
    const session = startedSession();
    session.tick(1000, 5);
    session.tick(2000, 5);
    // Throttled timers: the next tick arrives after the gap, already moving.
    session.tick(2000 + BALANCE.streakBreakMs, 5);
    expect(session.snapshot().streakMs).toBe(0);
    expect(session.snapshot().stats.longestStreakMs).toBe(2000);
  });

  it('keeps a streak that a throttled tick covered with continuous movement', () => {
    const session = startedSession();
    session.tick(1000, 5);
    // One tick, 60 s late, carrying distance sampled every second throughout:
    // moving all along is not the same as moving again after a pause. The window
    // opens where the first of those samples started measuring, at t=1000.
    session.tick(61_000, 300, { firstAtMs: 1000, lastAtMs: 61_000 });
    expect(session.snapshot().streakMs).toBe(61_000);
  });

  it('keeps the streak through a pause shorter than the grace window', () => {
    const session = startedSession();
    session.tick(1000, 5);
    for (let now = 2000; now < 1000 + BALANCE.streakBreakMs; now += 1000) {
      session.tick(now, 0);
    }
    expect(session.snapshot().streakMs).toBe(1000);
  });

  it('requires energy and an unlock before a spell can be armed', () => {
    const session = startedSession();
    expect(session.armSpell('fireball')).toBe(false);
    session.completeLap(lap(1000));
    session.completeLap(lap(2000));
    expect(session.snapshot().energy).toBe(50);
    expect(session.armSpell('meteor')).toBe(false);
    expect(session.armSpell('fireball')).toBe(true);
    expect(session.snapshot().armedSpell?.id).toBe('fireball');
    expect(session.snapshot().energy).toBe(10);
  });

  it('spends an armed spell on the next lap only', () => {
    const session = startedSession();
    session.completeLap(lap(1000));
    session.completeLap(lap(2000));
    session.armSpell('fireball');
    const boosted = session.completeLap(lap(3000));
    const plain = session.completeLap(lap(4000));
    expect(boosted!.spell?.id).toBe('fireball');
    expect(plain!.spell).toBeNull();
    expect(session.snapshot().armedSpell).toBeNull();
  });

  it('unlocks spells through achievements', () => {
    const session = startedSession();
    session.completeLap(lap(1000, 240));
    const snapshot = session.snapshot();
    expect(snapshot.achievements).toContain('negative-split');
    expect(snapshot.unlockedSpells).toContain('smite');
  });

  it('announces each achievement once, with the spell it unlocked', () => {
    const session = startedSession();
    const announced: Array<[string, string | null]> = [];
    session.onEvent((event) => {
      if (event.type === 'achievement') announced.push([event.name, event.unlockedSpellName]);
    });
    session.completeLap(lap(1000, 240));
    session.completeLap(lap(2000, 240));
    expect(announced).toEqual([
      ['First Blood', null],
      ['Negative Split', 'Arcane Smite'],
      ["Sprinter's High", null],
    ]);
  });

  it('lets the runner override the lap distance for every level, and undo it', () => {
    const session = startedSession();
    const levelDefault = LEVELS[0]!.lapDistanceM;
    expect(session.currentLevel().lapDistanceM).toBe(levelDefault);
    session.setLapDistance(150);
    expect(session.currentLevel().lapDistanceM).toBe(150);
    expect(session.snapshot().level.lapDistanceM).toBe(150);
    // Level identity is stable, so subscribers can compare snapshots cheaply.
    expect(session.currentLevel()).toBe(session.currentLevel());
    session.setLapDistance(null);
    expect(session.currentLevel().lapDistanceM).toBe(levelDefault);
  });

  it('reports whether the runner is actually moving, for the animation', () => {
    const session = startedSession();
    expect(session.snapshot().moving).toBe(false);
    session.tick(5000, 12);
    expect(session.snapshot().moving).toBe(true);
    session.tick(6000, 0);
    expect(session.snapshot().moving).toBe(false);
  });

  it('emits events the scene can animate', () => {
    const session = new GameSession({ baselinePace: 360 });
    const events: string[] = [];
    session.onEvent((event) => events.push(event.type));
    session.start(0);
    session.completeLap(lap(1000, 200));
    session.completeLap(lap(2000, 200));
    session.tick(60 * 60_000, 0);
    expect(events[0]).toBe('levelStart');
    expect(events).toContain('attack');
    expect(events).toContain('enemyDefeated');
    expect(events).toContain('enemyHit');
    expect(events.at(-1)).toBe('defeat');
  });

  it('notifies subscribers on every state change', () => {
    const session = startedSession();
    let updates = 0;
    session.subscribe(() => {
      updates += 1;
    });
    session.completeLap(lap(1000));
    session.selectWeapon('daggers');
    expect(updates).toBe(3);
  });

  it('calls a sprint only after a quiet stretch of laps', () => {
    const session = startedSession();
    let clock = 1000;
    for (let i = 0; i < BALANCE.sprintCooldownLaps - 1; i += 1) {
      clock += 120_000;
      session.completeLap(lap(clock, 360));
      expect(session.snapshot().sprint).toBeNull();
    }
    clock += 120_000;
    session.completeLap(lap(clock, 360));
    const sprint = session.snapshot().sprint;
    expect(sprint).not.toBeNull();
    // Drawn from the runner's own baseline, so it is a push rather than a fitness gate.
    expect(sprint!.targetPaceSecPerKm).toBeCloseTo(
      session.snapshot().baselinePace * BALANCE.sprintPaceRatio,
      5,
    );
  });

  /** A session with a live sprint call: the next reported sample arms it. */
  function sessionAwaitingSprint(): { session: GameSession; clock: number } {
    const session = startedSession();
    let clock = 1000;
    while (session.snapshot().sprint === null) {
      clock += 120_000;
      session.completeLap(lap(clock, 360));
    }
    session.reportProgress(0);
    return { session, clock };
  }

  it('crits the lap that answers the sprint, and only that lap', () => {
    const { session, clock } = sessionAwaitingSprint();
    const target = session.snapshot().sprint!.targetPaceSecPerKm;
    const attack = session.completeLap(lap(clock + 60_000, target - 10));
    expect(attack!.crit).toBe(true);
    expect(attack!.critMultiplier).toBe(BALANCE.critMultiplier);
    // The call is spent whether or not it was answered, so the next lap is normal.
    expect(session.snapshot().sprint).toBeNull();
    const next = session.completeLap(lap(clock + 120_000, target - 10));
    expect(next!.crit).toBe(false);
  });

  it('spends a sprint the runner was too slow for, without a crit', () => {
    const { session, clock } = sessionAwaitingSprint();
    const target = session.snapshot().sprint!.targetPaceSecPerKm;
    const events: string[] = [];
    session.onEvent((event) => events.push(event.type));
    const attack = session.completeLap(lap(clock + 60_000, target + 30));
    expect(attack!.crit).toBe(false);
    expect(events).toContain('sprintMissed');
    expect(session.snapshot().sprint).toBeNull();
  });

  it('will not call the next sprint straight after one was answered', () => {
    const { session, clock } = sessionAwaitingSprint();
    const target = session.snapshot().sprint!.targetPaceSecPerKm;
    let now = clock + 60_000;
    session.completeLap(lap(now, target - 10));
    for (let i = 0; i < BALANCE.sprintCooldownLaps - 1; i += 1) {
      now += 120_000;
      session.completeLap(lap(now, 360));
      session.reportProgress(0);
      expect(session.snapshot().sprint).toBeNull();
    }
  });

  it('queues a reward per achievement and spends one per claim', () => {
    const session = startedSession();
    session.completeLap(lap(1000, 360));
    const earned = session.snapshot().achievements.length;
    expect(earned).toBeGreaterThan(0);
    expect(session.snapshot().unclaimedRewards).toBe(earned);

    expect(session.claimReward(2000)).toBe(true);
    expect(session.snapshot().unclaimedRewards).toBe(earned - 1);
  });

  it('claimed rewards boost damage until they run out, and heal', () => {
    const session = new GameSession({ baselinePace: 360, playerMaxHp: 100 });
    session.start(0);
    const plain = session.completeLap(lap(1000, 360))!.damage;
    // Take a hit so the heal has something to give back.
    session.tick(60_000, 0);
    const hurt = session.snapshot().playerHp;
    expect(hurt).toBeLessThan(100);

    session.claimReward(60_000);
    expect(session.snapshot().playerHp).toBe(Math.min(100, hurt + BALANCE.surgeHeal));
    expect(session.snapshot().playerHp).toBeGreaterThan(hurt);
    const surged = session.completeLap(lap(61_000, 360))!;
    expect(surged.surgeMultiplier).toBe(BALANCE.surgeMultiplier);
    expect(surged.damage).toBeGreaterThan(plain);

    session.tick(60_000 + BALANCE.surgeDurationMs, 0);
    expect(session.snapshot().surgeMsLeft).toBe(0);
  });

  it('refuses a claim with nothing to claim', () => {
    const session = startedSession();
    expect(session.claimReward(1000)).toBe(false);
  });

  it('holds a sprint call back from laps that were already run', () => {
    const session = startedSession();
    let clock = 1000;
    while (session.snapshot().sprint === null) {
      clock += 120_000;
      session.completeLap(lap(clock, 360));
    }
    // Same batch: one coarse sample can finish several laps in a row, and their
    // distance was covered before the call went out.
    const target = session.snapshot().sprint!.targetPaceSecPerKm;
    const inBatch = session.completeLap(lap(clock + 1, target - 60));
    expect(inBatch!.crit).toBe(false);
    expect(session.snapshot().sprint).not.toBeNull();

    session.reportProgress(0);
    const answered = session.completeLap(lap(clock + 120_000, target - 10));
    expect(answered!.crit).toBe(true);
  });

  it('retires a sprint call when the lap changes length under it', () => {
    const { session } = sessionAwaitingSprint();
    const called = session.snapshot().sprint!;
    session.setLapDistance(100);
    expect(session.snapshot().sprint).toBeNull();
    expect(called.distanceM).not.toBe(100);
  });

  it('stops paying out a surge for a lap that ended after it faded', () => {
    const session = startedSession();
    session.completeLap(lap(1000, 360));
    session.claimReward(1000);
    // No heartbeat lands between the claim and the lap, so only the lap's own
    // time can tell that the surge is long gone.
    const late = session.completeLap(lap(1000 + BALANCE.surgeDurationMs + 1, 360));
    expect(late!.surgeMultiplier).toBe(1);
  });

  it('does not reissue a sprint call to laps still in the same batch', () => {
    const session = startedSession();
    let clock = 1000;
    while (session.snapshot().sprint === null) {
      clock += 120_000;
      session.completeLap(lap(clock, 360));
    }
    const first = session.snapshot().sprint!;
    for (let i = 0; i < BALANCE.sprintCooldownLaps + 1; i += 1) {
      clock += 1;
      session.completeLap(lap(clock, 360));
    }
    expect(session.snapshot().sprint).toEqual(first);
  });

  it('prices a late lap by the window it was run in', () => {
    const session = startedSession();
    session.completeLap(lap(1000, 360));
    session.claimReward(10_000);
    // Delivered after the window lapsed, but run inside it.
    session.tick(10_000 + BALANCE.surgeDurationMs + 1, 0);
    const late = session.completeLap(lap(20_000, 360));
    expect(late!.surgeMultiplier).toBe(BALANCE.surgeMultiplier);
    // Run before the claim: no boost, however late it arrives.
    const early = session.completeLap(lap(5_000, 360));
    expect(early!.surgeMultiplier).toBe(1);
  });
});
