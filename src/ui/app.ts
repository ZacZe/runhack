import { RunController } from '../controller';
import { SPELLS, WEAPONS } from '../engine/content';
import { BALANCE, formatPace } from '../engine/damage';
import { GameSession, type Snapshot } from '../engine/game';
import { GpsPaceSource } from '../pace/gps';
import { SimPaceSource } from '../pace/sim';
import { parseVoiceCommand } from '../voice/commands';
import { VoiceListener, speak, voiceSupported } from '../voice/speech';

export function mountApp(root: HTMLElement): void {
  const session = new GameSession();
  const sim = new SimPaceSource(11);
  const gps = new GpsPaceSource();
  const controller = new RunController(session, sim, (message) => setNotice(message));

  root.innerHTML = template();
  const el = <T extends HTMLElement>(selector: string): T => {
    const node = root.querySelector<T>(selector);
    if (!node) throw new Error(`missing element: ${selector}`);
    return node;
  };

  const notice = el<HTMLParagraphElement>('#notice');
  const setNotice = (message: string): void => {
    notice.textContent = message;
  };

  const weaponRow = el<HTMLDivElement>('#weapons');
  for (const weapon of WEAPONS) {
    const button = document.createElement('button');
    button.dataset.weapon = weapon.id;
    button.className = 'chip';
    button.innerHTML = `<strong>${weapon.name}</strong><span>${weapon.baseDamage} base · ×${weapon.paceScaling} pace</span>`;
    button.addEventListener('click', () => session.selectWeapon(weapon.id));
    weaponRow.append(button);
  }

  const spellRow = el<HTMLDivElement>('#spells');
  for (const spell of SPELLS) {
    const button = document.createElement('button');
    button.dataset.spell = spell.id;
    button.className = 'chip';
    button.innerHTML = `<strong>${spell.name}</strong><span>${spell.cost} energy · ×${spell.multiplier} ${spell.element}</span>`;
    button.addEventListener('click', () => session.armSpell(spell.id));
    spellRow.append(button);
  }

  const speedInput = el<HTMLInputElement>('#speed');
  const speedLabel = el<HTMLSpanElement>('#speed-label');
  const syncSpeed = (): void => {
    const kmh = Number(speedInput.value);
    sim.setSpeed(kmh);
    speedLabel.textContent = `${kmh.toFixed(1)} km/h · ${formatPace(3600 / kmh)}/km`;
  };
  speedInput.addEventListener('input', syncSpeed);
  syncSpeed();

  const startButton = el<HTMLButtonElement>('#start');
  startButton.addEventListener('click', () => {
    controller.start();
    startButton.disabled = true;
    setNotice('Run started. Treadmill mode is driving the pace — switch to GPS to run for real.');
  });

  const sourceSelect = el<HTMLSelectElement>('#source');
  sourceSelect.addEventListener('change', () => {
    const useGps = sourceSelect.value === 'gps';
    el<HTMLDivElement>('#sim-controls').hidden = useGps;
    controller.swapSource(useGps ? gps : sim);
    setNotice(useGps ? 'GPS mode: laps come from real distance.' : 'Treadmill mode.');
  });

  const voiceButton = el<HTMLButtonElement>('#voice');
  const listener = new VoiceListener((transcript) => {
    const command = parseVoiceCommand(transcript);
    setNotice(`heard “${transcript.trim()}”`);
    if (!command) return;
    if (command.type === 'cast' && session.armSpell(command.spellId)) {
      speak('armed');
    } else if (command.type === 'equip') {
      session.selectWeapon(command.weaponId);
      speak('equipped');
    } else if (command.type === 'status') {
      const s = session.snapshot();
      speak(`${s.enemy.name} at ${s.enemyHp} hit points. You are at ${s.playerHp}.`);
    }
  }, setNotice);
  let listening = false;
  voiceButton.disabled = !voiceSupported();
  voiceButton.addEventListener('click', () => {
    listening = !listening;
    if (listening) {
      listening = listener.start();
    } else {
      listener.stop();
    }
    voiceButton.textContent = listening ? 'Voice: on' : 'Voice: off';
    voiceButton.classList.toggle('active', listening);
  });

  let lastLog = 0;
  session.subscribe((snapshot) => {
    render(el, snapshot);
    for (const entry of snapshot.log.slice(lastLog)) {
      if (entry.kind === 'attack' || entry.kind === 'achievement') speak(entry.text);
    }
    lastLog = snapshot.log.length;
  });
}

