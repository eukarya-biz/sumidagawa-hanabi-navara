/**
 * 隅田川の水面と、川沿いの立入禁止帯。
 *
 * **編集するのは中心線 1 本だけです。**
 *
 *   public/data/river-centerline.geojson
 *
 * このファイルの LineString を QGIS で動かせば、
 *   - 水面のポリゴン
 *   - 川沿いの立入禁止区域（両岸の帯）
 * の両方が自動で追従します。両岸を手でそろえる必要はありません。
 *
 * 川幅はフィーチャーの `width`（m）で指定します（既定 110 m）。
 * 実際の隅田川は浅草付近で 150〜200 m ありますが、岸にはみ出して
 * 建物や道路が光ると台無しなので、狭めに取ってあります。
 *
 * 初期データは国土地理院の実測座標による橋の中心を結んだ線です。
 */

/** 経度・緯度の組。 */
type LngLat = [number, number];

/** 緯度 1 度あたりのメートル数（東京付近）。 */
const M_PER_DEG_LAT = 111132;
/** 経度 1 度あたりのメートル数（緯度 35.71 度）。 */
const M_PER_DEG_LNG = 111320 * Math.cos((35.71 * Math.PI) / 180);

/**
 * 中心線のフォールバック（上流 → 下流）。
 * ファイルを読めなかったときに使う。すべて隅田川に架かる橋の中心。
 */
const FALLBACK_CENTERLINE: LngLat[] = [
  [139.808405, 35.719849], // 桜橋の 260 m 上流（延長点）
  [139.806508, 35.718091], // 桜橋（第一会場の上流端）
  [139.802390, 35.714274], // 言問橋（第一会場の下流端）
  [139.797879, 35.710223], // 吾妻橋
  [139.796243, 35.708205], // 駒形橋（第二会場の上流端）
  [139.794809, 35.704907], // 厩橋（第二会場の下流端）
  [139.792391, 35.700954], // 蔵前橋
  [139.787938, 35.694021], // 両国橋
  [139.786606, 35.691947], // 両国橋の 260 m 下流（延長点）
];

export type GeoJson = {
  type: "FeatureCollection";
  features: {
    type: "Feature";
    properties?: Record<string, unknown> | null;
    geometry: { type: string; coordinates: unknown };
  }[];
};

/** 読み込んだ中心線と川幅。 */
export type River = {
  centerline: LngLat[];
  /** 川幅（m）。 */
  width: number;
};

/**
 * 日本国内なら経度 122〜154、緯度 20〜46。
 * 「緯度, 経度」の順で入っていたら入れ替える（GIS ツールで最も多い間違い）。
 */
function fixOrder(c: LngLat): LngLat {
  const [a, b] = c;
  if (a >= 20 && a <= 46 && b >= 122 && b <= 154) return [b, a];
  return [a, b];
}

/** 中心線を GeoJSON ファイルから読み込む。失敗したら初期値を使う。 */
export async function loadRiver(
  url = "data/river-centerline.geojson",
): Promise<River> {
  const fallback: River = { centerline: FALLBACK_CENTERLINE, width: 110 };
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json()) as GeoJson;
    const f = json?.features?.find(
      (x) => x.geometry?.type === "LineString" || x.geometry?.type === "MultiLineString",
    );
    if (!f) throw new Error("LineString が見つかりません");
    const raw =
      f.geometry.type === "MultiLineString"
        ? (f.geometry.coordinates as LngLat[][])[0]!
        : (f.geometry.coordinates as LngLat[]);
    const centerline = raw.map((c) => fixOrder([Number(c[0]), Number(c[1])]));
    if (centerline.length < 2) throw new Error("点が足りません");
    const w = Number(f.properties?.["width"]);
    return { centerline, width: Number.isFinite(w) && w > 0 ? w : 110 };
  } catch (e) {
    console.warn(`[river] ${url} を読み込めませんでした。初期値を使います:`, e);
    return fallback;
  }
}

/**
 * 中心線を法線方向に inner〜outer だけオフセットした帯（リング）を作る。
 * @param side +1 で左岸側、-1 で右岸側
 */
function band(line: LngLat[], inner: number, outer: number, side: 1 | -1): LngLat[] {
  const A: LngLat[] = [];
  const B: LngLat[] = [];
  for (let i = 0; i < line.length; i++) {
    const p0 = line[Math.max(0, i - 1)]!;
    const p1 = line[Math.min(line.length - 1, i + 1)]!;
    const tx = (p1[0] - p0[0]) * M_PER_DEG_LNG;
    const ty = (p1[1] - p0[1]) * M_PER_DEG_LAT;
    const len = Math.hypot(tx, ty) || 1;
    const nx = (-ty / len) * side;
    const ny = (tx / len) * side;
    const p = line[i]!;
    A.push([p[0] + (nx * inner) / M_PER_DEG_LNG, p[1] + (ny * inner) / M_PER_DEG_LAT]);
    B.push([p[0] + (nx * outer) / M_PER_DEG_LNG, p[1] + (ny * outer) / M_PER_DEG_LAT]);
  }
  const ring = [...A, ...B.reverse()];
  ring.push(ring[0]!);
  return ring;
}

const fc = (
  features: { name: string; ring: LngLat[] }[],
): GeoJson => ({
  type: "FeatureCollection",
  features: features.map((f) => ({
    type: "Feature",
    properties: { name: f.name },
    geometry: { type: "Polygon", coordinates: [f.ring] },
  })),
});

/**
 * 任意の地点を中心線上に投影する。
 *
 * 会場の打ち上げ位置や橋の上の視点は、国土地理院の地名検索で得た
 * 座標を使っているが、それは川の中心とは限らない（橋の名称の代表点は
 * 端に寄っていることがある）。中心線に落としてから使うことで、
 * **描いた川の上に必ず載る**ようにしている。
 */
export function projectOnCenterline(river: River, p: LngLat): LngLat {
  const line = river.centerline;
  let best: { d: number; q: LngLat } = { d: Infinity, q: p };
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1]!;
    const b = line[i]!;
    const dx = (b[0] - a[0]) * M_PER_DEG_LNG;
    const dy = (b[1] - a[1]) * M_PER_DEG_LAT;
    const l2 = dx * dx + dy * dy || 1;
    let t = (((p[0] - a[0]) * M_PER_DEG_LNG) * dx + ((p[1] - a[1]) * M_PER_DEG_LAT) * dy) / l2;
    t = Math.max(0, Math.min(1, t));
    const q: LngLat = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    const d = Math.hypot(
      (q[0] - p[0]) * M_PER_DEG_LNG,
      (q[1] - p[1]) * M_PER_DEG_LAT,
    );
    if (d < best.d) best = { d, q };
  }
  return best.q;
}

/** 中心線から水面のポリゴンを作る。 */
export function riverSurface(river: River): GeoJson {
  const half = river.width / 2;
  return fc([
    { name: "隅田川 水面", ring: band(river.centerline, -half, half, 1) },
  ]);
}

/**
 * 中心線から、川沿いの立入禁止帯（両岸）を作る。
 * 岸の線から陸側へ `depth` メートル。親水テラス・隅田公園にあたる。
 */
export function riversideNoEntry(river: River, depth = 70): GeoJson {
  const half = river.width / 2;
  return fc([
    { name: "立入禁止区域（西岸）", ring: band(river.centerline, half, half + depth, 1) },
    { name: "立入禁止区域（東岸）", ring: band(river.centerline, half, half + depth, -1) },
  ]);
}
