import type { Enemy } from '../engine/types';
import type { GameSession, Snapshot } from '../engine/game';

const W = 800;
const H = 450;
const GROUND_Y = 340;

interface Floater {
  text: string;
  x: number;
  y: number;
  ageMs: number;
  color: string;
  scale: number;
}

/** How long a defeated enemy stays on screen before its replacement walks in. */
const DEATH_HOLD_MS = 1100;
/** Time allowed for the closing banner to play before the loop stops. */
const END_HOLD_MS = 2000;
/** Where the runner waits with a fresh lap, and how close a full lap brings him. */
const PLAYER_HOME_X = W * 0.18;
const PLAYER_CONTACT_X = W * 0.52;
const ENEMY_HOME_X = W * 0.74;
/** How far the enemy breaks away in the sprint that follows a hit. */
const ENEMY_ESCAPE_X = 130;
/** Long enough to read as a sprint, short enough to still feel chaseable. */
const ESCAPE_MS = 1500;
/**
 * The chase lags the lap by about this long, so the runner accelerates and
 * drifts back instead of being teleported by every sample.
 */
const CHASE_LAG_MS = 260;
/** Metres of a lap over which the runner reels the enemy in. */
const CHASE_WINDOW_M = 50;

/**
 * Canvas battle scene: the player on the left, the enemy on the right, and no
 * dashboard. The runner only strides and swings while real movement is coming
 * in, so the picture is a direct read-out of whether you are jogging.
 */
