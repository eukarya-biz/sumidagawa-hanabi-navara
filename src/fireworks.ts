import ThreeView, { Color, type MeshHandle } from "@navaramap/three";
import {
  InstancedSphereMeshDesc,
  type SphereChildConfig,
} from "@navaramap/three_default_descs";
import { Matrix4, Vector3 } from "three";
import type { Rng } from "./rng";

/** 重力加速度 (m/s^2)。 */
const G = 9.80665;

/** 玉の種類。実際の花火の分類に合わせている。 */
export type ShellKind =
  | "peony" // 牡丹：尾を引かず、球状に一斉に開く
  | "chrysanthemum" // 菊：星が尾を引きながら球状に開く
  | "willow" // 冠（かむろ）／しだれ柳：ゆっくり垂れ下がる
  | "ring" // 型物：輪
  | "crossette" // 十字菊：星が途中で分裂する
  | "small"; // 小玉：連発用の小さい玉

/** 1 発の玉の指定。 */
export type Shell = {
  kind: ShellKind;
  /** 打ち上げ地点（ENU ローカル座標, m）。z は地面高。 */
  origin: Vector3;
  /** 開花高度（m, 地面から）。 */
  burstAltitude: number;
  /** 開花半径の目安（m）。 */
  burstRadius: number;
  /** 星の色。複数指定すると芯（多重芯）になる。 */
  colors: number[];
  /** 開花時に「パチパチ」する小割を付けるか。 */
  crackle: boolean;
};

type Particle = {
  p: Vector3;
  v: Vector3;
  life: number;
  maxLife: number;
  size: number;
  /** 1 秒あたりの速度保持率（空気抵抗）。 */
  drag: number;
  gravityScale: number;
  /** 明滅の強さ 0..1。 */
  twinkle: number;
  twinklePhase: number;
};

type Emitter = {
  handle: MeshHandle<InstancedSphereMeshDesc>;
  particles: Particle[];
  /**
   * `replaceAll()` に渡す設定オブジェクトの使い回しバッファ。
   * 毎フレーム新しいオブジェクトを作ると GC が回って
   * フィナーレでフレームが飛ぶので、中身だけ書き換える。
   */
  buffer: { position: { x: number; y: number; z: number }; radius: number }[];
  color: Color;
  colorHex: number;
  /** 発光強度のピーク値。 */
  peakIntensity: number;
  /** 現在の発光強度（毎フレーム書き戻す）。 */
  intensity: number;
  /** 減衰の基準時間（s）。 */
  decay: number;
  age: number;
  busy: boolean;
  /** 直前に書き込んだ設定。無駄な update を避けるため。 */
  lastIntensity: number;
  lastOpacity: number;
};

/** 打ち上げ・開花のイベント通知。音の遅延処理に使う。 */
export type FireworkEvents = {
  /** 開花した瞬間。position は ENU ローカル座標 (m)。 */
  onBurst?: (info: {
    position: Vector3;
    kind: ShellKind;
    burstRadius: number;
    crackle: boolean;
    /** 玉の外側の層の色。煙を染めるのに使う。 */
    tintColor: Color;
  }) => void;
  /** 打ち上げの瞬間。riseTime は開花までの秒数（発射音の長さに使う）。 */
  onLaunch?: (info: { position: Vector3; riseTime: number }) => void;
};

const EMITTER_POOL_SIZE = 96;
const MAX_PARTICLES_PER_EMITTER = 900;
/** 上昇中の火の粉は全弾で 1 つのエミッタを共有する（色が同じなので分ける必要がない）。 */
const MAX_TRAIL_PARTICLES = 1600;

/**
 * 空気抵抗（速度に比例、1/s）。
 * 毎フレーム v *= 0.86^dt としているので λ = -ln(0.86)。
 */
const RISE_DRAG_LAMBDA = -Math.log(0.86);
/** 上昇時の終端速度 (m/s)。 */
const RISE_TERMINAL = G / RISE_DRAG_LAMBDA;

/**
 * 目標高度に到達する打ち上げ初速を求める。
 *
 * 線形抵抗つき鉛直投射の頂点高度は解析的に
 *   z = (1/λ)[ v0 - u * ln(1 + v0/u) ]   （u = G/λ は終端速度）
 * になる。v0 について単調増加なので二分法で解く。
 *
 * sqrt(2*G*h) をそのまま使うと抵抗の分だけ足りず、
 * 300 m 狙いで 195 m しか上がらない（実測）。
 */
