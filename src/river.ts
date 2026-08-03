/**
 * 隅田川の水面ポリゴンを作る。
 *
 * Navara の水面表現は「ポリゴンのマテリアルに `water: true` を立てる」
 * 方式です（地形レイヤー側には水面のパラメータがありません）。
 * そのため、川の形をしたポリゴンを 1 枚敷いて水面にします。
 *
 * 川の形は、隅田川に架かる橋の中心を結んだ線を中心線として、
 * 左右に一定距離オフセットして作っています。
 * 橋の座標は国土地理院の地名検索 API の実測値です。
 * 実際の隅田川の川幅は浅草付近で 150〜200 m ありますが、
 * 岸にはみ出して建物や道路が光ると不自然なので、
 * 少し狭め（既定 110 m）に取っています。
 */

/**
 * 中心線（上流 → 下流）。すべて隅田川に架かる橋の中心。
 *
 * 白鬚橋（桜橋の 1.1 km 上流）は入れていない。
 * そこまで直線で結ぶと川が曲がっている区間を突っ切って
 * ポリゴンが隅田公園の上に乗ってしまう（方位が 30 度変わる）。
 * 上流端・下流端は接線方向に少しだけ延長して逃がす。
 */
export const RIVER_CENTERLINE: [number, number][] = [
  [139.806508, 35.718091], // 桜橋（第一会場の上流端）
  [139.802390, 35.714274], // 言問橋（第一会場の下流端）
  [139.797879, 35.710223], // 吾妻橋
  [139.796243, 35.708205], // 駒形橋（第二会場の上流端）
  [139.794809, 35.704907], // 厩橋（第二会場の下流端）
  [139.792391, 35.700954], // 蔵前橋
  [139.787938, 35.694021], // 両国橋
];

/** 緯度 1 度あたりのメートル数（東京付近）。 */
const M_PER_DEG_LAT = 111132;
/** 経度 1 度あたりのメートル数（緯度 35.71 度）。 */
const M_PER_DEG_LNG = 111320 * Math.cos((35.71 * Math.PI) / 180);

/**
 * 中心線を左右にオフセットして川のポリゴンを作る。
 * @param halfWidth 中心線からの片側の幅（m）
 */
export type RiverGeoJson = {
  type: "FeatureCollection";
  features: {
    type: "Feature";
    properties: { name: string };
    geometry: { type: "Polygon"; coordinates: [number, number][][] };
  }[];
};

/**
 * 中心線の両端を接線方向に延長する。
 * 端の橋に立ったときに、背後や前方に水面がないと不自然なため。
 */
function extendEnds(line: [number, number][], meters: number): [number, number][] {
  const out = line.map((p) => [...p] as [number, number]);
  const push = (from: [number, number], to: [number, number]): [number, number] => {
    const dx = (to[0] - from[0]) * M_PER_DEG_LNG;
    const dy = (to[1] - from[1]) * M_PER_DEG_LAT;
    const len = Math.hypot(dx, dy) || 1;
    return [
      to[0] + ((dx / len) * meters) / M_PER_DEG_LNG,
      to[1] + ((dy / len) * meters) / M_PER_DEG_LAT,
    ];
  };
  // 上流側（1 番目 → 0 番目の向きに延ばす）
  out.unshift(push(out[1]!, out[0]!));
  // 下流側
  out.push(push(out[out.length - 2]!, out[out.length - 1]!));
  return out;
}

export function buildRiverPolygon(halfWidth = 55, extend = 260): RiverGeoJson {
  const line = extendEnds(RIVER_CENTERLINE, extend);
  const left: [number, number][] = [];
  const right: [number, number][] = [];

  for (let i = 0; i < line.length; i++) {
    const prev = line[Math.max(0, i - 1)]!;
    const next = line[Math.min(line.length - 1, i + 1)]!;
    // 前後の点から接線を求める（端点は片側だけ）
    const tx = (next[0] - prev[0]) * M_PER_DEG_LNG;
    const ty = (next[1] - prev[1]) * M_PER_DEG_LAT;
    const len = Math.hypot(tx, ty) || 1;
    // 接線に直交する単位ベクトル
    const nx = -ty / len;
    const ny = tx / len;

    const p = line[i]!;
    const dLng = (nx * halfWidth) / M_PER_DEG_LNG;
    const dLat = (ny * halfWidth) / M_PER_DEG_LAT;
    left.push([p[0] + dLng, p[1] + dLat]);
    right.push([p[0] - dLng, p[1] - dLat]);
  }

  // 左岸を上流→下流、右岸を下流→上流にたどって閉じる
  const ring = [...left, ...right.reverse()];
  ring.push(ring[0]!);

  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: { name: "隅田川" },
        geometry: { type: "Polygon", coordinates: [ring] },
      },
    ],
  };
}
