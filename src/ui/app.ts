import { RunController } from '../controller';
import { SPELLS, WEAPONS } from '../engine/content';
import { formatPace } from '../engine/damage';
import { GameSession } from '../engine/game';
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
};

export function mountApp(root: HTMLElement): void {
  root.innerHTML = template();
  const el = <T extends HTMLElement>(selector: string): T => {
    const node = root.querySelector<T>(selector);
    if (!node) throw new Error(`missing element: ${selector}`);
    return node;
  };

  const session = new GameSession();
  const sim = new SimPaceSource(11);
  const gps = new GpsPaceSource();
  const toast = el<HTMLParagraphElement>('#toast');
  const showToast = (message: string): void => {
    toast.textContent = message;
    toast.classList.add('show');
    window.setTimeout(() => toast.classList.remove('show'), 2600);
  };
  const controller = new RunController(session, sim, showToast);
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
  speedInput.addEventListener('input', syncSpeed);
  syncSpeed();

  const gpsButton = el<HTMLButtonElement>('#gps');
  let usingGps = false;
  gpsButton.addEventListener('click', () => {
    usingGps = !usingGps;
    controller.swapSource(usingGps ? gps : sim);
    el<HTMLDivElement>('#treadmill').hidden = usingGps;
    gpsButton.classList.toggle('active', usingGps);
    gpsButton.textContent = usingGps ? '📍 GPS' : '🏃 Treadmill';
    showToast(usingGps ? 'GPS mode — laps come from real distance.' : 'Treadmill mode.');
  });

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

  const startScreen = el<HTMLDivElement>('#start-screen');
  el<HTMLButtonElement>('#play').addEventListener('click', () => {
    startScreen.hidden = true;
    controller.start();
    scene.start();
    showToast('Jog to attack — the speed dial stands in for GPS indoors.');
  });

  const endScreen = el<HTMLDivElement>('#end-screen');
  el<HTMLButtonElement>('#again').addEventListener('click', () => window.location.reload());

  session.subscribe((snapshot) => {
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
    if (snapshot.status === 'victory' || snapshot.status === 'defeat') {
      endScreen.hidden = false;
      el('#end-title').textContent = snapshot.status === 'victory' ? 'YOU WIN' : 'DEFEATED';
      el('#end-detail').textContent =
        `${snapshot.stats.laps} laps · ${(snapshot.stats.totalDistanceM / 1000).toFixed(2)} km · ` +
        `${snapshot.stats.enemiesDefeated} enemies · ${snapshot.achievements.length} achievements`;
    }
  });

  session.onEvent((event) => {
    if (event.type === 'attack') speak(String(event.damage));
    if (event.type === 'enemyDefeated') speak('down');
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
    <p>Every lap is an attack. Jog to swing, sprint to hurt.</p>
    <button id="play" class="play">LET'S PLAY</button>
    <p class="hint">Indoors? The speed dial stands in for GPS. Outdoors, tap Treadmill to switch to GPS.</p>
  </div>

  <div id="end-screen" class="screen" hidden>
    <h1 id="end-title"></h1>
    <p id="end-detail"></p>
    <button id="again" class="play">RUN AGAIN</button>
  </div>

  <p id="toast"></p>

  <div id="controls">
    <div class="bar">
      <div class="icons" id="weapon-bar"></div>
      <div class="icons" id="spell-bar"></div>
      <div class="icons">
        <button id="gps" class="icon wide">🏃 Treadmill</button>
        <button id="voice" class="icon wide">🎙️ Off</button>
      </div>
    </div>
    <div id="treadmill">
      <input id="speed" type="range" min="0" max="22" step="0.5" value="11" aria-label="simulated speed" />
      <span id="speed-label"></span>
    </div>
  </div>
  `;
}
