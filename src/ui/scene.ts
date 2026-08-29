import type { Enemy } from '../engine/types';
import type { GameSession, Snapshot } from '../engine/game';

/**
 * The smallest world the fight is drawn in. The view is stretched past this to
 * whatever shape the screen is, rather than a fixed 800x450 being letterboxed
 * into it: a portrait phone would spend more than half its height on bare bands
 * and draw everything at half size.
 */
const MIN_W = 480;
const MIN_H = 430;
/** Sky above the horizon, as a share of the view — the rest is road. */
const HORIZON = 0.72;
/** Room the sprites need above the horizon, whatever shape the screen is. */
const SPRITE_HEADROOM = 300;

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
const PLAYER_HOME = 0.18;
const PLAYER_CONTACT = 0.52;
const ENEMY_HOME = 0.74;
/** How far the enemy breaks away in the sprint that follows a hit. */
const ENEMY_ESCAPE = 0.16;
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
  /** Total ground covered by the scenery, for parallax layers of any period. */
  private scrollX = 0;
  private playerSwing = 0;
  private enemySwing = 0;
  private playerFlash = 0;
  private enemyFlash = 0;
  /** Pushes the runner back out of the enemy's charge. */
  private knockback = 0;
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
  /** The world the screen currently shows, in drawing units. */
  private viewW = MIN_W;
  private viewH = MIN_H;
  private scale = 1;
  private groundY = MIN_H * HORIZON;
  /** Drawing units at the bottom that the on-screen action bar covers. */
  private bottomInset = 0;

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
              y: this.groundY - 120,
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
            this.knockback = 1;
            this.shake = event.crit ? 16 : 5;
            this.floaters.push({
              text: `-${event.damage}${event.crit ? ' CRIT!' : ''}`,
              x: this.playerX(),
              y: this.groundY - 110,
              ageMs: 0,
              color: '#f87171',
              scale: event.crit ? 1.6 : 1,
            });
            if (event.crit) this.setBanner('CAUGHT STANDING!');
            break;
          case 'enemyMissed':
            // The lunge still plays: the runner sees what holding the pace saved
            // them from.
            this.enemySwing = 1;
            this.floaters.push({
              text: 'MISS',
              x: this.playerX(),
              y: this.groundY - 130,
              ageMs: 0,
              color: '#9ae6b4',
              scale: 1.1,
            });
            break;
          case 'attackTooSlow':
            this.floaters.push({
              text: 'TOO SLOW',
              x: this.enemyX(),
              y: this.groundY - 130,
              ageMs: 0,
              color: '#f5a524',
              scale: 1.1,
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
    // A phone browser hiding its toolbars changes the visible area without
    // always resizing the window, and the canvas has to follow it or the fight
    // is drawn at the old size and stretched.
    window.visualViewport?.addEventListener('resize', this.resize);
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
    window.visualViewport?.removeEventListener('resize', this.resize);
    for (const off of this.unsubscribe) off();
    this.unsubscribe = [];
  }

  private readonly resize = (): void => {
    const ratio = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.max(1, Math.round(rect.width * ratio));
    this.canvas.height = Math.max(1, Math.round(rect.height * ratio));
    // Zoom to the tightest fit that still shows the minimum world, then let the
    // view grow past it in whichever direction the screen has room. Nothing is
    // letterboxed, so the sky, the road and the bars have the whole screen.
    this.scale = Math.min(this.canvas.width / MIN_W, this.canvas.height / MIN_H);
    this.viewW = this.canvas.width / this.scale;
    this.viewH = this.canvas.height / this.scale;
    // A tall screen puts the horizon low, but never so low that the sprites and
    // their damage numbers run off the top.
    this.groundY = Math.max(
      Math.min(this.viewH * HORIZON, this.viewH - 60),
      Math.min(SPRITE_HEADROOM, this.viewH),
    );
    // The canvas now reaches the bottom of the screen, where the action bar sits
    // over it, so the lap bar is kept clear of it instead of drawn underneath.
    const controls = document.getElementById('controls');
    const coveredPx = controls ? controls.getBoundingClientRect().height : 0;
    this.bottomInset = Math.min(this.viewH / 3, (coveredPx * ratio) / this.scale);
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
      // Each parallax layer tiles at its own width, so the shared scroll only
      // needs to stay finite — a common multiple of the tile widths keeps every
      // layer seamless when it wraps.
      this.scrollX = (this.scrollX + dt * 0.22) % 1_209_600;
    }
    // The lap is the chase: both run level until the last stretch, then the
    // runner reels the enemy in, hits it as the lap closes, and drops back as
    // it sprints off. Easing rather than assigning keeps it a run, not a jump.
    this.chase += (this.chaseTarget() - this.chase) * Math.min(1, dt / CHASE_LAG_MS);
    this.escape = decay(this.escape, dt, ESCAPE_MS);
    this.playerSwing = decay(this.playerSwing, dt, 260);
    this.enemySwing = decay(this.enemySwing, dt, 320);
    this.playerFlash = decay(this.playerFlash, dt, 300);
    this.knockback = decay(this.knockback, dt, 420);
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
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(this.scale, 0, 0, this.scale, 0, 0);
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
    const groundY = this.groundY;
    const sky = ctx.createLinearGradient(0, 0, 0, groundY);
    sky.addColorStop(0, theme.skyTop);
    sky.addColorStop(1, theme.skyBottom);
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, this.viewW, groundY);

    this.drawClouds(theme, groundY);
    // Two ranges of ruins: the far one pale and slow, the near one dark, jagged
    // and detailed, so the street reads as a place rather than a gradient.
    this.drawSkyline(theme, groundY, 1);
    this.drawSkyline(theme, groundY, 0);
    this.drawRoad(theme, groundY);
  }

  private drawClouds(theme: LevelTheme, groundY: number): void {
    const { ctx } = this;
    const tile = 560;
    const offset = (this.scrollX * 0.04) % tile;
    ctx.fillStyle = theme.cloud;
    for (let i = -1; i * tile < this.viewW + tile; i += 1) {
      const base = i * tile - offset;
      const cell = Math.floor((this.scrollX * 0.04 + base + offset) / tile);
      for (let c = 0; c < 3; c += 1) {
        const x = base + rnd(cell, c * 3 + 1) * tile;
        const y = 16 + rnd(cell, c * 3 + 2) * groundY * 0.32;
        const w = 60 + rnd(cell, c * 3 + 3) * 90;
        ctx.globalAlpha = 0.16 + rnd(cell, c * 3 + 4) * 0.12;
        // Blocky three-slab clouds, in keeping with the pixel look.
        ctx.fillRect(x, y, w, 8);
        ctx.fillRect(x + w * 0.15, y - 7, w * 0.6, 7);
        ctx.fillRect(x + w * 0.3, y + 8, w * 0.55, 6);
      }
    }
    ctx.globalAlpha = 1;
  }

  /** A range of ruined buildings; depth 0 is the near range, 1 the far one. */
  private drawSkyline(theme: LevelTheme, groundY: number, depth: number): void {
    const { ctx } = this;
    if (depth === 1 && groundY <= 300) return;
    const step = depth === 0 ? 132 : 96;
    const speed = depth === 0 ? 0.3 : 0.12;
    const offset = (this.scrollX * speed) % step;
    const maxH = groundY * (depth === 0 ? 0.42 : 0.6);
    ctx.globalAlpha = depth === 0 ? 1 : 0.45;
    for (let i = -1; i * step < this.viewW + step; i += 1) {
      const x = i * step - offset;
      const cell = Math.round((x + offset) / step + (this.scrollX * speed - offset) / step);
      const w = step - 10 - Math.floor(rnd(cell, depth) * 26);
      const h = maxH * (0.45 + rnd(cell, depth + 10) * 0.55);
      const top = groundY - h;
      ctx.fillStyle = theme.hills;
      ctx.fillRect(x, top, w, h);
      // A ruined roofline: bites taken out of the top edge, not a clean bar.
      ctx.fillStyle = theme.skyBottom;
      const bites = 2 + Math.floor(rnd(cell, depth + 20) * 3);
      for (let b = 0; b < bites; b += 1) {
        const bw = 8 + rnd(cell, depth + 30 + b) * (w / bites - 8);
        const bx = x + (b + rnd(cell, depth + 40 + b) * 0.6) * (w / bites);
        ctx.fillRect(bx, top, bw, 6 + rnd(cell, depth + 50 + b) * 16);
      }
      // Window grid — mostly dead, the odd one lit.
      for (let wy = top + 16; wy < groundY - 14; wy += 22) {
        for (let wx = x + 8; wx < x + w - 10; wx += 18) {
          const lit = rnd(Math.floor(wx) + cell, Math.floor(wy)) > (depth === 0 ? 0.93 : 0.97);
          ctx.fillStyle = lit ? theme.window : theme.deadWindow;
          ctx.fillRect(wx, wy, 7, 9);
        }
      }
      if (depth === 0) {
        // Grime streaked down from the roofline, and rubble at the foot.
        ctx.fillStyle = 'rgba(0,0,0,0.25)';
        for (let g = 0; g < 3; g += 1) {
          const gx = x + rnd(cell, 60 + g) * (w - 6);
          ctx.fillRect(gx, top, 4, h * (0.3 + rnd(cell, 70 + g) * 0.5));
        }
        ctx.fillStyle = theme.rubble;
        const piles = 2 + Math.floor(rnd(cell, 80) * 3);
        for (let p = 0; p < piles; p += 1) {
          const px = x + rnd(cell, 90 + p) * (step - 24);
          const pw = 14 + rnd(cell, 100 + p) * 26;
          const ph = 6 + rnd(cell, 110 + p) * 12;
          ctx.beginPath();
          ctx.moveTo(px, groundY);
          ctx.lineTo(px + pw * 0.5, groundY - ph);
          ctx.lineTo(px + pw, groundY);
          ctx.closePath();
          ctx.fill();
        }
        // The odd graffiti tag on a near wall.
        if (rnd(cell, 120) > 0.6 && h > 70) {
          ctx.fillStyle = theme.graffiti;
          const gy = groundY - 26 - rnd(cell, 130) * 20;
          const gx = x + 8 + rnd(cell, 140) * (w - 40);
          for (let s = 0; s < 4; s += 1) {
            ctx.fillRect(gx + s * 7, gy + (s % 2) * 4, 5, 10);
          }
        }
      }
    }
    ctx.globalAlpha = 1;
  }

  private drawRoad(theme: LevelTheme, groundY: number): void {
    const { ctx } = this;
    ctx.fillStyle = theme.ground;
    ctx.fillRect(0, groundY, this.viewW, this.viewH - groundY);
    // A kerb line pins the buildings to the road instead of floating over it.
    ctx.fillStyle = theme.kerb;
    ctx.fillRect(0, groundY, this.viewW, 5);

    // Asphalt speckle: pebbles and stains tiled at the ground's own period, so
    // the texture streams past underfoot at running speed.
    const tile = 80;
    const offset = this.groundOffset;
    const roadH = this.viewH - groundY;
    for (let i = -1; i * tile < this.viewW + tile; i += 1) {
      const x = i * tile - offset;
      const cell = ((i + Math.floor(this.scrollX / tile)) % 64 + 64) % 64;
      for (let s = 0; s < 9; s += 1) {
        const sx = x + rnd(cell, s * 4 + 1) * tile;
        const sy = groundY + 8 + rnd(cell, s * 4 + 2) * (roadH - 14);
        const light = rnd(cell, s * 4 + 3) > 0.5;
        ctx.fillStyle = light ? theme.speckleLight : theme.speckleDark;
        const size = 2 + Math.floor(rnd(cell, s * 4 + 4) * 3);
        ctx.fillRect(sx, sy, size, size);
      }
      // A crack wandering across most tiles — asphalt that has seen things.
      if (rnd(cell, 200) > 0.35) {
        ctx.strokeStyle = theme.crack;
        ctx.lineWidth = 2;
        ctx.beginPath();
        let cx = x + rnd(cell, 210) * tile * 0.4;
        let cy = groundY + 10 + rnd(cell, 220) * roadH * 0.5;
        ctx.moveTo(cx, cy);
        for (let seg = 0; seg < 4; seg += 1) {
          cx += 8 + rnd(cell, 230 + seg) * 16;
          cy += (rnd(cell, 240 + seg) - 0.4) * 22;
          ctx.lineTo(cx, cy);
        }
        ctx.stroke();
      }
    }

    // A wide road gets a lane per band of it, so the space below the runner is
    // road rushing past rather than an empty slab.
    ctx.strokeStyle = theme.lane;
    ctx.lineWidth = 4;
    ctx.beginPath();
    for (let lane = groundY + 26; lane < this.viewH - 8; lane += 78) {
      for (let x = -80; x < this.viewW + 80; x += 80) {
        const px = x + ((80 - this.groundOffset) % 80);
        ctx.moveTo(px, lane);
        ctx.lineTo(px + 40, lane);
      }
    }
    ctx.stroke();

    // A soft vignette pulls the eye to the fight and grounds the palette.
    const vignette = ctx.createLinearGradient(0, this.viewH - roadH * 0.6, 0, this.viewH);
    vignette.addColorStop(0, 'rgba(0,0,0,0)');
    vignette.addColorStop(1, 'rgba(0,0,0,0.35)');
    ctx.fillStyle = vignette;
    ctx.fillRect(0, groundY, this.viewW, roadH);
  }

  private chaseTarget(): number {
    return chaseTarget(this.snapshot.lapProgressM, this.snapshot.lapDistanceM);
  }

  /** Where the runner is along his chase, before the lunge of a swing. */
  private playerX(): number {
    return this.viewW * (PLAYER_HOME + (PLAYER_CONTACT - PLAYER_HOME) * this.chase);
  }

  /**
   * `ease` peaks mid-decay, so the enemy is at home when the hit lands, breaks
   * away over the following moments, then settles back as the new lap starts.
   */
  private enemyX(): number {
    return this.viewW * (ENEMY_HOME + ease(this.escape) * ENEMY_ESCAPE);
  }

  private drawRunner(): void {
    const { ctx } = this;
    const moving = this.snapshot.status === 'running' && this.snapshot.moving;
    const bob = moving ? Math.sin(this.runPhase * 2) * 5 : 0;
    const lunge = ease(this.playerSwing) * 46;
    const x = this.playerX() + lunge - ease(this.knockback) * 26;
    const y = this.groundY + bob;

    ctx.save();
    ctx.translate(x, y);
    if (this.playerFlash > 0) {
      ctx.globalAlpha = 0.55 + 0.45 * (1 - this.playerFlash);
    }

    const legSwing = moving ? Math.sin(this.runPhase) : 0.15;
    const armSwing = moving ? Math.sin(this.runPhase + Math.PI) : -0.1;

    // Shadow pins him to the road.
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath();
    ctx.ellipse(2, 4 - bob, 34, 8, 0, 0, Math.PI * 2);
    ctx.fill();

    // Limbs are stroked twice — a dark outline under the color — so the runner
    // reads as a drawn character against any sky, not a wire figure.
    const limb = (color: string, width: number, path: () => void): void => {
      ctx.lineCap = 'round';
      ctx.strokeStyle = '#0b0d14';
      ctx.lineWidth = width + 5;
      ctx.beginPath();
      path();
      ctx.stroke();
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.beginPath();
      path();
      ctx.stroke();
    };

    // far leg and far arm first, in shade
    limb('#31394e', 8, () => {
      ctx.moveTo(0, -56);
      ctx.lineTo(-legSwing * 26, -16);
      ctx.lineTo(-legSwing * 20 - 6, 0);
    });
    limb('#8a5a3a', 7, () => {
      ctx.moveTo(4, -96);
      ctx.lineTo(armSwing * 20 + 12, -68);
    });

    // torso: a jacket with a lighter chest panel
    limb('#c2503a', 15, () => {
      ctx.moveTo(0, -58);
      ctx.lineTo(4, -100);
    });
    ctx.fillStyle = '#e07a5f';
    ctx.fillRect(-3, -96, 7, 26);

    // scarf streaming behind while he runs
    const flap = moving ? Math.sin(this.runPhase * 2) * 6 : 2;
    ctx.fillStyle = '#ffd166';
    ctx.beginPath();
    ctx.moveTo(0, -98);
    ctx.lineTo(-26 - flap, -92 + flap);
    ctx.lineTo(-24 - flap, -84 + flap);
    ctx.lineTo(2, -90);
    ctx.closePath();
    ctx.fill();

    // near leg
    limb('#4a5470', 8, () => {
      ctx.moveTo(0, -56);
      ctx.lineTo(legSwing * 26, -16);
      ctx.lineTo(legSwing * 20 + 6, 0);
    });
    // shoes
    ctx.fillStyle = '#ff7a45';
    ctx.fillRect(legSwing * 20 + 1, -4, 14, 6);
    ctx.fillStyle = '#b3502d';
    ctx.fillRect(-legSwing * 20 - 12, -4, 14, 6);

    // weapon arm swings hard on a hit, other arm keeps the run cycle
    const swing = ease(this.playerSwing);
    ctx.save();
    ctx.translate(4, -96);
    ctx.rotate(-0.6 + swing * 1.9 + armSwing * 0.3);
    limb('#a06a45', 7, () => {
      ctx.moveTo(0, 0);
      ctx.lineTo(30, 6);
    });
    // haft and glowing head
    limb('#6b4a2e', 5, () => {
      ctx.moveTo(28, 6);
      ctx.lineTo(58, -4);
    });
    ctx.fillStyle = '#ff7a45';
    ctx.fillRect(52, -14, 16, 14);
    ctx.fillStyle = '#ffd166';
    ctx.fillRect(56, -11, 8, 8);
    ctx.restore();

    // head: skin, hair swept back, an eye and a headband
    ctx.fillStyle = '#0b0d14';
    ctx.beginPath();
    ctx.arc(6, -116, 17, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#e8b58a';
    ctx.beginPath();
    ctx.arc(6, -116, 14, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#2f2a3d';
    ctx.beginPath();
    ctx.arc(2, -120, 13, Math.PI * 0.85, Math.PI * 1.95);
    ctx.lineTo(2, -120);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#ff7a45';
    ctx.fillRect(-8, -122, 26, 4);
    ctx.fillStyle = '#0b0d14';
    ctx.fillRect(12, -116, 3, 4);

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
      ctx.fillText('JOG TO ATTACK', this.playerX(), this.groundY - 170);
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
    // The charge covers the ground between them, so the strike reads as the
    // enemy coming for the runner rather than as a twitch on the spot.
    const reach = Math.max(60, this.enemyX() - this.playerX() - 70);
    const strike = ease(this.enemySwing);
    const x = this.enemyX() - strike * reach;
    const y = this.groundY - 60 + float;
    const palette = enemyPalette(this.shownEnemy.enemy.id);

    ctx.save();
    ctx.translate(x, y);
    if (!alive) ctx.globalAlpha = 0.25;
    if (this.enemyFlash > 0) ctx.globalAlpha = 0.5 + 0.5 * (1 - this.enemyFlash);

    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath();
    ctx.ellipse(0, 62 - float, 54 - hop * 12, 12 - hop * 3, 0, 0, Math.PI * 2);
    ctx.fill();

    // Outline, body, then a shaded belly and a top highlight: the blob gets
    // volume instead of being a flat disc.
    ctx.fillStyle = '#0b0d14';
    ctx.beginPath();
    ctx.ellipse(0, 0, 60 + squash, 66 - squash, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = this.enemyFlash > 0.3 ? '#ffffff' : palette.body;
    ctx.beginPath();
    ctx.ellipse(0, 0, 56 + squash, 62 - squash, 0, 0, Math.PI * 2);
    ctx.fill();
    if (this.enemyFlash <= 0.3) {
      ctx.fillStyle = 'rgba(0,0,0,0.22)';
      ctx.beginPath();
      ctx.ellipse(0, 26, 48 + squash, 34, 0, 0, Math.PI);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.18)';
      ctx.beginPath();
      ctx.ellipse(-18, -30, 22, 12, -0.5, 0, Math.PI * 2);
      ctx.fill();
      // mottled hide
      ctx.fillStyle = 'rgba(0,0,0,0.15)';
      for (let s = 0; s < 5; s += 1) {
        const sx = (rnd(s, 1) - 0.5) * 84;
        const sy = (rnd(s, 2) - 0.3) * 70;
        ctx.beginPath();
        ctx.ellipse(sx, sy, 5 + rnd(s, 3) * 5, 4 + rnd(s, 4) * 4, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    }

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

    // Claws come out at the end of the charge.
    if (strike > 0.05) {
      ctx.strokeStyle = `rgba(248,113,113,${strike})`;
      ctx.lineWidth = 6;
      ctx.lineCap = 'round';
      for (const offset of [-18, 0, 18]) {
        ctx.beginPath();
        ctx.moveTo(-46, offset);
        ctx.lineTo(-46 - 40 * strike, offset - 12 * strike);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  private drawHud(): void {
    const { ctx } = this;
    const s = this.snapshot;
    // Narrow views shrink the health bars rather than letting them meet in the
    // middle, and every bar spans the width the screen actually has.
    const barW = Math.min(240, this.viewW / 2 - 40);
    hudBar(ctx, 24, 26, barW, 16, s.playerHp / s.playerMaxHp, '#4ade80');
    hudBar(
      ctx,
      this.viewW - 24 - barW,
      26,
      barW,
      16,
      this.shownEnemy.hp / this.shownEnemy.enemy.maxHp,
      '#f87171',
    );
    hudBar(ctx, 24, 52, barW * 0.67, 8, s.energy / 100, '#60a5fa');
    hudBar(
      ctx,
      24,
      this.viewH - 14 - this.bottomInset,
      this.viewW - 48,
      10,
      s.lapProgressM / s.lapDistanceM,
      s.sprint ? '#ffd166' : '#ff7a45',
    );

    ctx.fillStyle = '#e7e9f2';
    ctx.font = '700 15px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(s.weapon.name, 24, 18);
    ctx.textAlign = 'right';
    ctx.fillText(this.shownEnemy.enemy.name, this.viewW - 24, 18);
    ctx.fillStyle = '#8b93ab';
    ctx.font = '600 12px system-ui, sans-serif';
    ctx.fillText(`weak to ${this.shownEnemy.enemy.weakTo.join(', ')}`, this.viewW - 24, 62);
    ctx.textAlign = 'center';
    // A narrow view has no room between the weapon and enemy names for a third
    // string, so the level name drops below the row instead of overprinting it.
    ctx.fillText(s.level.name.toUpperCase(), this.viewW / 2, this.viewW >= 640 ? 18 : 96);
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
    ctx.fillText(this.banner.text.toUpperCase(), this.viewW / 2, 150 - progress * 20);
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
  cloud: string;
  window: string;
  deadWindow: string;
  rubble: string;
  graffiti: string;
  kerb: string;
  speckleLight: string;
  speckleDark: string;
  crack: string;
}

/** Texture tones shared by every level; the palette colors set the mood. */
const THEME_TEXTURE = {
  cloud: '#e7e9f2',
  window: '#ffd166',
  deadWindow: 'rgba(0,0,0,0.35)',
  rubble: 'rgba(0,0,0,0.4)',
  graffiti: '#ff7a45',
  kerb: 'rgba(255,255,255,0.12)',
  speckleLight: 'rgba(255,255,255,0.08)',
  speckleDark: 'rgba(0,0,0,0.3)',
  crack: 'rgba(0,0,0,0.35)',
};

function levelTheme(id: string): LevelTheme {
  switch (id) {
    case 'level-1':
      return {
        ...THEME_TEXTURE,
        skyTop: '#131a2c',
        skyBottom: '#28402f',
        hills: '#1d3326',
        ground: '#111a14',
        lane: '#2d4a34',
        graffiti: '#9ae6b4',
      };
    case 'level-2':
      return {
        ...THEME_TEXTURE,
        skyTop: '#2a1b1b',
        skyBottom: '#4a2f26',
        hills: '#33241f',
        ground: '#1a1210',
        lane: '#4a3327',
      };
    case 'level-3':
      return {
        ...THEME_TEXTURE,
        skyTop: '#101827',
        skyBottom: '#243b55',
        hills: '#1b2a3f',
        ground: '#0d1420',
        lane: '#2b3f5c',
        graffiti: '#60a5fa',
      };
    case 'level-4':
      return {
        ...THEME_TEXTURE,
        skyTop: '#2c1633',
        skyBottom: '#8a3b47',
        hills: '#43213c',
        ground: '#170f1c',
        lane: '#5a2f45',
        graffiti: '#c94f7c',
      };
    case 'level-5':
      return {
        ...THEME_TEXTURE,
        skyTop: '#1a1412',
        skyBottom: '#5c2a12',
        hills: '#2b1d17',
        ground: '#140f0d',
        lane: '#5c3a1e',
        graffiti: '#f5a524',
      };
    default:
      return {
        ...THEME_TEXTURE,
        skyTop: '#0b0d14',
        skyBottom: '#2a2140',
        hills: '#1b2338',
        ground: '#0f1320',
        lane: '#2b3450',
        graffiti: '#8b7bd8',
      };
  }
}

/** Deterministic noise in [0, 1): the same cell always draws the same scenery. */
function rnd(cell: number, salt: number): number {
  const v = Math.sin(cell * 127.1 + salt * 311.7) * 43758.5453;
  return v - Math.floor(v);
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
