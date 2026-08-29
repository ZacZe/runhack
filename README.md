# runhack

An RPG where the combat system is your running. Every lap is an attack, your pace
is the damage roll, and voice commands pick the weapon or spell.

## Playing

```bash
npm install
npm run dev      # open the printed URL
npm test         # engine + parser unit tests
npm run build    # typecheck + production build
```

Press **Start run**. Treadmill mode is on by default, so the speed slider stands
in for GPS — you can play the whole game at a desk. Switch the source to **GPS**
to run for real (needs HTTPS or localhost for the geolocation permission).

Turn on **Voice** and say things like "cast fireball", "switch to daggers", or
"status". Recognition uses a fixed keyword grammar, not free-form speech, and
hits/achievements are read back out loud so you don't need to look at the phone.

## How the numbers work

```
damage = weapon.baseDamage
       × clamp((baselinePace / lapPace) ^ weapon.paceScaling, 0.5, 2.5)
       × (1 + min(0.5, streakMinutes × 0.02))
       × spell.multiplier × (weakness ? 1.5 : 1)
```

- **Pace is relative to your own rolling baseline**, not an absolute speed, so
  the difficulty curve is personal instead of a fitness gate. The baseline is an
  exponentially weighted average of your completed laps.
- **Weapons differ in pace curve, not just base damage.** The hammer is high
  base / low scaling (rewards a steady jog); the daggers are low base / steep
  scaling (rewards surges). Loadout choice is effectively a workout choice.
- **Streaks** grow while you keep moving and reset after 30s of no progress.
- **Enemies attack on a timer** while the run is live, so stopping costs HP —
  laps are the only way to fight back.
- **Enemy HP is tuned in expected laps**: level 1 mobs die in ~2, the boss in ~8.
- **Achievements unlock spells** (a fast lap unlocks Arcane Smite, 10 unbroken
  minutes unlock Meteor), which is the challenge-mode hook.

## Layout

- `src/engine/` — pure game logic: damage maths, content tables, session state.
  No DOM, no timers of its own; it is driven entirely by completed laps and ticks.
- `src/pace/` — lap detection (`lapTracker`) and the two pace sources: GPS
  (`gps`, with accuracy/jitter/teleport filtering) and treadmill (`sim`).
- `src/voice/` — keyword command parser and the Web Speech wrappers.
- `src/controller.ts` — glues a pace source to a game session.
- `src/ui/` — rendering and controls.

Laps are distance-threshold based (400–600m depending on level) rather than
geometric loop detection, which keeps it working on a track, a street route and
a treadmill alike.

## Not built yet

Persistence between runs, difficulty selection, a real challenge mode with its
own leaderboard, background audio on mobile, and heart-rate as a second input.