export class BattleScene {
  private readonly ctx: CanvasRenderingContext2D;
  private snapshot: Snapshot;
  private frame: number | null = null;
  private lastMs = 0;
  private runPhase = 0;
  private groundOffset = 0;
  private playerSwing = 0;
  private enemySwing = 0;
  private playerFlash = 0;
  private enemyFlash = 0;
  /** 0 with a fresh lap, 1 in the enemy's face. Follows lap progress. */
  private chase = 0;
  /** Counts down through the enemy's break-away after a hit. */
  private escape = 0;
  private shake = 0;
  private banner: { text: string; ageMs: number } | null = null;
  private floaters: Floater[] = [];
  private unsubscribe: Array<() => void> = [];
  /**
   * The enemy currently on screen, which lags the snapshot while a defeated one
   * plays out its death — otherwise its replacement would inherit the flash and
   * the damage number at full health.
   */
  private shownEnemy: { enemy: Enemy; hp: number };
  private deathHoldMs = 0;
  private endHoldMs = END_HOLD_MS;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    session: GameSession,
  ) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas 2d context unavailable');
    this.ctx = ctx;
    this.snapshot = session.snapshot();
    this.shownEnemy = { enemy: this.snapshot.enemy, hp: this.snapshot.enemyHp };

    this.unsubscribe.push(
      session.subscribe((snapshot) => {
        this.snapshot = snapshot;
        if (this.deathHoldMs <= 0) this.showEnemy(snapshot.enemy, snapshot.enemyHp);
      }),
      session.onEvent((event) => {
        switch (event.type) {
          case 'attack':
            this.playerSwing = 1;
            this.enemyFlash = 1;
            this.escape = 1;
            // The lap has already reset by the time this arrives, and a coarse
            // sample can cross the whole closing stretch at once, so the hit
            // itself puts the runner in reach; the chase then eases back out.
            this.chase = 1;
            this.shake = event.crit ? 18 : event.weakness ? 12 : 7;
            this.floaters.push({
              text: `-${event.damage}${event.crit ? ' CRIT!' : event.weakness ? '!' : ''}`,
              x: this.enemyX(),
              y: GROUND_Y - 120,
              ageMs: 0,
              color: event.crit ? '#ff5f6d' : event.spellName ? '#ffd166' : '#ffffff',
              scale: event.crit ? 1.8 : event.weakness ? 1.5 : 1.1,
            });
            if (event.crit) this.setBanner('CRITICAL!');
            else if (event.spellName) this.setBanner(event.spellName);
            break;
          case 'enemyHit':
            this.enemySwing = 1;
            this.playerFlash = 1;
            this.shake = 5;
            this.floaters.push({
              text: `-${event.damage}`,
              x: this.playerX(),
              y: GROUND_Y - 110,
              ageMs: 0,
              color: '#f87171',
              scale: 1,
            });
            break;
          case 'sprintCalled':
            this.setBanner('SPRINT!');
            break;
          case 'rewardClaimed':
            this.setBanner('SURGE!');
            break;
          case 'enemyDefeated':
            this.shownEnemy = { enemy: this.shownEnemy.enemy, hp: 0 };
            this.deathHoldMs = DEATH_HOLD_MS;
            this.setBanner('DOWN!');
            break;
          case 'achievement':
            this.setBanner(
              event.unlockedSpellName
                ? `${event.name} → ${event.unlockedSpellName}`
                : event.name,
            );
            break;
          case 'levelStart':
            this.setBanner(event.levelName);
            break;
          case 'victory':
            this.setBanner('YOU WIN');
            break;
          case 'defeat':
            this.setBanner('DEFEATED');
            break;
        }
      }),
    );
  }

  start(): void {
    if (this.frame !== null) return;
    this.resize();
    window.addEventListener('resize', this.resize);
    const loop = (nowMs: number): void => {
      const dt = this.lastMs === 0 ? 16 : Math.min(64, nowMs - this.lastMs);
      this.lastMs = nowMs;
      this.update(dt);
      this.draw();
      // The run is over and the closing banner has played: nothing left to move.
      if (this.endHoldMs <= 0) {
        this.frame = null;
        return;
      }
      this.frame = requestAnimationFrame(loop);
    };
    this.frame = requestAnimationFrame(loop);
  }

  destroy(): void {
    if (this.frame !== null) {
      cancelAnimationFrame(this.frame);
      this.frame = null;
    }
    window.removeEventListener('resize', this.resize);
    for (const off of this.unsubscribe) off();
    this.unsubscribe = [];
  }

  private readonly resize = (): void => {
    const ratio = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.round(rect.width * ratio);
    this.canvas.height = Math.round(rect.height * ratio);
  };

  private showEnemy(enemy: Enemy, hp: number): void {
    // A replacement walks on at home: the break-away sprint belonged to the
    // enemy it replaces, and inheriting it would start the fight mid-flight.
    if (enemy.id !== this.shownEnemy.enemy.id) this.escape = 0;
    this.shownEnemy = { enemy, hp };
  }

  private setBanner(text: string): void {
    this.banner = { text, ageMs: 0 };
  }

  private update(dt: number): void {
    const running = this.snapshot.status === 'running';
    if (!running && this.snapshot.status !== 'idle') this.endHoldMs -= dt;
    if (this.deathHoldMs > 0) {
      this.deathHoldMs -= dt;
      if (this.deathHoldMs <= 0) this.showEnemy(this.snapshot.enemy, this.snapshot.enemyHp);
    }
    const moving = running && this.snapshot.moving;
    if (moving) {
      this.runPhase += dt * 0.012;
      this.groundOffset = (this.groundOffset + dt * 0.22) % 80;
    }
    // The lap is the chase: both run level until the last stretch, then the
    // runner reels the enemy in, hits it as the lap closes, and drops back as
    // it sprints off. Easing rather than assigning keeps it a run, not a jump.
    this.chase += (this.chaseTarget() - this.chase) * Math.min(1, dt / CHASE_LAG_MS);
    this.escape = decay(this.escape, dt, ESCAPE_MS);
    this.playerSwing = decay(this.playerSwing, dt, 260);
    this.enemySwing = decay(this.enemySwing, dt, 320);
    this.playerFlash = decay(this.playerFlash, dt, 300);
    this.enemyFlash = decay(this.enemyFlash, dt, 300);
    this.shake = Math.max(0, this.shake - dt * 0.04);
    if (this.banner) {
      this.banner.ageMs += dt;
      if (this.banner.ageMs > 1600) this.banner = null;
    }
    for (const floater of this.floaters) floater.ageMs += dt;
    this.floaters = this.floaters.filter((f) => f.ageMs < 1100);
  }

  private draw(): void {
    const { ctx } = this;
    const scale = Math.min(this.canvas.width / W, this.canvas.height / H);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    // Paint the letterbox bands so a portrait phone doesn't show bare black.
    ctx.fillStyle = levelTheme(this.snapshot.level.id).skyTop;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(
      scale,
      0,
      0,
      scale,
      (this.canvas.width - W * scale) / 2,
      (this.canvas.height - H * scale) / 2,
    );
    ctx.save();
    if (this.shake > 0) {
      ctx.translate((Math.random() - 0.5) * this.shake, (Math.random() - 0.5) * this.shake);
    }

    this.drawBackground();
    this.drawEnemy();
    this.drawRunner();
    ctx.restore();
    this.drawHud();
    this.drawFloaters();
    this.drawBanner();
  }

  private drawBackground(): void {
    const { ctx } = this;
    const theme = levelTheme(this.snapshot.level.id);
    const sky = ctx.createLinearGradient(0, 0, 0, GROUND_Y);
    sky.addColorStop(0, theme.skyTop);
    sky.addColorStop(1, theme.skyBottom);
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, GROUND_Y);

    ctx.fillStyle = theme.hills;
    for (let i = 0; i < 7; i += 1) {
      const x = ((i * 140 - this.groundOffset * 0.35) % (W + 160)) - 80;
      ctx.beginPath();
      ctx.moveTo(x, GROUND_Y);
      ctx.lineTo(x + 90, GROUND_Y - 130 - (i % 3) * 40);
      ctx.lineTo(x + 180, GROUND_Y);
      ctx.closePath();
      ctx.fill();
    }

    ctx.fillStyle = theme.ground;
    ctx.fillRect(0, GROUND_Y, W, H - GROUND_Y);
    ctx.strokeStyle = theme.lane;
    ctx.lineWidth = 4;
    ctx.beginPath();
    for (let x = -80; x < W + 80; x += 80) {
      const px = x + ((80 - this.groundOffset) % 80);
      ctx.moveTo(px, GROUND_Y + 26);
      ctx.lineTo(px + 40, GROUND_Y + 26);
    }
    ctx.stroke();
  }

  private chaseTarget(): number {
    return chaseTarget(this.snapshot.lapProgressM, this.snapshot.lapDistanceM);
  }

  /** Where the runner is along his chase, before the lunge of a swing. */
  private playerX(): number {
    return PLAYER_HOME_X + (PLAYER_CONTACT_X - PLAYER_HOME_X) * this.chase;
  }

  /**
   * `ease` peaks mid-decay, so the enemy is at home when the hit lands, breaks
   * away over the following moments, then settles back as the new lap starts.
   */
  private enemyX(): number {
    return ENEMY_HOME_X + ease(this.escape) * ENEMY_ESCAPE_X;
  }

  private drawRunner(): void {
    const { ctx } = this;
    const moving = this.snapshot.status === 'running' && this.snapshot.moving;
    const bob = moving ? Math.sin(this.runPhase * 2) * 5 : 0;
    const lunge = ease(this.playerSwing) * 46;
    const x = this.playerX() + lunge;
    const y = GROUND_Y + bob;

    ctx.save();
    ctx.translate(x, y);
    if (this.playerFlash > 0) {
      ctx.globalAlpha = 0.55 + 0.45 * (1 - this.playerFlash);
    }

    const legSwing = moving ? Math.sin(this.runPhase) : 0.15;
    const armSwing = moving ? Math.sin(this.runPhase + Math.PI) : -0.1;

    ctx.strokeStyle = '#e7e9f2';
    ctx.lineWidth = 7;
    ctx.lineCap = 'round';

    // legs
    ctx.beginPath();
    ctx.moveTo(0, -56);
    ctx.lineTo(legSwing * 26, -16);
    ctx.lineTo(legSwing * 20 + 6, 0);
    ctx.moveTo(0, -56);
    ctx.lineTo(-legSwing * 26, -16);
    ctx.lineTo(-legSwing * 20 - 6, 0);
    ctx.stroke();

    // torso
    ctx.beginPath();
    ctx.moveTo(0, -56);
    ctx.lineTo(4, -104);
    ctx.stroke();

    // weapon arm swings hard on a hit, other arm keeps the run cycle
    ctx.beginPath();
    ctx.moveTo(4, -98);
    ctx.lineTo(-armSwing * 22 - 10, -70);
    ctx.stroke();
    const swing = ease(this.playerSwing);
    ctx.save();
    ctx.translate(4, -98);
    ctx.rotate(-0.6 + swing * 1.9 + armSwing * 0.3);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(30, 6);
    ctx.stroke();
    ctx.strokeStyle = '#ff7a45';
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(30, 6);
    ctx.lineTo(66, -6);
    ctx.stroke();
    ctx.restore();

    // head
    ctx.fillStyle = '#e7e9f2';
    ctx.beginPath();
    ctx.arc(6, -118, 15, 0, Math.PI * 2);
    ctx.fill();

    if (swing > 0.05) {
      ctx.strokeStyle = `rgba(255,122,69,${swing})`;
      ctx.lineWidth = 8;
      ctx.beginPath();
      ctx.arc(30, -90, 74, -1.1, 0.5);
      ctx.stroke();
    }
    ctx.restore();

    if (!moving && this.snapshot.status === 'running') {
      ctx.fillStyle = 'rgba(231,233,242,0.75)';
      ctx.font = '700 20px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('JOG TO ATTACK', this.playerX(), GROUND_Y - 170);
    }
  }

  private drawEnemy(): void {
    const { ctx } = this;
    const alive = this.shownEnemy.hp > 0;
    const moving = alive && this.snapshot.status === 'running' && this.snapshot.moving;
    // Hopping along on the same stride the runner is on while he moves, and
    // planted on the ground when he isn't: the enemy only flees a runner.
    const hop = moving ? Math.abs(Math.sin(this.runPhase * 0.9)) : 0;
    const float = hop * -22;
    const squash = 4 - hop * 8;
    const lunge = ease(this.enemySwing) * -50;
    const x = this.enemyX() + lunge;
    const y = GROUND_Y - 60 + float;
    const palette = enemyPalette(this.shownEnemy.enemy.id);

    ctx.save();
    ctx.translate(x, y);
    if (!alive) ctx.globalAlpha = 0.25;
    if (this.enemyFlash > 0) ctx.globalAlpha = 0.5 + 0.5 * (1 - this.enemyFlash);

    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath();
    ctx.ellipse(0, 62 - float, 54 - hop * 12, 12 - hop * 3, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = this.enemyFlash > 0.3 ? '#ffffff' : palette.body;
    ctx.beginPath();
    ctx.ellipse(0, 0, 56 + squash, 62 - squash, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = palette.horn;
    ctx.beginPath();
    ctx.moveTo(-42, -34);
    ctx.lineTo(-56, -84);
    ctx.lineTo(-20, -50);
    ctx.closePath();
    ctx.moveTo(42, -34);
    ctx.lineTo(56, -84);
    ctx.lineTo(20, -50);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = '#0b0d14';
    ctx.beginPath();
    ctx.ellipse(-19, -8, 10, 13, 0, 0, Math.PI * 2);
    ctx.ellipse(19, -8, 10, 13, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = palette.eye;
    ctx.beginPath();
    ctx.arc(-19, -8 + (alive ? 0 : 4), 4, 0, Math.PI * 2);
    ctx.arc(19, -8 + (alive ? 0 : 4), 4, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = '#0b0d14';
    ctx.lineWidth = 5;
    ctx.beginPath();
    if (alive) {
      ctx.arc(0, 24, 18, 0.15, Math.PI - 0.15);
    } else {
      ctx.arc(0, 40, 18, Math.PI + 0.2, -0.2);
    }
    ctx.stroke();
    ctx.restore();
  }

  private drawHud(): void {
    const { ctx } = this;
    const s = this.snapshot;
    hudBar(ctx, 24, 26, 240, 16, s.playerHp / s.playerMaxHp, '#4ade80');
    hudBar(
      ctx,
      W - 264,
      26,
      240,
      16,
      this.shownEnemy.hp / this.shownEnemy.enemy.maxHp,
      '#f87171',
    );
    hudBar(ctx, 24, 52, 160, 8, s.energy / 100, '#60a5fa');
    hudBar(
      ctx,
      24,
      H - 26,
      W - 48,
      10,
      s.lapProgressM / s.lapDistanceM,
      s.sprint ? '#ffd166' : '#ff7a45',
    );

    ctx.fillStyle = '#e7e9f2';
    ctx.font = '700 15px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(s.weapon.name, 24, 18);
    ctx.textAlign = 'right';
    ctx.fillText(this.shownEnemy.enemy.name, W - 24, 18);
    ctx.fillStyle = '#8b93ab';
    ctx.font = '600 12px system-ui, sans-serif';
    ctx.fillText(`weak to ${this.shownEnemy.enemy.weakTo.join(', ')}`, W - 24, 62);
    ctx.textAlign = 'center';
    ctx.fillText(s.level.name.toUpperCase(), W / 2, 18);
    ctx.textAlign = 'left';
    ctx.fillText(
      s.armedSpell ? `${s.armedSpell.name} armed` : `${s.lapDistanceM}m per attack`,
      24,
      74,
    );
  }

  private drawFloaters(): void {
    const { ctx } = this;
    ctx.textAlign = 'center';
    for (const floater of this.floaters) {
      const progress = floater.ageMs / 1100;
      ctx.globalAlpha = 1 - progress;
      ctx.fillStyle = floater.color;
      ctx.font = `800 ${Math.round(26 * floater.scale)}px system-ui, sans-serif`;
      ctx.fillText(floater.text, floater.x, floater.y - progress * 70);
    }
    ctx.globalAlpha = 1;
  }

  private drawBanner(): void {
    if (!this.banner) return;
    const { ctx } = this;
    const progress = this.banner.ageMs / 1600;
    ctx.globalAlpha = Math.min(1, (1 - progress) * 2);
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ffd166';
    ctx.font = '800 40px system-ui, sans-serif';
    ctx.fillText(this.banner.text.toUpperCase(), W / 2, 150 - progress * 20);
    ctx.globalAlpha = 1;
  }
}

function hudBar(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  fill: number,
  color: string,
): void {
  ctx.fillStyle = 'rgba(6,8,14,0.75)';
  ctx.fillRect(x, y, width, height);
  ctx.fillStyle = color;
  ctx.fillRect(x, y, width * Math.max(0, Math.min(1, fill)), height);
  ctx.strokeStyle = 'rgba(231,233,242,0.25)';
  ctx.lineWidth = 1;
  ctx.strokeRect(x, y, width, height);
}

function enemyPalette(id: string): { body: string; horn: string; eye: string } {
  switch (id) {
    case 'slime':
      return { body: '#5ec98b', horn: '#3f9d68', eye: '#0d0f16' };
    case 'shin-wraith':
      return { body: '#8b7bd8', horn: '#6a5cb8', eye: '#ffe9a8' };
    case 'gargoyle':
      return { body: '#7c8596', horn: '#5b6472', eye: '#ff9b6a' };
    case 'wall':
      return { body: '#b3703f', horn: '#8a5730', eye: '#ffe9a8' };
    case 'hound':
      return { body: '#d1685a', horn: '#a54b40', eye: '#ffe9a8' };
    case 'cramp-lord':
      return { body: '#c94f7c', horn: '#95375c', eye: '#ffe9a8' };
    case 'gull-swarm':
      return { body: '#e8e3d3', horn: '#f5a524', eye: '#0d0f16' };
    case 'tide-warden':
      return { body: '#3f8fa8', horn: '#2b6b80', eye: '#a8f0ff' };
    case 'piston':
      return { body: '#8d9099', horn: '#f5a524', eye: '#ff6b3d' };
    case 'furnace':
      return { body: '#b23a2c', horn: '#f5a524', eye: '#ffe9a8' };
    case 'chronarch':
      return { body: '#4b3f9e', horn: '#ffd166', eye: '#ffffff' };
    default:
      return { body: '#6c8bff', horn: '#4a63c8', eye: '#ffd166' };
  }
}

interface LevelTheme {
  skyTop: string;
  skyBottom: string;
  hills: string;
  ground: string;
  lane: string;
}

function levelTheme(id: string): LevelTheme {
  switch (id) {
    case 'level-1':
      return {
        skyTop: '#131a2c',
        skyBottom: '#28402f',
        hills: '#1d3326',
        ground: '#111a14',
        lane: '#2d4a34',
      };
    case 'level-2':
      return {
        skyTop: '#2a1b1b',
        skyBottom: '#4a2f26',
        hills: '#33241f',
        ground: '#1a1210',
        lane: '#4a3327',
      };
    case 'level-3':
      return {
        skyTop: '#101827',
        skyBottom: '#243b55',
        hills: '#1b2a3f',
        ground: '#0d1420',
        lane: '#2b3f5c',
      };
    case 'level-4':
      return {
        skyTop: '#2c1633',
        skyBottom: '#8a3b47',
        hills: '#43213c',
        ground: '#170f1c',
        lane: '#5a2f45',
      };
    case 'level-5':
      return {
        skyTop: '#1a1412',
        skyBottom: '#5c2a12',
        hills: '#2b1d17',
        ground: '#140f0d',
        lane: '#5c3a1e',
      };
    default:
      return {
        skyTop: '#0b0d14',
        skyBottom: '#2a2140',
        hills: '#1b2338',
        ground: '#0f1320',
        lane: '#2b3450',
      };
  }
}

function decay(value: number, dt: number, ms: number): number {
  return Math.max(0, value - dt / ms);
}

function ease(value: number): number {
  return Math.sin(Math.min(1, Math.max(0, value)) * Math.PI);
}

/**
 * How closed the visual gap should be, 0 (level) to 1 (in reach). The runner
 * only starts reeling the enemy in over the closing metres of the lap, so a
 * long lap is a long level chase and a short lap closes almost immediately.
 */
export function chaseTarget(lapProgressM: number, lapDistanceM: number): number {
  const window = Math.min(CHASE_WINDOW_M, lapDistanceM);
  if (window <= 0) return 0;
  const remainingM = lapDistanceM - lapProgressM;
  return clamp01((window - remainingM) / window);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
