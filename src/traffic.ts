/**
 * 交通規制と歩行者動線。
 *
 * データは TypeScript ではなく **GeoJSON ファイル**で持っています。
 *
 *   public/data/traffic-regulation.geojson   交通規制区間
 *   public/data/pedestrian-flow.geojson      歩行者の進行方向
 *
 * この 2 つを差し替えれば表示が変わります。コードを触る必要はありません。
 * 仕様は README の「交通規制と歩行者動線」を参照してください。
 *
 * ⚠️ 同梱しているのは概略値です。公式の道路規制図は文字情報を持たない
 * 画像 PDF のため機械的に読み取れませんでした。実際の通行判断には使えません。
 */

import ThreeView, { Color, type MeshHandle } from "@navaramap/three";
import {
  InstancedPlaneMeshDesc,
  type PlaneChildConfig,
} from "@navaramap/three-default-descs";
import { Matrix4, Vector3 } from "three";
import { enuOffset, type Geodetic } from "./geo";
import { REFERENCE } from "./viewpoints";

/** 経度・緯度の組。 */
type LngLat = [number, number];

/** 交通規制の区間。 */
export type RegulationRoute = {
  name: string;
  /** 規制の種類。色分けに使う。 */
  kind: "vehicle" | "bridge";
  path: LngLat[];
};

/** 歩行者の進行方向（一方通行の動線）。 */
export type PedestrianRoute = {
  name: string;
  /** 進行方向に並べた点列。矢印はこの向きに流れる。 */
  path: LngLat[];
  /** 動線の色。 */
  color: number;
};

// ---------------------------------------------------------------------------
// GeoJSON の読み込み
// ---------------------------------------------------------------------------

type Feature = {
  type: "Feature";
  properties?: Record<string, unknown> | null;
  geometry: {
    type: "LineString" | "MultiLineString";
    coordinates: LngLat[] | LngLat[][];
  };
};

export type RouteGeoJson = {
  type: "FeatureCollection";
  features: Feature[];
};

/**
 * 座標が「緯度, 経度」の順で入っていないか調べる。
 * 日本国内なら経度は 122〜154、緯度は 20〜46 の範囲なので判別できる。
 * GIS ツールからの書き出しでいちばん多い間違いなので、自動で直して警告する。
 */
function fixOrder(c: LngLat): LngLat {
  const [a, b] = c;
  if (a >= 20 && a <= 46 && b >= 122 && b <= 154) return [b, a];
  return [a, b];
}

/** LineString / MultiLineString をまとめて点列の配列に開く。 */
function toPaths(f: Feature): LngLat[][] {
  const g = f.geometry;
  const raw =
    g.type === "MultiLineString"
      ? (g.coordinates as LngLat[][])
      : [g.coordinates as LngLat[]];
  return raw
    .map((line) => line.map((c) => fixOrder([Number(c[0]), Number(c[1])])))
    .filter((line) => line.length >= 2);
}

/** GeoJSON を取得する。失敗しても作品全体は動き続ける。 */
async function loadGeoJson(url: string): Promise<RouteGeoJson | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json()) as RouteGeoJson;
    if (json?.type !== "FeatureCollection" || !Array.isArray(json.features)) {
      throw new Error("FeatureCollection ではありません");
    }
    return json;
  } catch (e) {
    console.warn(`[traffic] ${url} を読み込めませんでした:`, e);
    return null;
  }
}

/** 交通規制区間を読み込む。 */
export async function loadRegulationRoutes(
  url = "data/traffic-regulation.geojson",
): Promise<RegulationRoute[]> {
  const json = await loadGeoJson(url);
  if (!json) return [];
  const out: RegulationRoute[] = [];
  for (const f of json.features) {
    const name = String(f.properties?.["name"] ?? "");
    const kindRaw = String(f.properties?.["kind"] ?? "vehicle");
    const kind: RegulationRoute["kind"] = kindRaw === "bridge" ? "bridge" : "vehicle";
    for (const path of toPaths(f)) out.push({ name, kind, path });
  }
  return out;
}

/** 歩行者の進行方向を読み込む。点の並び順がそのまま進行方向になる。 */
export async function loadPedestrianRoutes(
  url = "data/pedestrian-flow.geojson",
): Promise<PedestrianRoute[]> {
  const json = await loadGeoJson(url);
  if (!json) return [];
  const out: PedestrianRoute[] = [];
  for (const f of json.features) {
    const name = String(f.properties?.["name"] ?? "");
    const raw = f.properties?.["color"];
    let color = 0xffb457;
    if (typeof raw === "string" && /^#?[0-9a-fA-F]{6}$/.test(raw)) {
      color = Number.parseInt(raw.replace("#", ""), 16);
    } else if (typeof raw === "number") {
      color = raw;
    }
    for (const path of toPaths(f)) out.push({ name, path, color });
  }
  return out;
}

// ---------------------------------------------------------------------------
// GeoJSON への変換（レイヤーに渡す用）
// ---------------------------------------------------------------------------

export function regulationGeoJson(routes: RegulationRoute[]): RouteGeoJson {
  return {
    type: "FeatureCollection",
    features: routes.map((r) => ({
      type: "Feature",
      properties: { name: r.name, kind: r.kind },
      geometry: { type: "LineString", coordinates: r.path },
    })),
  };
}

// ---------------------------------------------------------------------------
// 歩行者動線の矢印（流れる点線）
// ---------------------------------------------------------------------------

/** 折れ線を等間隔で辿るための前処理済みデータ。 */
type Polyline = {
  /** ENU ローカル座標の点列。 */
  pts: Vector3[];
  /** 各点までの累積距離 (m)。 */
  acc: number[];
  /** 全長 (m)。 */
  length: number;
  color: Color;
};

