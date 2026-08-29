import { describe, expect, it } from 'vitest';

import { chaseTarget } from './scene';

describe('chaseTarget', () => {
  it('holds the gap open until the closing metres of the lap', () => {
    expect(chaseTarget(0, 400)).toBe(0);
    expect(chaseTarget(200, 400)).toBe(0);
    expect(chaseTarget(350, 400)).toBe(0);
    expect(chaseTarget(375, 400)).toBe(0.5);
    expect(chaseTarget(400, 400)).toBe(1);
  });

  it('closes over the whole lap when the lap is shorter than the window', () => {
    expect(chaseTarget(0, 20)).toBe(0);
    expect(chaseTarget(10, 20)).toBe(0.5);
    expect(chaseTarget(20, 20)).toBe(1);
  });

  it('stays in range for progress past the lap distance', () => {
    expect(chaseTarget(900, 400)).toBe(1);
    expect(chaseTarget(-5, 400)).toBe(0);
  });
});
