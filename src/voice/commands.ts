import { SPELLS, WEAPONS } from '../engine/content';

export type VoiceCommand =
  | { type: 'cast'; spellId: string }
  | { type: 'equip'; weaponId: string }
  | { type: 'status' };

/**
 * Deliberately a keyword grammar rather than free-form intent parsing: the
 * transcript arrives from a phone in a pocket, out of breath, in the wind.
 */
export function parseVoiceCommand(transcript: string): VoiceCommand | null {
  const text = transcript.toLowerCase().replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return null;

  if (/\b(status|report|how am i doing)\b/.test(text)) return { type: 'status' };

  for (const spell of SPELLS) {
    if (matchesAny(text, spell.aliases)) return { type: 'cast', spellId: spell.id };
  }
  for (const weapon of WEAPONS) {
    if (matchesAny(text, weapon.aliases)) return { type: 'equip', weaponId: weapon.id };
  }
  return null;
}

function matchesAny(text: string, aliases: string[]): boolean {
  return [...aliases]
    .sort((a, b) => b.length - a.length)
    .some((alias) => new RegExp(`\\b${alias}\\b`).test(text));
}
