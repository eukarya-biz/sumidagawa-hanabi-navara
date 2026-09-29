import ThreeView, { Color, type MeshHandle } from "@navaramap/three";
import type { DefaultDescriptions } from "@navaramap/three-default-plugin";
import {
  InstancedSphereMeshDesc,
  type SphereChildConfig,
} from "@navaramap/three-default-descs";
import { Matrix4, Vector3 } from "three";
import type { Rng } from "./rng";

/**
 * 花火の煙。
 *
 * 実際の花火大会では、煙は演出の一部というより**邪魔者**です。
 * 無風だと打ち上げ場所の上空に煙が滞留して、後半の玉が
 * 白い霞の向こうにぼんやり見えるだけになります。
 * 逆に風が 3〜5 m/s あると煙が流されて、最後まできれいに見えます。
 * その差をシミュレーションできるようにしています。
 *
 * 実装上のポイント：
 * - 煙は Bloom に入れない。発光値が閾値の境目にあると、閃光で染まった
 *   瞬間だけピクセル単位で滲みが点いたり消えたりして、輪郭が階段状になる
 * - 半透明度はマテリアル共有なので、粒ごとの「薄れ」は
 *   インスタンス色を背景（夜空、昼は霞）の色へ近づけることで表現する
 * - 粒は時間とともに膨張する（煙は広がりながら薄まる）
 */
export class SmokeSystem {
  private handle: MeshHandle<InstancedSphereMeshDesc>;
  private particles: {
    p: Vector3;
    v: Vector3;
    age: number;
    life: number;
    r0: number;
    /** 膨張速度 (m/s)。 */
    grow: number;
    /**
     * 花火の光に照らされた色。
     * 実際の煙は開花した玉の色に染まって光る。赤玉なら赤く、金なら金色に。
     * 開花の閃光は短いので、この色は 1 秒ほどで灰色に落ちる。
     */
    tint: Color;
    /** 染まりの強さ。玉が大きいほど強く光る。 */
    tintPower: number;
  }[] = [];
  private buffer: {
    position: { x: number; y: number; z: number };
    radius: number;
    color: Color;
  }[] = [];
  private rng: Rng;
  private max: number;

  /** 風向（度）。気象の慣習どおり「風が吹いてくる方向」。0 = 北風。 */
  windFrom = 200;
  /** 風速 (m/s)。 */
  windSpeed = 2.5;
  /** 煙の量の倍率 0〜1。0 で煙なし。 */
  amount = 0.7;

  /** 花火の光が消えたあとの煙の色（月と街の明かりを受けた灰）。 */
  private static FRESH = new Color().setStyle("#9aa0ad");
  /** 夜の消える直前の色。夜空に溶ける。 */
  private static FADED_NIGHT = new Color().setStyle("#0b0d14");
  /** 昼の消える直前の色。遠景の霞に溶ける。 */
  private static FADED_DAY = new Color().setStyle("#c8d2df");
  /** 現在の消える直前の色。昼夜に合わせて setDaylight() が更新する。 */
  private faded = new Color().setStyle("#0b0d14");
  /** 打ち上げ筒の閃光の色。 */
  private static MUZZLE = new Color().setStyle("#ffb457");
  /** 染まりが消えるまでの時定数（秒）。開花の閃光の長さ。 */
  private static TINT_DECAY = 1.1;

  constructor(opts: {
    view: ThreeView<DefaultDescriptions>;
    frame: Matrix4;
    rng: Rng;
    /** 同時に保持する煙の粒の上限。 */
    max?: number;
  }) {
    this.rng = opts.rng;
    this.max = opts.max ?? 3600;
    this.handle = opts.view.addMesh<InstancedSphereMeshDesc>({
      spheres: {
        // 不透明度 0.18 の球は輪郭がぼやけるので、細分しても違いが見えない
        widthSegments: 5,
        heightSegments: 4,
        color: new Color().setStyle("#9aa0ad"),
        transparent: true,
        opacity: 0.18,
        children: [],
      },
      matrixWorld: opts.frame,
    });
  }

  /** 昼夜に合わせて消え際の色を更新する。daylight は 0（夜）〜 1（昼）。 */
  setDaylight(daylight: number) {
    this.faded.raw
      .copy(SmokeSystem.FADED_NIGHT.raw)
      .lerp(SmokeSystem.FADED_DAY.raw, daylight);
  }

  /** ENU ローカル座標での風のベクトル (m/s)。 */
  windVector(target = new Vector3()): Vector3 {
    // 風向は「吹いてくる方向」なので、進む向きは +180 度
    const rad = ((this.windFrom + 180) * Math.PI) / 180;
    // ENU: x = 東, y = 北。方位角は北から時計回り。
    return target.set(
      Math.sin(rad) * this.windSpeed,
      Math.cos(rad) * this.windSpeed,
      0,
    );
  }

