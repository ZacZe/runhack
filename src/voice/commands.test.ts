import { describe, expect, it } from 'vitest';
import { parseVoiceCommand } from './commands';

describe('parseVoiceCommand', () => {
  it('picks spells out of a natural phrase', () => {
    expect(parseVoiceCommand('cast fireball now!')).toEqual({ type: 'cast', spellId: 'fireball' });
    expect(parseVoiceCommand('FROST LANCE')).toEqual({ type: 'cast', spellId: 'frost' });
  });

  it('picks weapons out of a natural phrase', () => {
    expect(parseVoiceCommand('switch to the daggers')).toEqual({
      type: 'equip',
      weaponId: 'daggers',
    });
    expect(parseVoiceCommand('give me that hammer')).toEqual({
      type: 'equip',
      weaponId: 'hammer',
    });
  });

  it('prefers a spell when a phrase mentions both', () => {
    expect(parseVoiceCommand('fireball with the sword')).toEqual({
      type: 'cast',
      spellId: 'fireball',
    });
  });

  it('handles status requests', () => {
    expect(parseVoiceCommand('status')).toEqual({ type: 'status' });
  });

  it('returns null for noise instead of guessing', () => {
    expect(parseVoiceCommand('')).toBeNull();
    expect(parseVoiceCommand('...uh, hnnng')).toBeNull();
    expect(parseVoiceCommand('firefighter')).toBeNull();
  });
});
