import { RunController } from '../controller';
import { ACHIEVEMENTS, SPELLS, WEAPONS } from '../engine/content';
import { formatPace } from '../engine/damage';
import { GameSession } from '../engine/game';
import { probeGps } from '../pace/autoSource';
import { GpsPaceSource } from '../pace/gps';
import { SimPaceSource } from '../pace/sim';
import { parseVoiceCommand } from '../voice/commands';
import { VoiceListener, speak, voiceSupported } from '../voice/speech';
import { BattleScene } from './scene';

const WEAPON_ICONS: Record<string, string> = {
  hammer: '🔨',
  sword: '🗡️',
  daggers: '🔪',
  staff: '🪄',
};

const SPELL_ICONS: Record<string, string> = {
  fireball: '🔥',
  frost: '❄️',
  smite: '⚡',
  meteor: '☄️',
  tempest: '🌩️',
  quake: '🌋',
};

/** Slider zero means "follow the level" rather than a zero-metre lap. */
const FOLLOW_LEVEL = 0;

export function mountApp(root: HTMLElement): void {
  root.innerHTML = template();
  const el = <T extends HTMLElement>(selector: string): T => {
    const node = root.querySelector<T>(selector);
    if (!node) throw new Error(`missing element: ${selector}`);
    return node;
  };

  const session = new GameSession();
  const sim = new SimPaceSource(0);
  const gps = new GpsPaceSource();
  const toast = el<HTMLParagraphElement>('#toast');
  let toastTimer: number | null = null;
  const showToast = (message: string): void => {
    if (toastTimer !== null) window.clearTimeout(toastTimer);
    toast.textContent = message;
    toast.classList.add('show');
    toastTimer = window.setTimeout(() => {
      toast.classList.remove('show');
      toastTimer = null;
    }, 2600);
  };
  let onSourceError = showToast;
  const controller = new RunController(session, sim, (message) => onSourceError(message));
  const scene = new BattleScene(el<HTMLCanvasElement>('#stage'), session);

  const weaponBar = el<HTMLDivElement>('#weapon-bar');
  for (const weapon of WEAPONS) {
    weaponBar.append(
      iconButton(WEAPON_ICONS[weapon.id] ?? '⚔️', weapon.name, 'weapon', weapon.id, () =>
        session.selectWeapon(weapon.id),
      ),
    );
  }
  const spellBar = el<HTMLDivElement>('#spell-bar');
  for (const spell of SPELLS) {
    spellBar.append(
      iconButton(SPELL_ICONS[spell.id] ?? '✨', spell.name, 'spell', spell.id, () =>
        session.armSpell(spell.id),
      ),
    );
  }

  const speedInput = el<HTMLInputElement>('#speed');
  const speedLabel = el<HTMLSpanElement>('#speed-label');
  const syncSpeed = (): void => {
    const kmh = Number(speedInput.value);
    sim.setSpeed(kmh);
    speedLabel.textContent = kmh > 0 ? `${kmh.toFixed(1)} km/h · ${formatPace(3600 / kmh)}/km` : 'stopped';
  };
  syncSpeed();

  // The runner never picks a source, and the dial is never taken away on a
  // promise: a phone indoors can hold a flawless fix and still measure nothing,
  // so the dial stays within reach until GPS has produced real distance. It also
  // outranks GPS the moment it is touched, since only the runner knows they are
  // on a treadmill.
  const treadmill = el<HTMLDivElement>('#treadmill');
  let usingGps = false;
  let dialChosen = false;
  const useTreadmill = (reason?: string): void => {
    usingGps = false;
    treadmill.hidden = false;
    if (reason) showToast(`${reason} — use the speed dial to run indoors.`);
  };
  speedInput.addEventListener('input', () => {
    syncSpeed();
    if (Number(speedInput.value) === 0) return;
    dialChosen = true;
    if (!usingGps) return;
    controller.swapSource(sim);
    useTreadmill();
    showToast('Running the dial — GPS is out of it.');
  });
  const useGps = async (): Promise<void> => {
    showToast('Looking for GPS…');
    const probe = await probeGps(navigator.geolocation);
    // The probe can run the better part of ten seconds, so a runner who spun the
    // dial meanwhile has already answered the question it went out to ask.
    if (dialChosen) return;
    if (!probe.usable) {
      useTreadmill(probe.reason);
      return;
    }
    usingGps = true;
    controller.swapSource(gps);
    // A fix can be lost long after it was granted — a tunnel, a revoked
    // permission, fixes too coarse to measure with — so the dial takes over
    // rather than the run going quietly dead.
    onSourceError = (message) => {
      onSourceError = showToast;
      controller.swapSource(sim);
      useTreadmill(message);
    };
    showToast('GPS found you — start running, or use the dial if you are indoors.');
  };

  const voiceButton = el<HTMLButtonElement>('#voice');
  const listener = new VoiceListener((transcript) => {
    const command = parseVoiceCommand(transcript);
    if (!command) return;
    if (command.type === 'cast') {
      if (session.armSpell(command.spellId)) speak('armed');
    } else if (command.type === 'equip') {
      session.selectWeapon(command.weaponId);
      speak('equipped');
    } else {
      const s = session.snapshot();
      speak(`${s.enemy.name} at ${s.enemyHp}. You are at ${s.playerHp}.`);
    }
  }, showToast);
  let listening = false;
  voiceButton.disabled = !voiceSupported();
  voiceButton.addEventListener('click', () => {
    if (listening) {
      listener.stop();
      listening = false;
    } else {
      listening = listener.start();
    }
    voiceButton.classList.toggle('active', listening);
    voiceButton.textContent = listening ? '🎙️ On' : '🎙️ Off';
  });

  // Both distances are the runner's to set, before the run and during it: the
  // loop they happen to be on is not something the game can guess.
  const attackInput = el<HTMLInputElement>('#attack-distance');
  const attackLabel = el<HTMLSpanElement>('#attack-distance-label');
  const sprintInput = el<HTMLInputElement>('#sprint-distance');
  const sprintLabel = el<HTMLSpanElement>('#sprint-distance-label');
  const thresholdInput = el<HTMLInputElement>('#speed-threshold');
  const thresholdLabel = el<HTMLSpanElement>('#speed-threshold-label');
  const distanceLabels = root.querySelectorAll<HTMLElement>('[data-distance-label]');
  const chosenAttackM = (): number | null => {
    const value = Number(attackInput.value);
    return value === FOLLOW_LEVEL ? null : value;
  };
  const chosenSprintM = (): number | null => {
    const value = Number(sprintInput.value);
    return value === FOLLOW_LEVEL ? null : value;
  };
  const labelDistances = (): void => {
    const attack = chosenAttackM();
    const sprint = chosenSprintM();
    attackLabel.textContent = attack === null ? 'follows the level' : `${attack} m`;
    sprintLabel.textContent =
      sprint === null ? 'same as the attack distance' : `${sprint} m`;
    thresholdLabel.textContent = `${Number(thresholdInput.value)} km/h`;
    const text = attack === null ? 'per level' : `${attack} m`;
    for (const label of distanceLabels) label.textContent = `📏 Lap: ${text}`;
  };
  const applyDistances = (): void => {
    session.setLapDistance(chosenAttackM());
    session.setSprintDistance(chosenSprintM());
    session.setSpeedThreshold(Number(thresholdInput.value));
  };
  // Labels track the drag; the session hears about it once the runner lets go,
  // so a swipe across the slider is one change of plan rather than forty.
  for (const input of [attackInput, sprintInput, thresholdInput]) {
    input.addEventListener('input', labelDistances);
    input.addEventListener('change', () => {
      applyDistances();
      labelDistances();
    });
  }
  labelDistances();

  const panel = el<HTMLDivElement>('#panel');
  const achievementList = el<HTMLUListElement>('#achievement-list');
  for (const achievement of ACHIEVEMENTS) {
    const item = document.createElement('li');
    item.dataset.achievement = achievement.id;
    item.innerHTML =
      `<b>${achievement.name}</b><span>${achievement.description}</span>` +
      (achievement.unlocksSpell
        ? `<em>unlocks ${SPELLS.find((s) => s.id === achievement.unlocksSpell)?.name ?? ''}</em>`
        : '');
    achievementList.append(item);
  }
  const togglePanel = (open: boolean): void => {
    panel.hidden = !open;
  };
  for (const opener of root.querySelectorAll<HTMLButtonElement>('[data-open-panel]')) {
    opener.addEventListener('click', () => togglePanel(true));
  }
  el<HTMLButtonElement>('#panel-close').addEventListener('click', () => togglePanel(false));
  panel.addEventListener('click', (event) => {
    if (event.target === panel) togglePanel(false);
  });

  // Setting the distances is its own step between the title and the run: they
  // decide how far every attack is, so they are asked for before the clock
  // starts and reachable from the bar once it has.
  const startScreen = el<HTMLDivElement>('#start-screen');
  const setupScreen = el<HTMLDivElement>('#setup-screen');
  const setupDone = el<HTMLButtonElement>('#setup-done');
  const hud = el<HTMLDivElement>('#hud');
  let started = false;
  el<HTMLButtonElement>('#play').addEventListener('click', () => {
    startScreen.hidden = true;
    setupScreen.hidden = false;
  });
  for (const opener of root.querySelectorAll<HTMLButtonElement>('[data-open-setup]')) {
    opener.addEventListener('click', () => {
      setupScreen.hidden = false;
      setupDone.textContent = started ? 'BACK TO THE RUN' : "LET'S RUN";
    });
  }
  setupDone.addEventListener('click', () => {
    setupScreen.hidden = true;
    if (started) return;
    // The sliders show a distance whether or not they were touched, so the run
    // starts on what they read rather than on the levels' own laps.
    applyDistances();
    started = true;
    hud.hidden = false;
    setupDone.textContent = 'BACK TO THE RUN';
    controller.start();
    scene.start();
    void useGps();
  });

  const sprintCall = el<HTMLDivElement>('#sprint-call');
  const sprintDetail = el<HTMLSpanElement>('#sprint-detail');
  // A claimed reward is worth more when the runner picks the moment, so it waits
  // on screen instead of firing itself the instant the achievement lands.
  const reward = el<HTMLButtonElement>('#reward');
  reward.addEventListener('click', () => {
    if (!session.claimReward(Date.now())) return;
    showToast('Surge! Harder hits for the next stretch, and some HP back.');
    speak('surge');
  });

  const lapFill = el<HTMLDivElement>('#lap-fill');
  const lapText = el<HTMLSpanElement>('#lap-text');
  const nextAchievement = el<HTMLDivElement>('#next-achievement');
  const nextFill = el<HTMLDivElement>('#next-achievement-fill');
  const nextName = el<HTMLSpanElement>('#next-achievement-name');
  const powerup = el<HTMLDivElement>('#powerup');
  const speedRead = el<HTMLDivElement>('#speed-read');

  const endScreen = el<HTMLDivElement>('#end-screen');
  el<HTMLButtonElement>('#again').addEventListener('click', () => window.location.reload());

  let ended = false;
  session.subscribe((snapshot) => {
    // Distance from GPS is the only proof it can measure this run, and the point
    // at which the dial has nothing left to offer.
    if (usingGps && snapshot.moving) treadmill.hidden = true;
    for (const button of root.querySelectorAll<HTMLButtonElement>('[data-weapon]')) {
      button.classList.toggle('active', button.dataset.weapon === snapshot.weapon.id);
    }
    for (const button of root.querySelectorAll<HTMLButtonElement>('[data-spell]')) {
      const spell = SPELLS.find((s) => s.id === button.dataset.spell);
      if (!spell) continue;
      const locked = !snapshot.unlockedSpells.includes(spell.id);
      button.disabled = locked || snapshot.energy < spell.cost;
      button.classList.toggle('locked', locked);
      button.classList.toggle('active', snapshot.armedSpell?.id === spell.id);
    }
    // The bar is the answer to "how much further until something happens":
    // it fills with the ground covered and the attack lands when it is full.
    const lapFraction = Math.min(1, snapshot.lapProgressM / snapshot.lapDistanceM);
    lapFill.style.width = `${(lapFraction * 100).toFixed(1)}%`;
    lapFill.classList.toggle('sprinting', snapshot.sprint !== null);
    lapText.textContent =
      `${Math.floor(snapshot.lapProgressM)} / ${Math.round(snapshot.lapDistanceM)} m` +
      (snapshot.sprint === null ? '' : ' · SPRINT');

    const next = snapshot.nextAchievement;
    nextAchievement.hidden = next === null;
    if (next !== null) {
      nextName.textContent = next.name;
      nextAchievement.title = next.description;
      nextFill.style.width = `${Math.round(next.progress * 100)}%`;
    }

    powerup.hidden = snapshot.surgeMsLeft === 0;
    powerup.textContent = `⚡ SURGE ${Math.ceil(snapshot.surgeMsLeft / 1000)}s`;

    // Speed is the defence, so it is on screen with the line it has to clear.
    const safe = snapshot.speedKmh >= snapshot.speedThresholdKmh;
    speedRead.classList.toggle('exposed', snapshot.status === 'running' && !safe);
    speedRead.textContent =
      `${snapshot.speedKmh.toFixed(1)} km/h` +
      (safe ? ' · out of reach' : ` · hold ${snapshot.speedThresholdKmh}`);

    sprintCall.hidden = snapshot.sprint === null;
    if (snapshot.sprint) {
      sprintDetail.textContent =
        `${Math.round(snapshot.sprint.distanceM)} m under ` +
        `${formatPace(snapshot.sprint.targetPaceSecPerKm)}/km for a critical hit`;
    }
    reward.hidden = snapshot.unclaimedRewards === 0;
    reward.textContent =
      snapshot.unclaimedRewards > 1
        ? `🎁 CLAIM REWARD (${snapshot.unclaimedRewards})`
        : '🎁 CLAIM REWARD';
    for (const item of achievementList.querySelectorAll<HTMLLIElement>('[data-achievement]')) {
      item.classList.toggle('earned', snapshot.achievements.includes(item.dataset.achievement!));
    }
    if (!ended && (snapshot.status === 'victory' || snapshot.status === 'defeat')) {
      ended = true;
      endScreen.hidden = false;
      controller.stop();
      // The scene keeps drawing just long enough to finish its closing banner.
      window.setTimeout(() => scene.destroy(), 2500);
      el('#end-title').textContent = snapshot.status === 'victory' ? 'YOU WIN' : 'DEFEATED';
      el('#end-detail').textContent =
        `${snapshot.stats.laps} laps · ${(snapshot.stats.totalDistanceM / 1000).toFixed(2)} km · ` +
        `${snapshot.stats.enemiesDefeated} enemies · ${snapshot.achievements.length} achievements`;
    }
  });

  session.onEvent((event) => {
    if (event.type === 'attack') {
      speak(event.crit ? `critical ${event.damage}` : String(event.damage));
    }
    if (event.type === 'sprintCalled') {
      showToast(
        `SPRINT! ${Math.round(event.distanceM)} m under ` +
          `${formatPace(event.targetPaceSecPerKm)}/km lands a critical.`,
      );
      speak('sprint');
    }
    if (event.type === 'sprintMissed') showToast('Sprint missed — next one soon.');
    if (event.type === 'enemyDefeated') speak('down');
    if (event.type === 'achievement') {
      speak(
        event.unlockedSpellName
          ? `${event.name} unlocked ${event.unlockedSpellName}`
          : `${event.name} unlocked`,
      );
      showToast(
        event.unlockedSpellName
          ? `${event.name} — ${event.unlockedSpellName} unlocked`
          : `${event.name} unlocked`,
      );
    }
  });
}

