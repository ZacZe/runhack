import { describe, expect, it } from 'vitest';
import { weaponById } from './content';
import {
  BALANCE,
  formatPace,
  paceMultiplier,
  paceSecPerKm,
  resolveAttack,
  streakMultiplier,
  updateBaseline,
} from './damage';
import type { Enemy, Lap } from './types';

const enemy: Enemy = {
  id: 'dummy',
  name: 'Training Dummy',
  maxHp: 1000,
  weakTo: ['fire'],
  attackIntervalMs: 60_000,
  attackDamage: 5,
  taunt: '...',
};

const lapAt = (secPerKm: number, distanceM = 400): Lap => ({
  distanceM,
  durationMs: (secPerKm * distanceM) / 1000 * 1000,
  atMs: 0,
});

describe('paceSecPerKm', () => {
  it('converts a lap to pace', () => {
    expect(paceSecPerKm({ distanceM: 400, durationMs: 120_000, atMs: 0 })).toBe(300);
  });

  it('treats a zero-distance lap as infinitely slow', () => {
    expect(paceSecPerKm({ distanceM: 0, durationMs: 1000, atMs: 0 })).toBe(Infinity);
  });
});

describe('paceMultiplier', () => {
  it('is 1 at baseline pace regardless of scaling', () => {
    expect(paceMultiplier(360, 360, 0.6)).toBeCloseTo(1);
    expect(paceMultiplier(360, 360, 2)).toBeCloseTo(1);
  });

  it('rewards faster laps and punishes slower ones', () => {
    expect(paceMultiplier(300, 360, 1)).toBeCloseTo(1.2);
    expect(paceMultiplier(450, 360, 1)).toBeCloseTo(0.8);
  });

  it('scales harder for high-scaling weapons', () => {
    const steady = paceMultiplier(300, 360, 0.6);
    const sprinty = paceMultiplier(300, 360, 2);
    expect(sprinty).toBeGreaterThan(steady);
  });

  it('clamps both ends so no runner is locked out or trivialises a level', () => {
    expect(paceMultiplier(30, 360, 2)).toBe(BALANCE.maxPaceMultiplier);
    expect(paceMultiplier(3600, 360, 2)).toBe(BALANCE.minPaceMultiplier);
    expect(paceMultiplier(Infinity, 360, 1)).toBe(BALANCE.minPaceMultiplier);
  });
});

describe('streakMultiplier', () => {
  it('starts neutral and grows with unbroken minutes', () => {
    expect(streakMultiplier(0)).toBe(1);
    expect(streakMultiplier(10 * 60_000)).toBeCloseTo(1.2);
  });

  it('caps the bonus', () => {
    expect(streakMultiplier(10 * 60 * 60_000)).toBeCloseTo(1 + BALANCE.maxStreakBonus);
  });
});

describe('updateBaseline', () => {
  it('drifts towards recent laps', () => {
    expect(updateBaseline(360, 300)).toBeCloseTo(345);
  });

  it('ignores unusable laps', () => {
    expect(updateBaseline(360, Infinity)).toBe(360);
    expect(updateBaseline(360, 0)).toBe(360);
  });
});

describe('resolveAttack', () => {
  it('multiplies weapon base by pace, streak and spell', () => {
    const attack = resolveAttack({
      lap: lapAt(300),
      weapon: weaponById('sword'),
      spell: null,
      enemy,
      baselinePace: 360,
      streakMs: 0,
    });
    expect(attack.paceMultiplier).toBeGreaterThan(1);
    expect(attack.damage).toBe(
      Math.round(20 * attack.paceMultiplier * attack.streakMultiplier * attack.spellMultiplier),
    );
  });

  it('applies the weakness bonus when the cast element matches', () => {
    const args = {
      lap: lapAt(360),
      weapon: weaponById('sword'),
      enemy,
      baselinePace: 360,
      streakMs: 0,
    };
    const plain = resolveAttack({ ...args, spell: null });
    const fire = resolveAttack({
      ...args,
      spell: {
        id: 'fireball',
        name: 'Fireball',
        cost: 0,
        multiplier: 1,
        element: 'fire',
        aliases: [],
      },
    });
    expect(plain.exploitedWeakness).toBe(false);
    expect(fire.exploitedWeakness).toBe(true);
    expect(fire.damage).toBe(Math.round(plain.damage * BALANCE.weaknessMultiplier));
  });

  it('never deals less than 1 damage', () => {
    const attack = resolveAttack({
      lap: lapAt(9999),
      weapon: weaponById('daggers'),
      spell: null,
      enemy,
      baselinePace: 360,
      streakMs: 0,
    });
    expect(attack.damage).toBeGreaterThanOrEqual(1);
  });
});

describe('formatPace', () => {
  it('formats minutes per kilometre', () => {
    expect(formatPace(360)).toBe('6:00');
    expect(formatPace(305)).toBe('5:05');
    expect(formatPace(359.7)).toBe('6:00');
    expect(formatPace(Infinity)).toBe('--:--');
  });
});