/**
 * 歩行者の進行方向を、地面を流れる点線（矢印）で表す。
 *
 * `InstancedPlaneMeshDesc` の平面を地面に寝かせ、進行方向に合わせて
 * Z 軸まわりに回転させている。ENU フレームでは +Z が真上なので、
 * 回転なしの平面はそのまま地面に寝る。
 *
 * 夜は Bloom に参加させて光らせる。昼は発光を落とす。
 */
export class PedestrianFlow {
  private handle: MeshHandle<InstancedPlaneMeshDesc>;
  private lines: Polyline[] = [];
  private buffer: PlaneChildConfig[] = [];
  private phase = 0;
  private _visible = true;
  private _daylight = 0;

  /** 矢印の間隔 (m)。 */
  private static SPACING = 26;
  /** 矢印の流れる速さ (m/s)。歩く速さより少し速くして流れを分かりやすくする。 */
  private static SPEED = 9;
  /** 矢印の長さ・幅 (m)。 */
  private static DASH_LENGTH = 11;
  private static DASH_WIDTH = 3.4;

  constructor(opts: {
    view: ThreeView<any>;
    frame: Matrix4;
    bloomId: string;
    /** 道路面の楕円体高。 */
    groundHeight: number;
    routes: PedestrianRoute[];
  }) {
    this.build(opts.routes, opts.groundHeight);

    this.handle = opts.view.addMesh<InstancedPlaneMeshDesc>({
      planes: {
        color: new Color().setStyle("#ffffff"),
        // emissiveColor は設定しない。未設定だとインスタンスごとの色が
        // Bloom のソースになるので、動線ごとに色を変えられる。
        emissiveIntensity: 1.2,
        effectIds: [opts.bloomId],
        transparent: true,
        opacity: 0.9,
        children: [],
      },
      matrixWorld: opts.frame,
    });
  }

  /** 経緯度の点列を ENU ローカルに直し、累積距離を計算しておく。 */
  private build(routes: PedestrianRoute[], ground: number) {
    for (const r of routes) {
      const pts = r.path.map(([lng, lat]) => {
        const g: Geodetic = { lng, lat, height: ground };
        return enuOffset(REFERENCE, g);
      });
      const acc: number[] = [0];
      for (let i = 1; i < pts.length; i++) {
        // 水平距離だけで測る（道路の起伏は無視してよい）
        const a = pts[i - 1]!;
        const b = pts[i]!;
        acc.push(acc[i - 1]! + Math.hypot(b.x - a.x, b.y - a.y));
      }
      this.lines.push({
        pts,
        acc,
        length: acc[acc.length - 1]!,
        color: new Color().setHex(r.color),
      });
    }
  }

  /** 折れ線上の距離 s (m) にあたる位置と進行方向（ラジアン）を返す。 */
  private sample(line: Polyline, s: number): { p: Vector3; heading: number } | null {
    if (line.length <= 0) return null;
    const t = ((s % line.length) + line.length) % line.length;
    let i = 1;
    while (i < line.acc.length - 1 && line.acc[i]! < t) i++;
    const a = line.pts[i - 1]!;
    const b = line.pts[i]!;
    const seg = line.acc[i]! - line.acc[i - 1]!;
    const f = seg > 0 ? (t - line.acc[i - 1]!) / seg : 0;
    return {
      p: new Vector3(
        a.x + (b.x - a.x) * f,
        a.y + (b.y - a.y) * f,
        a.z + (b.z - a.z) * f,
      ),
      // ENU の +X が東、+Y が北。平面の長辺（X 軸）を進行方向に向ける。
      heading: Math.atan2(b.y - a.y, b.x - a.x),
    };
  }

  get visible(): boolean {
    return this._visible;
  }

  setVisible(v: boolean) {
    this._visible = v;
    this.handle.visible = v;
  }

  /** @param daylight 0（夜）〜1（昼） */
  setDaylight(daylight: number) {
    if (Math.abs(daylight - this._daylight) < 0.05) return;
    this._daylight = daylight;
    // 夜は光らせ、昼は発光を落として普通の塗りにする
    this.handle.update({
      planes: { emissiveIntensity: 0.3 + (1 - daylight) * 1.1 },
    });
  }

  /** 毎フレーム呼ぶ。dt は秒。 */
  update(dt: number) {
    if (!this._visible) return;
    this.phase += dt * PedestrianFlow.SPEED;

    const buf = this.buffer;
    let n = 0;
    for (const line of this.lines) {
      const count = Math.max(1, Math.floor(line.length / PedestrianFlow.SPACING));
      for (let k = 0; k < count; k++) {
        const s = this.phase + k * PedestrianFlow.SPACING;
        const hit = this.sample(line, s);
        if (!hit) continue;
        while (buf.length <= n) {
          buf.push({
            position: { x: 0, y: 0, z: 0 },
            rotation: { x: 0, y: 0, z: 0 },
            width: PedestrianFlow.DASH_LENGTH,
            height: PedestrianFlow.DASH_WIDTH,
            color: new Color().setStyle("#ffffff"),
          });
        }
        const c = buf[n]!;
        c.position!.x = hit.p.x;
        c.position!.y = hit.p.y;
        // 道路の少し上に浮かせる。地面と同じ高さだと Z ファイティングになる。
        c.position!.z = hit.p.z + 0.6;
        c.rotation!.z = hit.heading;
        c.color!.raw.copy(line.color.raw);
        n++;
      }
    }
    this.handle.ref.replaceAll(n === buf.length ? buf : buf.slice(0, n));
  }

  get count(): number {
    return this.buffer.length;
  }

  dispose() {
    this.handle.delete();
  }
}