function iconButton(
  icon: string,
  label: string,
  kind: 'weapon' | 'spell',
  id: string,
  onClick: () => void,
): HTMLButtonElement {
  const button = document.createElement('button');
  button.className = 'icon';
  button.dataset[kind] = id;
  button.title = label;
  button.setAttribute('aria-label', label);
  button.textContent = icon;
  button.addEventListener('click', onClick);
  return button;
}

function template(): string {
  return `
  <canvas id="stage"></canvas>

  <div id="start-screen" class="screen">
    <h1>runhack</h1>
    <p>Every lap is an attack. Stand still and nothing moves; run and you close the gap.</p>
    <button id="play" class="play">LET'S PLAY</button>
    <p class="hint">Outdoors your laps come from GPS. Indoors, the speed dial stands in for it.</p>
  </div>

  <div id="setup-screen" class="screen" hidden>
    <h2 class="setup-title">SET YOUR RUN</h2>
    <div class="setting">
      <label for="attack-distance">Attack distance <span id="attack-distance-label"></span></label>
      <input id="attack-distance" type="range" min="0" max="2000" step="50" value="400" />
      <p class="hint">Ground you cover to land one attack. Zero follows each level's own lap.</p>
    </div>
    <div class="setting">
      <label for="sprint-distance">Sprint distance <span id="sprint-distance-label"></span></label>
      <input id="sprint-distance" type="range" min="0" max="1000" step="50" value="0" />
      <p class="hint">When the game calls a sprint, this is the stretch you run flat out for a critical hit.</p>
    </div>
    <div class="setting">
      <label for="speed-threshold">Enemy strikes below <span id="speed-threshold-label"></span></label>
      <input id="speed-threshold" type="range" min="1" max="16" step="0.5" value="6" />
      <p class="hint">Hold this speed and its blows miss. Stop dead and they land as criticals.</p>
    </div>
    <button id="setup-done" class="play">LET'S RUN</button>
  </div>

  <div id="panel" class="panel" hidden>
    <div class="panel-card">
      <h2>Achievements</h2>
      <ul class="achievements" id="achievement-list"></ul>
      <button id="panel-close" class="chip wide">CLOSE</button>
    </div>
  </div>

  <div id="end-screen" class="screen" hidden>
    <h1 id="end-title"></h1>
    <p id="end-detail"></p>
    <button id="again" class="play">RUN AGAIN</button>
    <button class="chip wide" data-open-panel>ACHIEVEMENTS</button>
  </div>

  <div id="sprint-call" hidden>
    <b>SPRINT</b>
    <span id="sprint-detail"></span>
  </div>

  <button id="reward" hidden></button>

  <p id="toast"></p>

  <div id="controls">
    <div id="hud" hidden>
      <div id="lap-bar">
        <div id="lap-fill"></div>
        <span id="lap-text"></span>
      </div>
      <div id="hud-row">
        <div id="next-achievement" hidden>
          <span id="next-achievement-name"></span>
          <div id="next-achievement-track"><div id="next-achievement-fill"></div></div>
        </div>
        <div id="speed-read"></div>
        <div id="powerup" hidden></div>
      </div>
    </div>
    <div class="bar">
      <div class="icons" id="weapon-bar"></div>
      <div class="icons" id="spell-bar"></div>
      <div class="icons">
        <button id="voice" class="icon wide">🎙️ Off</button>
        <button class="icon wide" data-open-setup data-distance-label></button>
        <button class="icon wide" data-open-panel>🏅</button>
      </div>
    </div>
    <div id="treadmill">
      <input id="speed" type="range" min="0" max="22" step="0.5" value="0" aria-label="simulated speed" />
      <span id="speed-label"></span>
    </div>
  </div>
  `;
}
