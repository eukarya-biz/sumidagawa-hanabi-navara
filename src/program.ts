import { Vector3 } from "three";
import type { Rng } from "./rng";
import type { Shell, ShellKind } from "./fireworks";

/** 星の色。日本の花火でよく使われる色をベースにしている。 */
export const STAR_COLORS = {
  red: 0xff3b2f,
  orange: 0xff8a2b,
  gold: 0xffc94a,
  silver: 0xfff6e0,
  green: 0x3ddc84,
  blue: 0x3d8bff,
  purple: 0xb35cff,
  pink: 0xff6fae,
  aqua: 0x5fe6ff,
} as const;

const WARM = [STAR_COLORS.red, STAR_COLORS.orange, STAR_COLORS.gold, STAR_COLORS.pink];
const COOL = [STAR_COLORS.blue, STAR_COLORS.aqua, STAR_COLORS.green, STAR_COLORS.purple];
const ALL = Object.values(STAR_COLORS);

/**
 * 打ち上げ会場。座標はすべて ENU ローカル (m)。
 *
 * 打ち上げ筒は台船の上に川に沿って一列に並ぶので、会場は「線分」で持つ。
 * 中心＋方位角で近似すると線が川からずれて陸上から打ち上がってしまう。
 */
export type Venue = {
  id: 0 | 1;
  name: string;
  /** 打ち上げ区間の上流端（ENU ローカル, m）。 */
  a: Vector3;
  /** 打ち上げ区間の下流端（ENU ローカル, m）。 */
  b: Vector3;
  /** 線分のうち実際に使う範囲 [0..1]。 */
  span: [number, number];
  /** 川の中心線からの左右のばらつき（m）。 */
  across: number;
};

/** 番組の場面。 */
export type PhaseName =
  | "opening"
  | "buildup"
  | "second"
  | "main"
  | "starmine"
  | "finale"
  | "interval";

export type Phase = {
  name: PhaseName;
  label: string;
  /** 場面の開始時刻（番組内秒）。 */
  start: number;
  /** 場面の長さ（秒）。 */
  duration: number;
  /** 参加する会場。 */
  venues: (0 | 1)[];
  /** 玉と玉の間隔（秒）の範囲。 */
  interval: [number, number];
  /** 1 回に同時に打つ玉数の範囲。 */
  volley: [number, number];
  kinds: ShellKind[];
  /** 開花半径の範囲（m）。 */
  radius: [number, number];
  /** 開花高度の範囲（m）。 */
  altitude: [number, number];
  /** 小割（パチパチ）が付く確率。 */
  crackle: number;
  /** 多重芯になる確率。 */
  multiCore: number;
  palette: "warm" | "cool" | "all";
};

/**
 * 隅田川花火大会（19:00〜20:30、約 20,000 発）を 256 秒に凝縮した番組。
 *
 * 実際のタイムテーブルに合わせている:
 * - 19:00 第一会場が単独で打ち上げ開始
 * - 19:30 第二会場が加わる（番組内 85 秒 = 全体の 33.3%）
 * - 20:30 両会場とも終了
 *
 * 256 秒 ÷ 90 分 なので、空の時間 1 分が実時間 2.84 秒で流れる。
 */
export const PHASES: Phase[] = [
  {
    name: "opening",
    label: "19:00 オープニング｜第一会場",
    start: 0,
    duration: 46,
    venues: [0],
    interval: [1.8, 3.2],
    volley: [1, 2],
    kinds: ["peony", "chrysanthemum"],
    radius: [70, 110],
    altitude: [220, 300],
    crackle: 0.15,
    multiCore: 0.2,
    palette: "all",
  },
  {
    name: "buildup",
    label: "19:16 第一会場｜間を詰めていく",
    start: 46,
    duration: 39,
    venues: [0],
    interval: [1.1, 2.0],
    volley: [1, 2],
    kinds: ["chrysanthemum", "peony", "ring"],
    radius: [70, 120],
    altitude: [220, 330],
    crackle: 0.25,
    multiCore: 0.35,
    palette: "all",
  },
  {
    name: "second",
    label: "19:30 第二会場 打ち上げ開始",
    start: 85,
    duration: 50,
    venues: [0, 1],
    interval: [1.3, 2.4],
    volley: [1, 2],
    kinds: ["peony", "chrysanthemum", "ring"],
    radius: [60, 115],
    altitude: [200, 320],
    crackle: 0.25,
    multiCore: 0.35,
    palette: "all",
  },
  {
    name: "main",
    label: "19:47 本編｜芯入り・型物",
    start: 135,
    duration: 50,
    venues: [0, 1],
    interval: [1.0, 1.9],
    volley: [1, 3],
    kinds: ["chrysanthemum", "willow", "ring", "crossette", "peony"],
    radius: [70, 130],
    altitude: [230, 360],
    crackle: 0.35,
    multiCore: 0.5,
    palette: "all",
  },
  {
    name: "starmine",
    label: "20:05 スターマイン｜速射連発",
    start: 185,
    duration: 35,
    venues: [0, 1],
    interval: [0.45, 0.8],
    volley: [2, 3],
    kinds: ["small", "small", "peony"],
    radius: [35, 75],
    altitude: [130, 230],
    crackle: 0.2,
    multiCore: 0.15,
    palette: "warm",
  },
  {
    name: "finale",
    label: "20:17 フィナーレ｜大玉連続",
    start: 220,
    duration: 30,
    venues: [0, 1],
    interval: [0.7, 1.2],
    volley: [2, 3],
    kinds: ["chrysanthemum", "willow", "peony", "crossette", "small"],
    radius: [80, 145],
    altitude: [250, 400],
    crackle: 0.55,
    multiCore: 0.6,
    palette: "all",
  },
  {
    name: "interval",
    label: "20:28 打ち上げ終了｜余韻",
    start: 250,
    duration: 6,
    venues: [],
    interval: [99, 99],
    volley: [0, 0],
    kinds: ["peony"],
    radius: [60, 60],
    altitude: [200, 200],
    crackle: 0,
    multiCore: 0,
    palette: "all",
  },
];