function liftVelocityFor(altitude: number): number {
  const target = altitude * RISE_DRAG_LAMBDA;
  const f = (v0: number) => v0 - RISE_TERMINAL * Math.log(1 + v0 / RISE_TERMINAL);
  let lo = 0;
  let hi = Math.max(50, Math.sqrt(2 * G * altitude) * 3);
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (f(mid) < target) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * 花火シミュレータ。
 *
 * 設計：
 * - 星（火の粉）は素の JS で物理計算し、毎フレーム `replaceAll()` で
 *   InstancedSphereMesh に一括反映する。1 エミッタ = 1 ドローコール。
 * - 色ごとにエミッタを分ける。共有マテリアルの emissiveColor を色に使い、
 *   SelectiveBloom のソースにする（＝ちゃんと光って滲む）。
 * - エミッタはプールして使い回す。addMesh/delete を毎発やるとコストが高い。
 */
export class FireworkSystem {
  private view: ThreeView<any>;
  private frame: Matrix4;
  private bloomId: string;
  private emitters: Emitter[] = [];
  private rockets: {
    p: Vector3;
    v: Vector3;
    shell: Shell;
    sinceSpark: number;
    age: number;
  }[] = [];
  /** 上昇中の火の粉を全弾ぶん受け持つ常設エミッタ。 */
  private trail!: Emitter;
  private rng: Rng;
  private events: FireworkEvents;
  /** 開花演出の派生（クロセットの二次分裂）待ち行列。 */
  private pending: { t: number; run: () => void }[] = [];
  private clock = 0;
  /**
   * 星の数の倍率（0.4〜1.0）。
   * ピーク時の星は 1.0 で約 22,000 個。内蔵 GPU の端末では下げる。
   */
  quality = 0.8;
  /** 風向（吹いてくる方向、度）。 */
  windFrom = 200;
  /** 風速 (m/s)。 */
  windSpeed = 2.5;
  private windVec = new Vector3();

  constructor(opts: {
    view: ThreeView<any>;
    /** 花火を配置する ENU フレーム（隅田川上の基準点）。 */
    frame: Matrix4;
    /** SelectiveBloom エフェクトの id。 */
    bloomId: string;
    rng: Rng;
    events?: FireworkEvents;
  }) {
    this.view = opts.view;
    this.frame = opts.frame;
    this.bloomId = opts.bloomId;
    this.rng = opts.rng;
    this.events = opts.events ?? {};
    for (let i = 0; i < EMITTER_POOL_SIZE; i++) {
      this.emitters.push(this.createEmitter());
    }
    // 先頭の 1 本を上昇中の火の粉専用に確保する
    this.trail = this.emitters[0]!;
    this.trail.busy = true;
    this.trail.colorHex = 0xffb457;
    this.trail.color.setHex(0xffb457);
    this.trail.peakIntensity = 1.4;
    this.trail.decay = Infinity;
    this.trail.intensity = 1.4;
    this.trail.handle.update({
      spheres: {
        color: this.trail.color,
        emissiveColor: this.trail.color,
        emissiveIntensity: 1.4,
        opacity: 1,
      },
    });
  }

  private createEmitter(): Emitter {
    const color = new Color().setHex(0xffffff);
    const handle = this.view.addMesh<InstancedSphereMeshDesc>({
      spheres: {
        // 星は小さいので粗いジオメトリで十分。頂点数を抑えて数を稼ぐ。
        widthSegments: 6,
        heightSegments: 4,
        color,
        emissiveColor: color,
        emissiveIntensity: 0,
        transparent: true,
        opacity: 1,
        effectIds: [this.bloomId],
        children: [],
      },
      matrixWorld: this.frame,
    });
    return {
      handle,
      particles: [],
      buffer: [],
      color,
      colorHex: 0xffffff,
      peakIntensity: 0,
      intensity: 0,
      decay: 1,
      age: 0,
      busy: false,
      lastIntensity: -1,
      lastOpacity: -1,
    };
  }

  private takeEmitter(colorHex: number, peakIntensity: number, decay: number): Emitter | null {
    const e = this.emitters.find((x) => !x.busy);
    if (!e) return null; // プール枯渇時はその発を捨てる（描画が破綻しないことを優先）
    e.busy = true;
    e.particles.length = 0;
    e.colorHex = colorHex;
    e.color.setHex(colorHex);
    e.peakIntensity = peakIntensity;
    e.intensity = peakIntensity;
    e.decay = decay;
    e.age = 0;
    e.lastIntensity = -1;
    e.lastOpacity = -1;
    e.handle.update({
      spheres: {
        color: e.color,
        emissiveColor: e.color,
        emissiveIntensity: peakIntensity,
        opacity: 1,
      },
    });
    return e;
  }

  private releaseEmitter(e: Emitter) {
    e.busy = false;
    e.particles.length = 0;
    e.buffer.length = 0;
    e.handle.ref.clear();
    if (e.lastIntensity !== 0) {
      e.handle.update({ spheres: { emissiveIntensity: 0, opacity: 0 } });
      e.lastIntensity = 0;
      e.lastOpacity = 0;
    }
  }

  /** 玉を 1 発打ち上げる。 */
  launch(shell: Shell) {
    // 開花高度に達するのに必要な初速（空気抵抗込みで逆算する）
    const v0 = liftVelocityFor(shell.burstAltitude);
    const p = shell.origin.clone();
    // わずかに傾けて打つ（実際の打ち上げ筒も完全な垂直ではない）
    const tilt = this.rng.range(0, 0.05);
    const az = this.rng.range(0, Math.PI * 2);
    const v = new Vector3(
      Math.cos(az) * Math.sin(tilt) * v0,
      Math.sin(az) * Math.sin(tilt) * v0,
      Math.cos(tilt) * v0,
    );
    this.rockets.push({ p, v, shell, sinceSpark: 0, age: 0 });
    // 線形抵抗つき鉛直投射の頂点到達時刻 t = (1/λ)·ln(1 + v0/u)
    const riseTime = Math.log(1 + v0 / RISE_TERMINAL) / RISE_DRAG_LAMBDA;
    this.events.onLaunch?.({ position: p.clone(), riseTime });
  }

  /** 開花させる。 */
  private burst(shell: Shell, at: Vector3, velocity: Vector3) {
    this.events.onBurst?.({
      position: at.clone(),
      kind: shell.kind,
      burstRadius: shell.burstRadius,
      crackle: shell.crackle,
      // 多重芯のときは外側の層の色（配列の末尾）が煙を照らす
      tintColor: new Color().setHex(shell.colors[shell.colors.length - 1]!),
    });

    const layers = shell.colors.length;
    shell.colors.forEach((hex, layerIndex) => {
      // 多重芯：内側の芯は半径を小さくする
      const layerScale = layers === 1 ? 1 : 0.45 + (0.55 * layerIndex) / (layers - 1);
      this.spawnBurstLayer(shell, at, velocity, hex, layerScale);
    });

    if (shell.crackle) {
      // 小割（パチパチ）：短命で小さい白い星を大量に
      const e = this.takeEmitter(0xfff2cc, 2.8, 0.55);
      if (e) {
        const n = Math.round(220 * this.quality);
        for (let i = 0; i < n; i++) {
          const dir = randomUnitVector(this.rng);
          const speed = shell.burstRadius * this.rng.range(0.25, 0.75);
          e.particles.push({
            p: at.clone(),
            v: dir.multiplyScalar(speed).add(velocity.clone().multiplyScalar(0.4)),
            life: this.rng.range(0.5, 1.3),
            maxLife: 1.3,
            size: this.rng.range(0.5, 1.1),
            drag: 0.28,
            gravityScale: 0.6,
            twinkle: 1,
            twinklePhase: this.rng.range(0, Math.PI * 2),
          });
        }
      }
    }
  }

  private spawnBurstLayer(
    shell: Shell,
    at: Vector3,
    velocity: Vector3,
    hex: number,
    layerScale: number,
  ) {
    const kind = shell.kind;
    const profile = KIND_PROFILES[kind];
    const e = this.takeEmitter(hex, profile.intensity, profile.decay);
    if (!e) return;

    const count = Math.max(
      24,
      Math.min(
        MAX_PARTICLES_PER_EMITTER,
        Math.round(profile.count * this.quality * (shell.burstRadius / 120)),
      ),
    );
    // 開花速度：半径 R まで広がるのに必要な初速（抵抗込みの近似）
    const baseSpeed = (shell.burstRadius * layerScale) / profile.spread;
    // 打ち上げ時の慣性を少し引き継ぐ（上に流れる）
    const inherit = velocity.clone().multiplyScalar(profile.inherit);

    for (let i = 0; i < count; i++) {
      const dir =
        kind === "ring"
          ? ringDirection(this.rng, i, count)
          : randomUnitVector(this.rng);
      const speed = baseSpeed * this.rng.range(profile.speedJitter[0], profile.speedJitter[1]);
      const life = profile.life * this.rng.range(0.8, 1.15);
      e.particles.push({
        p: at.clone(),
        v: dir.multiplyScalar(speed).add(inherit),
        life,
        maxLife: life,
        size: profile.size * this.rng.range(0.75, 1.25),
        drag: profile.drag,
        gravityScale: profile.gravityScale,
        twinkle: profile.twinkle,
        twinklePhase: this.rng.range(0, Math.PI * 2),
      });
    }

    if (kind === "crossette") {
      // 十字菊：一定時間後に星が分裂する
      const splitAt = this.clock + profile.life * 0.45;
      this.pending.push({
        t: splitAt,
        run: () => this.splitCrossette(e, hex),
      });
    }
  }

  private splitCrossette(parent: Emitter, hex: number) {
    if (!parent.busy) return;
    const e = this.takeEmitter(hex, 2.0, 0.7);
    if (!e) return;
    // 親の星のうち一部を選び、そこから 4 方向に分裂させる
    const sources = parent.particles.filter((_, i) => i % 4 === 0).slice(0, 60);
    for (const src of sources) {
      if (src.life <= 0) continue;
      for (let k = 0; k < 4; k++) {
        const ang = (Math.PI / 2) * k + this.rng.range(-0.2, 0.2);
        const dir = new Vector3(Math.cos(ang), Math.sin(ang), this.rng.range(-0.3, 0.3)).normalize();
        e.particles.push({
          p: src.p.clone(),
          v: src.v.clone().multiplyScalar(0.35).add(dir.multiplyScalar(this.rng.range(14, 26))),
          life: this.rng.range(0.9, 1.6),
          maxLife: 1.6,
          size: src.size * 0.8,
          drag: 0.42,
          gravityScale: 0.9,
          twinkle: 0.3,
          twinklePhase: this.rng.range(0, Math.PI * 2),
        });
      }
      src.life = Math.min(src.life, 0.05);
    }
  }

  /** 毎フレーム呼ぶ。dt は秒。 */
  update(dt: number) {
    this.clock += dt;

    // 風のベクトル（ENU: x = 東, y = 北）。風向は吹いてくる方向なので +180 度。
    const wr = ((this.windFrom + 180) * Math.PI) / 180;
    this.windVec.set(
      Math.sin(wr) * this.windSpeed,
      Math.cos(wr) * this.windSpeed,
      0,
    );

    // 遅延イベント（分裂など）
    if (this.pending.length) {
      const due = this.pending.filter((x) => x.t <= this.clock);
      this.pending = this.pending.filter((x) => x.t > this.clock);
      for (const d of due) d.run();
    }

    // 上昇中の玉
    for (let i = this.rockets.length - 1; i >= 0; i--) {
      const r = this.rockets[i]!;
      r.v.z -= G * dt;
      // 上昇中の抵抗
      const k = Math.pow(0.86, dt);
      r.v.multiplyScalar(k);
      // 打ち上げ中の玉も風で流される（高く上がるほど着弾点がずれる）
      r.v.x += (this.windVec.x - r.v.x) * (1 - k) * 0.35;
      r.v.y += (this.windVec.y - r.v.y) * (1 - k) * 0.35;
      r.p.addScaledVector(r.v, dt);
      r.sinceSpark += dt;
      r.age += dt;

      // 尾を引く火の粉（全弾で 1 エミッタを共有）
      if (r.sinceSpark > 0.02) {
        r.sinceSpark = 0;
        for (let s = 0; s < 2; s++) {
          if (this.trail.particles.length >= MAX_TRAIL_PARTICLES) break;
          this.trail.particles.push({
            p: r.p.clone(),
            v: new Vector3(
              this.rng.range(-2, 2),
              this.rng.range(-2, 2),
              this.rng.range(-8, -2),
            ),
            life: this.rng.range(0.25, 0.7),
            maxLife: 0.7,
            size: this.rng.range(0.7, 1.6),
            drag: 0.2,
            gravityScale: 0.35,
            twinkle: 0.8,
            twinklePhase: this.rng.range(0, Math.PI * 2),
          });
        }
      }

      // 指定高度に到達、または頂点に達したら開花（保険で時間切れも見る）
      const target = r.shell.origin.z + r.shell.burstAltitude;
      if (r.p.z >= target || r.v.z <= 0 || r.age > 14) {
        this.burst(r.shell, r.p.clone(), r.v.clone());
        this.rockets.splice(i, 1);
      }
    }

    // 星の物理と描画反映
    for (const e of this.emitters) {
      if (!e.busy) continue;
      const isTrail = e === this.trail;
      e.age += dt;

      const ps = e.particles;
      let alive = 0;
      for (let i = 0; i < ps.length; i++) {
        const q = ps[i]!;
        if (q.life <= 0) continue;
        q.life -= dt;
        if (q.life <= 0) continue;
        q.v.z -= G * q.gravityScale * dt;
        q.v.multiplyScalar(Math.pow(1 - q.drag, dt));
        // 風に流される。速度が落ちた星ほど強く流される（抵抗が効くため）。
        const wk = 1 - Math.pow(1 - q.drag, dt);
        q.v.x += (this.windVec.x - q.v.x) * wk * 0.55;
        q.v.y += (this.windVec.y - q.v.y) * wk * 0.55;
        q.p.addScaledVector(q.v, dt);
        ps[alive++] = q;
      }
      ps.length = alive;

      // エミッタ全体の減光。花火は開いた瞬間が最も明るく、あとは急速に落ちる。
      const fade = isTrail ? 1 : Math.exp(-e.age / e.decay);
      e.intensity = e.peakIntensity * fade;

      if (alive === 0 || e.intensity < 0.02) {
        if (isTrail) continue; // 常設エミッタは解放しない
        this.releaseEmitter(e);
        continue;
      }

      // インスタンス設定を組み立てて一括反映（バッファを使い回す）
      const buf = e.buffer;
      while (buf.length < alive) buf.push({ position: { x: 0, y: 0, z: 0 }, radius: 1 });
      for (let i = 0; i < alive; i++) {
        const q = ps[i]!;
        const t = q.life / q.maxLife; // 1 → 0
        // 明滅（星の瞬き）
        const tw =
          1 - q.twinkle * 0.55 * (0.5 + 0.5 * Math.sin(this.clock * 42 + q.twinklePhase));
        // 消えかけの星は小さく暗くなる
        const shrink = 0.35 + 0.65 * t;
        const c = buf[i]!;
        c.position.x = q.p.x;
        c.position.y = q.p.y;
        c.position.z = q.p.z;
        c.radius = q.size * shrink * tw;
      }
      // 先頭 alive 個だけを渡す。slice は必要（replaceAll は length を見る）
      e.handle.ref.replaceAll(
        (alive === buf.length ? buf : buf.slice(0, alive)) as SphereChildConfig[],
      );

      const opacity = Math.min(1, 0.25 + fade);
      // 変化が小さいときは update を省く（毎フレームの余計な再構成を避ける）
      if (
        Math.abs(e.intensity - e.lastIntensity) > 0.05 ||
        Math.abs(opacity - e.lastOpacity) > 0.02
      ) {
        e.handle.update({
          spheres: { emissiveIntensity: e.intensity, opacity },
        });
        e.lastIntensity = e.intensity;
        e.lastOpacity = opacity;
      }
    }
  }

  /** 打ち上げ中・開花中をすべて消す（時刻を飛ばしたときなど）。 */
  reset() {
    this.rockets.length = 0;
    this.pending.length = 0;
    this.trail.particles.length = 0;
    for (const e of this.emitters) {
      if (e.busy && e !== this.trail) this.releaseEmitter(e);
    }
  }

  /** 現在描画されている星の総数。デバッグ表示用。 */
  get particleCount(): number {
    let n = 0;
    for (const e of this.emitters) if (e.busy) n += e.particles.length;
    return n;
  }

  get activeEmitters(): number {
    return this.emitters.reduce((a, e) => a + (e.busy ? 1 : 0), 0);
  }

  dispose() {
    for (const e of this.emitters) e.handle.delete();
    this.emitters.length = 0;
  }
}

type KindProfile = {
  count: number;
  /** 開花半径 / 初速 の係数。大きいほどゆっくり広がる。 */
  spread: number;
  life: number;
  size: number;
  drag: number;
  gravityScale: number;
  intensity: number;
  decay: number;
  twinkle: number;
  inherit: number;
  speedJitter: [number, number];
};

const KIND_PROFILES: Record<ShellKind, KindProfile> = {
  // 牡丹：尾を引かず、丸くぱっと開いて速く消える
  peony: {
    count: 420,
    spread: 1.9,
    life: 2.2,
    size: 1.5,
    drag: 0.55,
    gravityScale: 0.85,
    intensity: 3.0,
    decay: 0.85,
    twinkle: 0.15,
    inherit: 0.18,
    speedJitter: [0.92, 1.06],
  },
  // 菊：星が尾を引きながら開く。寿命が長く、抵抗が小さい
  chrysanthemum: {
    count: 560,
    spread: 1.6,
    life: 3.4,
    size: 1.4,
    drag: 0.38,
    gravityScale: 0.95,
    intensity: 2.7,
    decay: 1.25,
    twinkle: 0.25,
    inherit: 0.2,
    speedJitter: [0.9, 1.08],
  },
  // 冠／しだれ柳：ゆっくり広がり、重力で長く垂れ下がる
  willow: {
    count: 300,
    spread: 2.6,
    life: 5.2,
    size: 2.0,
    drag: 0.22,
    gravityScale: 1.0,
    intensity: 2.2,
    decay: 2.1,
    twinkle: 0.35,
    inherit: 0.25,
    speedJitter: [0.75, 1.0],
  },
  // 型物（輪）：平面上に等間隔で開く
  ring: {
    count: 260,
    spread: 1.7,
    life: 2.6,
    size: 1.6,
    drag: 0.45,
    gravityScale: 0.8,
    intensity: 3.1,
    decay: 1.0,
    twinkle: 0.1,
    inherit: 0.15,
    speedJitter: [0.98, 1.02],
  },
  crossette: {
    count: 240,
    spread: 2.0,
    life: 2.4,
    size: 1.8,
    drag: 0.5,
    gravityScale: 0.85,
    intensity: 2.9,
    decay: 1.0,
    twinkle: 0.2,
    inherit: 0.18,
    speedJitter: [0.95, 1.05],
  },
  // 小玉：連発・スターマイン用
  small: {
    count: 150,
    spread: 1.8,
    life: 1.5,
    size: 1.1,
    drag: 0.6,
    gravityScale: 0.9,
    intensity: 3.25,
    decay: 0.6,
    twinkle: 0.2,
    inherit: 0.22,
    speedJitter: [0.88, 1.1],
  },
};

/** 単位球面上の一様乱数ベクトル。 */
function randomUnitVector(rng: Rng): Vector3 {
  const z = rng.range(-1, 1);
  const a = rng.range(0, Math.PI * 2);
  const r = Math.sqrt(1 - z * z);
  return new Vector3(r * Math.cos(a), r * Math.sin(a), z);
}

/** 輪状（1 枚の平面に等間隔）の方向ベクトル。 */
const RING_BASIS = { u: new Vector3(), v: new Vector3() };
function ringDirection(rng: Rng, i: number, count: number): Vector3 {
  if (i === 0) {
    // 輪の向く平面を 1 発ごとに決める
    const n = randomUnitVector(rng);
    const tmp = Math.abs(n.z) < 0.9 ? new Vector3(0, 0, 1) : new Vector3(1, 0, 0);
    RING_BASIS.u.copy(tmp).cross(n).normalize();
    RING_BASIS.v.copy(n).cross(RING_BASIS.u).normalize();
  }
  const a = (Math.PI * 2 * i) / count;
  return RING_BASIS.u
    .clone()
    .multiplyScalar(Math.cos(a))
    .addScaledVector(RING_BASIS.v, Math.sin(a));
}
