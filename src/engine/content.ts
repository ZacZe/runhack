import type { Achievement, Level, Spell, Weapon } from './types';

/**
 * Each weapon trades base damage against pace scaling, so the loadout is a
 * training choice: the hammer rewards a steady jog, the daggers reward surges.
 */
export const WEAPONS: Weapon[] = [
  {
    id: 'hammer',
    name: 'Pacekeeper Hammer',
    baseDamage: 26,
    paceScaling: 0.6,
    element: 'physical',
    aliases: ['hammer', 'mallet'],
  },
  {
    id: 'sword',
    name: 'Tempo Blade',
    baseDamage: 20,
    paceScaling: 1.1,
    element: 'physical',
    aliases: ['sword', 'blade'],
  },
  {
    id: 'daggers',
    name: 'Sprinter Daggers',
    baseDamage: 13,
    paceScaling: 2,
    element: 'physical',
    aliases: ['daggers', 'dagger', 'knives'],
  },
  {
    id: 'staff',
    name: 'Runic Staff',
    baseDamage: 17,
    paceScaling: 1,
    element: 'arcane',
    aliases: ['staff', 'stave', 'wand'],
  },
];

export const SPELLS: Spell[] = [
  {
    id: 'fireball',
    name: 'Fireball',
    cost: 40,
    multiplier: 2,
    element: 'fire',
    aliases: ['fireball', 'fire ball', 'fire'],
  },
  {
    id: 'frost',
    name: 'Frost Lance',
    cost: 40,
    multiplier: 1.8,
    element: 'ice',
    aliases: ['frost', 'frost lance', 'ice', 'ice lance'],
  },
  {
    id: 'smite',
    name: 'Arcane Smite',
    cost: 60,
    multiplier: 2.6,
    element: 'arcane',
    aliases: ['smite', 'arcane smite', 'arcane'],
    unlockedBy: 'negative-split',
  },
  {
    id: 'meteor',
    name: 'Meteor',
    cost: 100,
    multiplier: 4,
    element: 'fire',
    aliases: ['meteor', 'meteor strike'],
    unlockedBy: 'long-hauler',
  },
];

/**
 * Enemy HP is expressed in "expected laps": roughly baseDamage 20 x a modest
 * pace bonus, so ~25 damage per lap. Level 1 mobs die in ~2 laps, the final
 * boss in ~8 good ones.
 */
export const LEVELS: Level[] = [
  {
    id: 'level-1',
    name: 'The Warmup Woods',
    lapDistanceM: 400,
    enemies: [
      {
        id: 'slime',
        name: 'Lactic Slime',
        maxHp: 50,
        weakTo: ['fire'],
        attackIntervalMs: 45_000,
        attackDamage: 4,
        taunt: 'The slime oozes closer.',
      },
      {
        id: 'shin-wraith',
        name: 'Shin Splint Wraith',
        maxHp: 90,
        weakTo: ['arcane'],
        attackIntervalMs: 40_000,
        attackDamage: 6,
        taunt: 'A cold ache creeps up your shins.',
      },
    ],
  },
  {
    id: 'level-2',
    name: 'Hillclimb Ruins',
    lapDistanceM: 500,
    enemies: [
      {
        id: 'gargoyle',
        name: 'Gradient Gargoyle',
        maxHp: 140,
        weakTo: ['ice'],
        attackIntervalMs: 35_000,
        attackDamage: 8,
        taunt: 'The gargoyle grinds its stone wings.',
      },
      {
        id: 'wall',
        name: 'The Wall',
        maxHp: 190,
        weakTo: ['fire', 'arcane'],
        attackIntervalMs: 30_000,
        attackDamage: 10,
        taunt: 'The Wall does not move. It waits.',
      },
    ],
  },
  {
    id: 'level-3',
    name: 'Threshold Spire',
    lapDistanceM: 600,
    enemies: [
      {
        id: 'hound',
        name: 'Tempo Hound',
        maxHp: 200,
        weakTo: ['ice'],
        attackIntervalMs: 28_000,
        attackDamage: 11,
        taunt: 'The hound matches your stride, breath for breath.',
      },
      {
        id: 'cramp-lord',
        name: 'Cramp Lord',
        maxHp: 230,
        weakTo: ['fire'],
        attackIntervalMs: 26_000,
        attackDamage: 12,
        taunt: 'Your calves tighten under his gaze.',
      },
    ],
  },
  {
    id: 'boss',
    name: 'The Final Kilometre',
    lapDistanceM: 400,
    enemies: [
      {
        id: 'chronarch',
        name: 'Chronarch, Keeper of Splits',
        maxHp: 320,
        weakTo: ['arcane'],
        attackIntervalMs: 22_000,
        attackDamage: 14,
        taunt: 'Chronarch resets the clock. Again.',
      },
    ],
  },
];

export const ACHIEVEMENTS: Achievement[] = [
  {
    id: 'first-blood',
    name: 'First Blood',
    description: 'Land your first lap.',
    test: (s) => s.laps >= 1,
  },
  {
    id: 'negative-split',
    name: 'Negative Split',
    description: 'Run a lap 15% faster than your baseline.',
    unlocksSpell: 'smite',
    test: (s) => s.bestPaceRatio <= 0.85,
  },
  {
    id: 'long-hauler',
    name: 'Long Hauler',
    description: 'Keep moving for 10 unbroken minutes.',
    unlocksSpell: 'meteor',
    test: (s) => s.longestStreakMs >= 10 * 60_000,
  },
  {
    id: 'giant-slayer',
    name: 'Giant Slayer',
    description: 'Defeat four enemies in one run.',
    test: (s) => s.enemiesDefeated >= 4,
  },
];

export function weaponById(id: string): Weapon {
  const weapon = WEAPONS.find((w) => w.id === id);
  if (!weapon) throw new Error(`unknown weapon: ${id}`);
  return weapon;
}

export function spellById(id: string): Spell {
  const spell = SPELLS.find((s) => s.id === id);
  if (!spell) throw new Error(`unknown spell: ${id}`);
  return spell;
}