export const PROGRAM_LENGTH = PHASES.reduce((a, p) => Math.max(a, p.start + p.duration), 0);

/**
 * 番組を進行させ、打ち上げるべき玉を返すスケジューラ。
 */
export class ShowProgram {
  private rng: Rng;
  private venues: Venue[];
  /** 会場ごとの次の打ち上げ時刻。 */
  private nextAt: number[];
  private t = 0;

  constructor(venues: Venue[], rng: Rng) {
    this.venues = venues;
    this.rng = rng;
    this.nextAt = venues.map(() => 0);
  }

  get time(): number {
    return this.t;
  }

  get progress(): number {
    return (this.t % PROGRAM_LENGTH) / PROGRAM_LENGTH;
  }

  get phase(): Phase {
    const local = this.t % PROGRAM_LENGTH;
    let current = PHASES[0]!;
    for (const p of PHASES) {
      if (local >= p.start) current = p;
    }
    return current;
  }

  /** 経過時間を進め、この間に打ち上がる玉を返す。 */
  advance(dt: number): Shell[] {
    const out: Shell[] = [];
    this.t += dt;
    const phase = this.phase;

    for (const venue of this.venues) {
      if (!phase.venues.includes(venue.id)) continue;
      if (this.t < this.nextAt[venue.id]!) continue;

      const volley = this.rng.int(phase.volley[0], phase.volley[1]);
      for (let i = 0; i < volley; i++) {
        out.push(this.makeShell(venue, phase));
      }
      this.nextAt[venue.id] =
        this.t + this.rng.range(phase.interval[0], phase.interval[1]);
    }
    return out;
  }

  private makeShell(venue: Venue, phase: Phase): Shell {
    // 川の中心線（線分 a→b）上の 1 点を選ぶ。これで必ず川の上から上がる。
    const t = this.rng.range(venue.span[0], venue.span[1]);
    const origin = venue.a.clone().lerp(venue.b, t);

    // 中心線に直交する水平方向に少しばらす（台船の幅ぶん）
    const dir = venue.b.clone().sub(venue.a);
    dir.z = 0;
    if (dir.lengthSq() > 1e-6) {
      dir.normalize();
      const perp = new Vector3(-dir.y, dir.x, 0);
      origin.addScaledVector(perp, this.rng.range(-venue.across, venue.across));
    }

    const pool =
      phase.palette === "warm" ? WARM : phase.palette === "cool" ? COOL : ALL;
    const colors: number[] = [this.rng.pick(pool)];
    if (this.rng.chance(phase.multiCore)) {
      // 芯入り：外側と違う色を内側に入れる
      let inner = this.rng.pick(pool);
      let guard = 0;
      while (inner === colors[0] && guard++ < 8) inner = this.rng.pick(pool);
      colors.unshift(inner);
    }

    return {
      kind: this.rng.pick(phase.kinds),
      origin,
      burstAltitude: this.rng.range(phase.altitude[0], phase.altitude[1]),
      burstRadius: this.rng.range(phase.radius[0], phase.radius[1]),
      colors,
      crackle: this.rng.chance(phase.crackle),
    };
  }

  /** 番組の頭に戻す。 */
  reset() {
    this.t = 0;
    this.nextAt = this.nextAt.map(() => 0);
  }

  /** 番組内の任意時刻へ飛ばす。 */
  seek(seconds: number) {
    this.t = seconds;
    this.nextAt = this.nextAt.map(() => seconds);
  }
}
