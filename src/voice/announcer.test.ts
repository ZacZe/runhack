import { describe, expect, it } from 'vitest';
import {
  ANNOUNCEMENTS,
  Announcer,
  COMMENTARY_QUIET_MS,
  type AnnouncementKind,
} from './announcer';

const KINDS = Object.keys(ANNOUNCEMENTS) as AnnouncementKind[];

describe('announcements', () => {
  it('has at least three distinct phrases for every kind of thing', () => {
    for (const kind of KINDS) {
      const lines = ANNOUNCEMENTS[kind];
      expect(lines.length, kind).toBeGreaterThanOrEqual(3);
      expect(new Set(lines).size, kind).toBe(lines.length);
    }
  });

  it('names the monster that approaches', () => {
    for (const line of ANNOUNCEMENTS.monsterApproaches) {
      expect(line).toContain('{name}');
    }
    const announcer = new Announcer(() => 0);
    expect(announcer.line('monsterApproaches', 0, 'Gravel Ghoul')).toContain('Gravel Ghoul');
  });
});

describe('Announcer', () => {
  it('never says the same line twice in a row', () => {
    // A random pick that always lands on the same index would repeat itself;
    // the announcer steps past its own last line instead.
    const announcer = new Announcer(() => 0);
    const first = announcer.line('playerAttack', 0);
    const second = announcer.line('playerAttack', 0);
    const third = announcer.line('playerAttack', 0);
    expect(first).not.toBe(second);
    expect(second).not.toBe(third);
  });

  it('keeps the running commentary quiet between lines', () => {
    const announcer = new Announcer(() => 0);
    expect(announcer.line('fallingBack', 0)).not.toBeNull();
    // Any commentary inside the quiet window stays unsaid, even another kind.
    expect(announcer.line('stopped', COMMENTARY_QUIET_MS - 1)).toBeNull();
    expect(announcer.line('holdingPace', COMMENTARY_QUIET_MS)).not.toBeNull();
  });

  it('lets the moments through regardless of the commentary window', () => {
    const announcer = new Announcer(() => 0);
    expect(announcer.line('fallingBack', 0)).not.toBeNull();
    expect(announcer.line('enemyHit', 1)).not.toBeNull();
    expect(announcer.line('sprintCalled', 2)).not.toBeNull();
  });
});
