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

/** `null` means "use each level's own lap distance". */
const LAP_DISTANCES: Array<number | null> = [null, 100, 200, 400, 800, 1600];

export function mountApp(root: HTMLElement): void {
  root.innerHTML = template();
  const el = <T extends HTMLElement>(selector: string): T => {
    const node = root.querySelector<T>(selector);
    if (!node) throw new Error(`missing element: ${selector}`);
    return node;
  };

  const session = new GameSession({});
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

  // Lap distance and achievements share one slide-up panel, reachable from the
  // start screen and mid-run.
  const panel = el<HTMLDivElement>('#panel');
  const distanceChips = el<HTMLDivElement>('#distance-chips');
  const distanceLabels = root.querySelectorAll<HTMLElement>('[data-distance-label]');
  let lapDistanceM: number | null = null;
  const syncDistance = (): void => {
    session.setLapDistance(lapDistanceM);
    for (const chip of distanceChips.querySelectorAll<HTMLButtonElement>('button')) {
      chip.classList.toggle('active', chip.dataset.distance === String(lapDistanceM));
    }
    const text = lapDistanceM === null ? 'per level' : `${lapDistanceM} m`;
    for (const label of distanceLabels) label.textContent = `📏 Lap: ${text}`;
  };
  for (const option of LAP_DISTANCES) {
    const chip = document.createElement('button');
    chip.className = 'chip';
    chip.dataset.distance = String(option);
    chip.textContent = option === null ? 'Per level' : `${option} m`;
    chip.addEventListener('click', () => {
      lapDistanceM = option;
      syncDistance();
    });
    distanceChips.append(chip);
  }
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
  syncDistance();

  const startScreen = el<HTMLDivElement>('#start-screen');
  el<HTMLButtonElement>('#play').addEventListener('click', () => {
    startScreen.hidden = true;
    togglePanel(false);
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
    <button class="chip wide" data-open-panel data-distance-label></button>
    <p class="hint">Outdoors your laps come from GPS. Indoors, the speed dial stands in for it.</p>
  </div>

  <div id="panel" class="panel" hidden>
    <div class="panel-card">
      <h2>Lap distance</h2>
      <p class="hint">Metres of running that land one attack. Short laps suit a treadmill or a small block.</p>
      <div class="chips" id="distance-chips"></div>
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
    <div class="bar">
      <div class="icons" id="weapon-bar"></div>
      <div class="icons" id="spell-bar"></div>
      <div class="icons">
        <button id="voice" class="icon wide">🎙️ Off</button>
        <button class="icon wide" data-open-panel data-distance-label></button>
      </div>
    </div>
    <div id="treadmill">
      <input id="speed" type="range" min="0" max="22" step="0.5" value="0" aria-label="simulated speed" />
      <span id="speed-label"></span>
    </div>
  </div>
  `;
}