function render(
  el: <T extends HTMLElement>(selector: string) => T,
  snapshot: Snapshot,
): void {
  el('#level').textContent = snapshot.level.name;
  el('#status').textContent = statusText(snapshot);
  el('#enemy-name').textContent = snapshot.enemy.name;
  el('#enemy-weakness').textContent = `weak to ${snapshot.enemy.weakTo.join(', ')}`;
  bar(el('#enemy-hp'), snapshot.enemyHp, snapshot.enemy.maxHp);
  el('#enemy-hp-text').textContent = `${snapshot.enemyHp} / ${snapshot.enemy.maxHp}`;
  bar(el('#player-hp'), snapshot.playerHp, snapshot.playerMaxHp);
  el('#player-hp-text').textContent = `${snapshot.playerHp} / ${snapshot.playerMaxHp}`;
  bar(el('#energy'), snapshot.energy, BALANCE.maxEnergy);
  el('#energy-text').textContent = `${Math.floor(snapshot.energy)} / ${BALANCE.maxEnergy}`;
  bar(el('#lap'), snapshot.lapProgressM, snapshot.level.lapDistanceM);
  el('#lap-text').textContent = `${Math.floor(snapshot.lapProgressM)} / ${snapshot.level.lapDistanceM} m`;
  el('#baseline').textContent = `${formatPace(snapshot.baselinePace)}/km`;
  el('#streak').textContent = `${Math.floor(snapshot.streakMs / 60_000)}m ${Math.floor(
    (snapshot.streakMs % 60_000) / 1000,
  )}s`;
  el('#laps').textContent = String(snapshot.stats.laps);
  el('#armed').textContent = snapshot.armedSpell ? snapshot.armedSpell.name : '—';

  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-weapon]')) {
    button.classList.toggle('active', button.dataset.weapon === snapshot.weapon.id);
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-spell]')) {
    const spell = SPELLS.find((s) => s.id === button.dataset.spell);
    if (!spell) continue;
    const locked = !snapshot.unlockedSpells.includes(spell.id);
    button.classList.toggle('locked', locked);
    button.disabled = locked || snapshot.energy < spell.cost;
    button.classList.toggle('active', snapshot.armedSpell?.id === spell.id);
  }

  el('#log').innerHTML = [...snapshot.log]
    .reverse()
    .map((entry) => `<li class="log-${entry.kind}">${entry.text}</li>`)
    .join('');
}

function statusText(snapshot: Snapshot): string {
  if (snapshot.status === 'idle') return 'tap start, then run';
  if (snapshot.status === 'victory') return `victory in ${snapshot.stats.laps} laps`;
  if (snapshot.status === 'defeat') return 'defeated — keep moving next time';
  return 'in combat';
}

function bar(node: HTMLElement, value: number, max: number): void {
  node.style.setProperty('--fill', `${Math.max(0, Math.min(100, (value / max) * 100))}%`);
}

function template(): string {
  return `
  <header>
    <h1>runhack</h1>
    <p class="tagline">every lap is an attack · <span id="level"></span> · <span id="status"></span></p>
    <p id="notice" class="notice"></p>
  </header>

  <section class="card enemy">
    <div class="row"><h2 id="enemy-name"></h2><span id="enemy-weakness" class="muted"></span></div>
    <div class="meter enemy-meter" id="enemy-hp"></div>
    <span class="muted" id="enemy-hp-text"></span>
  </section>

  <section class="card">
    <div class="grid">
      <div><span class="muted">Your HP</span><div class="meter" id="player-hp"></div><span class="muted" id="player-hp-text"></span></div>
      <div><span class="muted">Energy</span><div class="meter energy-meter" id="energy"></div><span class="muted" id="energy-text"></span></div>
      <div><span class="muted">Lap progress</span><div class="meter lap-meter" id="lap"></div><span class="muted" id="lap-text"></span></div>
    </div>
    <div class="stats">
      <span>baseline <b id="baseline"></b></span>
      <span>streak <b id="streak"></b></span>
      <span>laps <b id="laps"></b></span>
      <span>armed <b id="armed"></b></span>
    </div>
  </section>

  <section class="card">
    <h3>Weapons</h3>
    <div class="chips" id="weapons"></div>
    <h3>Spells</h3>
    <div class="chips" id="spells"></div>
  </section>

  <section class="card">
    <div class="row">
      <button id="start" class="primary">Start run</button>
      <select id="source" aria-label="pace source">
        <option value="sim">Treadmill (simulated)</option>
        <option value="gps">GPS (outdoor)</option>
      </select>
      <button id="voice">Voice: off</button>
    </div>
    <div id="sim-controls">
      <label for="speed">Simulated speed <span id="speed-label" class="muted"></span></label>
      <input id="speed" type="range" min="0" max="22" step="0.5" value="11" />
    </div>
  </section>

  <ul id="log" class="log"></ul>
  `;
}
