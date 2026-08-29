# runhack — initial product spec

An RPG whose combat system is your running. Every lap is an attack, your pace is
the damage roll, and voice commands choose the weapon or spell. Three levels and
a final boss; achievements unlock spells.

## 1. Product goals

- Make a run feel like a fight you can win or lose, using data a phone already has.
- Reward two different real training behaviours: **surging** (fast laps) and
  **consistency** (unbroken streaks).
- Never require looking at the screen mid-lap: input is voice, output is audio.
- Be fair across fitness levels — a slow runner must be able to clear the boss.

Non-goals for v1: multiplayer, social feeds, route maps, gear economy, monetisation.

## 2. Core loop

```
run → lap threshold crossed → attack resolves → enemy HP drops
                            ↘ energy accrues → voice-cast spell arms next lap
enemy attack timer fires while the run is live → your HP drops if you stop
```

A lap is a **distance threshold** (400–600m by level), not geometric loop
detection: thresholds work identically on a track, a street route and a treadmill,
whereas loop detection breaks on all but the first.

## 3. Combat model

```
damage = weapon.baseDamage
       × clamp((baselinePace / lapPace) ^ weapon.paceScaling, 0.5, 2.5)
       × (1 + min(0.5, streakMinutes × 0.02))
       × spell.multiplier × (elementMatchesWeakness ? 1.5 : 1)
```

| Term | Design intent |
| --- | --- |
| `baselinePace` | EWMA of the runner's own completed laps. Pace is graded **relative to you**, so difficulty is personal rather than a fitness gate. |
| `paceScaling` | Per-weapon exponent: the weapon defines *how much* pace matters, so the loadout is a workout choice. |
| `clamp(0.5, 2.5)` | Floor keeps slow runners able to finish; ceiling stops a sprinter trivialising a level. |
| streak term | Rewards consistency, capped at +50% so it supplements pace instead of replacing it. |
| weakness | Gives voice-cast spells a tactical reason to exist beyond raw multipliers. |

Weapons (v1): Pacekeeper Hammer (26 base / 0.6 scaling — steady jog), Tempo Blade
(20 / 1.1 — balanced), Sprinter Daggers (13 / 2.0 — surges), Runic Staff
(17 / 1.0, arcane).

Spells (v1): Fireball (40 energy, ×2), Frost Lance (40, ×1.8), Arcane Smite
(60, ×2.6 — unlocked by achievement), Meteor (100, ×4 — unlocked by achievement).
Energy: +25 per lap, cap 100. An armed spell applies to the **next landed lap only**.

## 4. Progression

| Level | Lap | Enemies | Expected laps |
| --- | --- | --- | --- |
| 1 — Warmup Woods | 400m | Lactic Slime (50 HP), Shin Splint Wraith (90) | ~2 + ~4 |
| 2 — Hillclimb Ruins | 500m | Gradient Gargoyle (140), The Wall (190) | ~6 + ~8 |
| 3 — Threshold Spire | 600m | Tempo Hound (200), Cramp Lord (230) | ~8 + ~9 |
| Boss — The Final Kilometre | 400m | Chronarch, Keeper of Splits (320) | ~8 |

Enemy HP is tuned in *expected laps* at ~25 damage/lap, so a full run is a
deliberate session-length target rather than an arbitrary number. Enemies attack
on their own timer (45s at level 1 down to 22s at the boss), which is what makes
stopping cost something without punishing a short walk break.

## 5. Achievements / challenge mode

Achievements are the challenge layer and the unlock economy in one:

| Achievement | Condition | Unlocks |
| --- | --- | --- |
| First Blood | land one lap | — |
| Negative Split | a lap 15% faster than baseline | Arcane Smite |
| Long Hauler | 10 unbroken minutes | Meteor |
| Giant Slayer | 4 enemies in one run | — |

Because unlock conditions are pace- and duration-based rather than
progression-based, they read as training challenges rather than grind.

## 6. Voice

A **fixed keyword grammar**, not free-form intent parsing: the transcript comes
from a phone in a pocket, from someone out of breath, in wind. Recognised:
"cast fireball" / "fire", "frost lance" / "ice", "smite", "meteor",
"switch to daggers" / "hammer" / "sword" / "staff", and "status". A spell wins
over a weapon when a phrase mentions both. Unmatched input is discarded rather
than guessed at. Attacks and achievements are spoken back via speech synthesis.

## 7. Architecture

- `src/engine/` — pure logic (damage maths, content tables, session state). No DOM
  and no timers of its own: it is driven only by completed laps and clock ticks,
  which is why the balance is unit-testable without a browser or a run.
- `src/pace/` — `lapTracker` (distance → laps) plus two interchangeable
  `PaceSource`s: `gps` (accuracy / jitter / teleport filtering) and `sim`
  (treadmill dial, so the game is playable and demoable indoors).
- `src/voice/` — keyword parser (pure) and Web Speech wrappers.
- `src/controller.ts` — binds a pace source to a session, plus a 1s heartbeat so
  enemy timers and streak breaks still fire when the runner has stopped.
- `src/ui/` — `scene.ts` is a canvas battle scene (player left, enemy right) driven
  by engine snapshots and events; `app.ts` is the start screen ("LET'S PLAY") plus
  a slim action bar. There is deliberately no dashboard: HP, energy and lap
  progress are drawn into the scene, and the runner's stride is the read-out of
  whether movement is arriving.

The pace source is an interface precisely so GPS can be swapped mid-run and so
tests can drive laps synthetically.

## 7a. Presentation

One screen, no menus: **LET'S PLAY** drops straight into the fight. The player
character strides and swings only while real movement is arriving and idles the
moment you stop (with a "JOG TO ATTACK" prompt), so the animation itself tells
you whether the game is reading your run. Enemies float, lunge on their attack
timer, flash on hits and slump when defeated; damage numbers float off the target
and the screen shakes harder on a weakness hit.

## 8. Status

Built and playable in the browser: full combat model, all 3 levels + boss,
weapons, spells, energy, streaks, achievements and unlocks, GPS and treadmill
pace sources, voice commands, spoken feedback, and a 2D canvas battle scene with
a start screen and end screen. 40 unit tests cover the damage maths,
session/progression rules, animation events, lap detection, GPS filtering and the
parser.

## 9. Next steps

1. **Field-test the GPS path** on a real run — accuracy thresholds and lap timing
   are the only parts that can't be validated indoors.
2. **Persistence** (localStorage first): unlocked spells, achievements and a
   baseline pace that survives between runs; currently every run starts fresh.
3. **Background behaviour on mobile**: keep audio and geolocation alive with the
   screen off — likely the deciding factor for whether this ships as a PWA or
   needs a native shell.
4. **Balance pass with real traces**: replay recorded runs against the engine to
   check the boss lands at ~8 laps for a range of paces.
5. **Challenge mode as a first-class screen**: weekly targets, achievement list,
   and a defined loss state beyond running out of HP.
6. **Art pass**: the characters are drawn procedurally on canvas; sprite sheets
   (or an animated character rig) would carry the game feel much further.
7. **Heart rate as a second input** for effort-based (rather than pace-based)
   damage — makes hills fair.
