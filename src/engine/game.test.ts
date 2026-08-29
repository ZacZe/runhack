import { describe, expect, it } from 'vitest';
import { BALANCE } from './damage';
import { GameSession } from './game';
import { LEVELS } from './content';

const lap = (atMs: number, secPerKm = 400, distanceM = 400) => ({
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

  it('lands no attack for a lap run under the threshold speed, but counts the ground', () => {
    const session = startedSession();
    // 400 m at 720 s/km is 5 km/h, under the default 6 km/h threshold.
    const attack = session.completeLap(lap(1000, 720));
    expect(attack).toBeNull();
    const snapshot = session.snapshot();
    expect(snapshot.enemyHp).toBe(snapshot.enemy.maxHp);
    expect(snapshot.stats.laps).toBe(1);
    expect(snapshot.stats.attacksLanded).toBe(0);
    expect(snapshot.stats.totalDistanceM).toBe(400);
    expect(snapshot.energy).toBe(BALANCE.energyPerLap);
    expect(snapshot.lapProgressM).toBe(0);
    // First Blood is about landing a hit, and none landed.
    expect(snapshot.achievements).not.toContain('first-blood');
  });

  it('lands a lap run just under the threshold, within the leeway', () => {
    const session = startedSession();
    // 400 m at 660 s/km is ~5.45 km/h — under the 6 km/h threshold but over
    // its 85% leeway floor, so GPS under-measurement does not cost the attack.
    const attack = session.completeLap(lap(1000, 660));
    expect(attack).not.toBeNull();
    expect(attack!.crit).toBe(false);
  });

  it('crits a lap run just under sprint speed, within the leeway', () => {
    const session = startedSession();
    // 400 m at 340 s/km is ~10.6 km/h — under the 12 km/h sprint speed but
    // over its 85% leeway floor.
    const fast = session.completeLap(lap(1000, 340));
    expect(fast).not.toBeNull();
    expect(fast!.crit).toBe(true);
  });

  it('crits a lap run at sprint speed, without a sprint call', () => {
    const session = startedSession();
    // 400 m at 300 s/km is 12 km/h, the default 6 km/h threshold times 2.
    const fast = session.completeLap(lap(1000, 300));
    expect(fast).not.toBeNull();
    expect(fast!.crit).toBe(true);
    // Under the sprint speed and its leeway: an ordinary landed attack.
    const ordinary = session.completeLap(lap(2000, 400));
    expect(ordinary).not.toBeNull();
    expect(ordinary!.crit).toBe(false);
  });

  it('keeps an armed spell when the lap is too slow to strike', () => {
    const session = startedSession();
    session.tick(1000, 0);
    const spell = session.snapshot().unlockedSpells[0]!;
    // Earn enough energy to arm a spell, then whiff a lap.
    session.completeLap(lap(1000));
    session.completeLap(lap(2000));
    session.completeLap(lap(3000));
    session.completeLap(lap(4000));
    session.armSpell(spell);
    const armed = session.snapshot().armedSpell;
    expect(armed).not.toBeNull();
    session.completeLap(lap(60_000, 720));
    expect(session.snapshot().armedSpell).toBe(armed);
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

  it('keeps the runner animated between sparse fixes, and stops once movement does', () => {
    const session = startedSession();
    expect(session.snapshot().moving).toBe(false);
    session.tick(5000, 12);
    expect(session.snapshot().moving).toBe(true);
    // GPS reports every few seconds and a short stride reads as jitter, so a
    // tick with no distance in it is not a runner standing still.
    session.tick(6000, 0);
    expect(session.snapshot().moving).toBe(true);
    session.tick(5000 + BALANCE.movingGraceMs, 0);
    expect(session.snapshot().moving).toBe(false);
  });

  it('lets the enemy land its blow only on a runner who has eased off', () => {
    const session = new GameSession({ baselinePace: 360, speedThresholdKmh: 6 });
    const events: string[] = [];
    session.onEvent((event) => events.push(event.type));
    session.start(0);
    const attackDue = session.snapshot().enemy.attackIntervalMs;

    // 10 km/h over the interval the fix covers: out of reach, so no damage.
    session.tick(attackDue, (10 * 1000 * attackDue) / 3_600_000, {
      firstAtMs: 0,
      lastAtMs: attackDue,
    });
    expect(session.snapshot().playerHp).toBe(session.snapshot().playerMaxHp);
    expect(events).toContain('enemyMissed');

    // Eased off to a 4 km/h walk long past the threshold grace: still moving,
    // so the blow lands for its own damage rather than a critical.
    const walkFrom = attackDue;
    const walkTo = attackDue * 2;
    session.tick(walkTo, (4 * 1000 * attackDue) / 3_600_000, {
      firstAtMs: walkFrom,
      lastAtMs: walkTo,
    });
    const walked = session.snapshot();
    expect(walked.playerHp).toBe(walked.playerMaxHp - walked.enemy.attackDamage);
    expect(events).toContain('enemyHit');
  });

  it('spares a moving runner who held the threshold moments before the blow', () => {
    const session = new GameSession({ baselinePace: 360, speedThresholdKmh: 6 });
    const events: string[] = [];
    session.onEvent((event) => events.push(event.type));
    session.start(0);
    const attackDue = session.snapshot().enemy.attackIntervalMs;
    // At pace right up to a few seconds before the blow falls…
    session.tick(attackDue - 2000, (10 * 1000 * attackDue) / 3_600_000, {
      firstAtMs: 0,
      lastAtMs: attackDue - 2000,
    });
    // …then a late fix reads a walking interval as the blow lands: the recent
    // hold still counts, so the blow misses.
    session.tick(attackDue, (4 * 1000 * 2000) / 3_600_000, {
      firstAtMs: attackDue - 2000,
      lastAtMs: attackDue,
    });
    expect(session.snapshot().playerHp).toBe(session.snapshot().playerMaxHp);
    expect(events).toContain('enemyMissed');
  });

  it('does not carry the threshold grace across a raised threshold', () => {
    const session = new GameSession({ baselinePace: 360, speedThresholdKmh: 6 });
    const events: string[] = [];
    session.onEvent((event) => events.push(event.type));
    session.start(0);
    const attackDue = session.snapshot().enemy.attackIntervalMs;
    // Held the old 6 km/h threshold right up to the blow…
    session.tick(attackDue - 2000, (10 * 1000 * attackDue) / 3_600_000, {
      firstAtMs: 0,
      lastAtMs: attackDue - 2000,
    });
    // …but the bar was raised, so the grace earned against the old one is gone.
    session.setSpeedThreshold(12);
    session.tick(attackDue, (10 * 1000 * 2000) / 3_600_000, {
      firstAtMs: attackDue - 2000,
      lastAtMs: attackDue,
    });
    expect(session.snapshot().playerHp).toBe(
      session.snapshot().playerMaxHp - session.snapshot().enemy.attackDamage,
    );
    expect(events).toContain('enemyHit');
  });

  it('lets a stopped runner be hit critically', () => {
    const session = new GameSession({ baselinePace: 360 });
    session.start(0);
    const enemy = session.snapshot().enemy;
    // No movement at all, long enough for the animation grace to lapse: standing
    // still is no defence.
    session.tick(enemy.attackIntervalMs, 0);
    expect(session.snapshot().playerHp).toBe(
      session.snapshot().playerMaxHp - enemy.attackDamage * BALANCE.enemyCritMultiplier,
    );
  });

  it.each([0, -3, NaN, Infinity, null])('falls back to the default threshold for %s', (bad) => {
    const session = new GameSession({ baselinePace: 360, speedThresholdKmh: bad });
    session.start(0);
    expect(session.snapshot().speedThresholdKmh).toBe(BALANCE.slowSpeedKmh);
    session.setSpeedThreshold(bad);
    expect(session.snapshot().speedThresholdKmh).toBe(BALANCE.slowSpeedKmh);
    session.setSpeedThreshold(9);
    expect(session.snapshot().speedThresholdKmh).toBe(9);
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
    const next = session.completeLap(lap(clock + 120_000, 400));
    expect(next!.crit).toBe(false);
  });

  it('spends a sprint the runner was too slow for, without a crit', () => {
    const { session, clock } = sessionAwaitingSprint();
    const target = session.snapshot().sprint!.targetPaceSecPerKm;
    const events: string[] = [];
    session.onEvent((event) => events.push(event.type));
    // Slower than even the leeway on the call, but fast enough to land.
    const attack = session.completeLap(lap(clock + 60_000, target / BALANCE.speedLeewayRatio + 30));
    expect(attack!.crit).toBe(false);
    expect(events).toContain('sprintMissed');
    expect(session.snapshot().sprint).toBeNull();
  });

  it('never calls a sprint slower than the attack threshold', () => {
    // A baseline of 360 would put the called target at 306 s/km — under the
    // 12 km/h threshold (300 s/km), a pace the lap could meet and still whiff.
    const session = new GameSession({ baselinePace: 360, speedThresholdKmh: 12 });
    session.start(0);
    let clock = 1000;
    while (session.snapshot().sprint === null) {
      clock += 120_000;
      session.completeLap(lap(clock, 280));
    }
    expect(session.snapshot().sprint!.targetPaceSecPerKm).toBeLessThanOrEqual(3600 / 12);
  });

  it('reports a missed call even when the lap earns a generic sprint crit', () => {
    const session = new GameSession({ baselinePace: 200 });
    session.start(0);
    let clock = 1000;
    while (session.snapshot().sprint === null) {
      clock += 120_000;
      session.completeLap(lap(clock, 230));
    }
    session.reportProgress(0);
    const target = session.snapshot().sprint!.targetPaceSecPerKm;
    // Fast enough for the generic sprint zone, but slower than the call and
    // its leeway.
    const paceSecPerKm = 300;
    expect(paceSecPerKm).toBeGreaterThan(target / BALANCE.speedLeewayRatio);
    const events: string[] = [];
    session.onEvent((event) => events.push(event.type));
    const attack = session.completeLap(lap(clock + 60_000, paceSecPerKm));
    expect(attack!.crit).toBe(true);
    expect(events).toContain('sprintMissed');
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
    // A pace that only the call would crit, so the crit proves the call is live.
    const target = session.snapshot().sprint!.targetPaceSecPerKm;
    const callOnlyPace = target / BALANCE.speedLeewayRatio - 5;
    const inBatch = session.completeLap(lap(clock + 1, callOnlyPace));
    expect(inBatch!.crit).toBe(false);
    expect(session.snapshot().sprint).not.toBeNull();

    session.reportProgress(0);
    const answered = session.completeLap(lap(clock + 120_000, callOnlyPace));
    expect(answered!.crit).toBe(true);
  });

  it('runs a called sprint over the distance the runner chose for sprints', () => {
    const session = new GameSession({ baselinePace: 360, lapDistanceM: 600, sprintDistanceM: 200 });
    session.start(0);
    expect(session.activeLapDistanceM()).toBe(600);
    let clock = 1000;
    while (session.snapshot().sprint === null) {
      clock += 120_000;
      session.completeLap(lap(clock, 360, 600));
    }
    // The call stands, but only takes hold at the next sample boundary: the
    // ground this batch covered was run before it went out.
    expect(session.snapshot().sprint!.distanceM).toBe(200);
    expect(session.activeLapDistanceM()).toBe(600);
    session.reportProgress(0);
    // Now the attack lands 200 m in rather than 600.
    expect(session.activeLapDistanceM()).toBe(200);
    expect(session.snapshot().lapDistanceM).toBe(200);
    session.completeLap(lap(clock + 60_000, 200, 200));
    expect(session.activeLapDistanceM()).toBe(600);
  });

  it.each([0, -400, NaN, Infinity])('ignores %s as a distance', (bad) => {
    const session = new GameSession({
      baselinePace: 360,
      lapDistanceM: bad,
      sprintDistanceM: bad,
    });
    session.start(0);
    // A lap of zero or fewer metres is one the tracker can never close, so the
    // level's own distance stands instead of stalling the run.
    expect(session.activeLapDistanceM()).toBe(400);

    session.setLapDistance(bad);
    session.setSprintDistance(bad);
    expect(session.activeLapDistanceM()).toBe(400);

    let clock = 1000;
    while (session.snapshot().sprint === null) {
      clock += 120_000;
      session.completeLap(lap(clock, 360, 400));
    }
    expect(session.snapshot().sprint!.distanceM).toBe(400);
  });

  it('retires a sprint call when the sprint distance changes under it', () => {
    const { session } = sessionAwaitingSprint();
    expect(session.snapshot().sprint).not.toBeNull();
    session.setSprintDistance(150);
    expect(session.snapshot().sprint).toBeNull();
  });

  it('names the achievement the runner is closest to earning', () => {
    const session = startedSession();
    expect(session.snapshot().nextAchievement?.id).toBe('first-blood');
    session.completeLap(lap(1000, 360));
    const next = session.snapshot().nextAchievement!;
    expect(session.snapshot().achievements).toContain('first-blood');
    expect(next.id).not.toBe('first-blood');
    expect(next.progress).toBeGreaterThanOrEqual(0);
    expect(next.progress).toBeLessThanOrEqual(1);
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