  /**
   * 開花点に煙を発生させる。
   * @param at 開花点（ENU ローカル, m）
   * @param burstRadius 開花半径 (m)。大きい玉ほど煙も多い。
   * @param quality 描画品質の倍率
   * @param tint 玉の色。この色に煙が染まる。
   */
  spawnBurst(at: Vector3, burstRadius: number, quality: number, tint?: Color) {
    if (this.amount <= 0.01) return;
    // 粒は少なく大きく。細かい粒を多く出すと「球の集合」に見え、
    // 重なりが増えて描画コストも上がる。
    const n = Math.max(2, Math.round(20 * this.amount * quality * (burstRadius / 90)));
    for (let i = 0; i < n; i++) {
      if (this.particles.length >= this.max) break;
      const dir = new Vector3(
        this.rng.range(-1, 1),
        this.rng.range(-1, 1),
        this.rng.range(-0.4, 0.6),
      ).normalize();
      this.particles.push({
        p: at.clone().addScaledVector(dir, this.rng.range(0, burstRadius * 0.45)),
        v: dir.multiplyScalar(this.rng.range(2, 9)),
        age: 0,
        // 無風だと滞留するが、長すぎると視界を覆ってしまう。
        life: this.rng.range(7, 14),
        r0: this.rng.range(5, 11) * (burstRadius / 90),
        // 膨張が速すぎると 1 粒が直径 100m 超の球になり、街を隠す。
        grow: this.rng.range(0.3, 0.8),
        tint: (tint ?? SmokeSystem.FRESH).clone(),
        // 大きい玉ほど煙を強く照らす
        tintPower: Math.min(1.5, burstRadius / 90) * this.rng.range(0.75, 1.15),
      });
    }
  }

  /** 打ち上げ時に筒口から出る煙。低い位置に溜まる。 */
  spawnLaunch(at: Vector3, quality: number) {
    if (this.amount <= 0.01) return;
    const n = Math.max(1, Math.round(6 * this.amount * quality));
    for (let i = 0; i < n; i++) {
      if (this.particles.length >= this.max) break;
      this.particles.push({
        p: at.clone(),
        v: new Vector3(this.rng.range(-2, 2), this.rng.range(-2, 2), this.rng.range(2, 6)),
        age: 0,
        life: this.rng.range(5, 10),
        r0: this.rng.range(2, 5),
        grow: this.rng.range(0.3, 0.8),
        tint: SmokeSystem.MUZZLE.clone(),
        tintPower: 0.55,
      });
    }
  }

  private wind = new Vector3();
  private tmpColor = new Color().setStyle("#000000");
  private tmpLit = new Color().setStyle("#000000");

  update(dt: number) {
    this.windVector(this.wind);
    const ps = this.particles;
    let alive = 0;

    for (let i = 0; i < ps.length; i++) {
      const q = ps[i]!;
      q.age += dt;
      if (q.age >= q.life) continue;

      // 煙はすぐに気流に乗る。自分の初速は指数的に失われ、風速に漸近する。
      const k = Math.pow(0.25, dt);
      q.v.x = this.wind.x + (q.v.x - this.wind.x) * k;
      q.v.y = this.wind.y + (q.v.y - this.wind.y) * k;
      // 上下は熱で少し上がってから、ゆっくり落ち着く
      q.v.z = q.v.z * Math.pow(0.55, dt) + 0.35 * dt;

      q.p.addScaledVector(q.v, dt);
      ps[alive++] = q;
    }
    ps.length = alive;

    if (alive === 0) {
      if (this.buffer.length) {
        this.buffer.length = 0;
        this.handle.ref.clear();
      }
      return;
    }

    const buf = this.buffer;
    while (buf.length < alive) {
      buf.push({
        position: { x: 0, y: 0, z: 0 },
        radius: 1,
        color: new Color().setStyle("#000000"),
      });
    }

    for (let i = 0; i < alive; i++) {
      const q = ps[i]!;
      const t = q.age / q.life; // 0 → 1
      const c = buf[i]!;
      c.position.x = q.p.x;
      c.position.y = q.p.y;
      c.position.z = q.p.z;
      // 膨張しながら薄まる
      c.radius = q.r0 + q.grow * q.age;
      // 1. 灰 → 背景色（夜空、昼は霞）。「薄れ」は不透明度が共有なので色で表現する。
      // 指数を小さくすると早い段階で背景に溶けるので、煙が視界に残りにくい。
      const f = Math.min(1, Math.pow(t, 0.45));
      this.tmpColor.raw.copy(SmokeSystem.FRESH.raw).lerp(this.faded.raw, f);

      // 2. 花火の光に照らされた分を足す。閃光は短いので急速に減衰する。
      const flash = Math.exp(-q.age / SmokeSystem.TINT_DECAY) * q.tintPower;
      if (flash > 0.01) {
        // 明るさは「玉の色」の側に掛ける。
        // 混ぜたあとに掛けると全チャンネルが持ち上がって白飛びし、
        // 赤玉でも金玉でも白い煙になってしまう（実測して気づいた）。
        this.tmpLit.raw.copy(q.tint.raw).multiplyScalar(1 + flash * 1.6);
        this.tmpColor.raw.lerp(this.tmpLit.raw, Math.min(0.92, flash));
      }
      c.color.raw.copy(this.tmpColor.raw);
    }

    this.handle.ref.replaceAll(
      (alive === buf.length ? buf : buf.slice(0, alive)) as SphereChildConfig[],
    );
  }

  get count(): number {
    return this.particles.length;
  }

  reset() {
    this.particles.length = 0;
    this.buffer.length = 0;
    this.handle.ref.clear();
  }

  dispose() {
    this.handle.delete();
  }
}
