import type { Geodetic } from "./geo";

/**
 * 基準点：隅田川の両会場のあいだ。ここに ENU フレームを張る。
 * height は楕円体高。フレームの原点なので 0 で固定し、
 * 実際の地面の高さは地形から取得してローカル z に入れる。
 */
export const REFERENCE: Geodetic = { lng: 139.7995, lat: 35.712, height: 0 };

/**
 * 隅田川に架かる橋の座標。
 * 国土地理院 地名検索 API（https://msearch.gsi.go.jp/）から取得した実測値。
 */
export const BRIDGES = {
  桜橋: { lng: 139.806508, lat: 35.718091 },
  言問橋: { lng: 139.802390, lat: 35.714274 },
  駒形橋: { lng: 139.796243, lat: 35.708205 },
  厩橋: { lng: 139.794809, lat: 35.704907 },
  蔵前橋: { lng: 139.792391, lat: 35.700954 },
  両国橋: { lng: 139.787938, lat: 35.694021 },
} as const;

/**
 * 打ち上げ会場。
 *
 * 隅田川花火大会の打ち上げ筒は台船の上に川に沿って一列に並ぶ。
 * そのため会場は「点」ではなく、2 つの橋を結ぶ**線分**として定義する。
 * 中心座標＋方位角で近似すると、線が川からずれて陸上から花火が
 * 打ち上がってしまう（実際にそうなった）。
 */
export type VenueSite = {
  id: 0 | 1;
  name: string;
  /** 打ち上げ区間の上流端。 */
  from: { lng: number; lat: number };
  /** 打ち上げ区間の下流端。 */
  to: { lng: number; lat: number };
  /**
   * 線分のうち実際に使う範囲 [0..1]。
   * 「桜橋下流〜言問橋上流」なので、橋そのものの真下は空けている。
   */
  span: [number, number];
  /** 川の中心線からの左右のばらつき（m）。隅田川の川幅は約 150〜200 m。 */
  across: number;
};

export const VENUE_SITES: VenueSite[] = [
  {
    id: 0,
    name: "第一会場（桜橋下流〜言問橋上流）",
    from: BRIDGES.桜橋,
    to: BRIDGES.言問橋,
    span: [0.18, 0.82],
    across: 22,
  },
  {
    id: 1,
    name: "第二会場（駒形橋下流〜厩橋上流）",
    from: BRIDGES.駒形橋,
    to: BRIDGES.厩橋,
    span: [0.18, 0.82],
    across: 20,
  },
];

/** 会場の中央（見上げる対象・距離計算の基準に使う）。 */
export function venueCenter(site: VenueSite): { lng: number; lat: number } {
  return {
    lng: (site.from.lng + site.to.lng) / 2,
    lat: (site.from.lat + site.to.lat) / 2,
  };
}

export type Viewpoint = {
  id: string;
  name: string;
  /** その場所ならではの見え方の説明。 */
  note: string;
  lng: number;
  lat: number;
  /**
   * 地面（または水面）からの目線の高さ（m）。
   * 実際のカメラ高度は「地形の高さ + この値」で決める。
   * 楕円体高と標高のズレ（東京では約 37 m）を避けるため、
   * 絶対高度をハードコードしない。
   */
  eye: number;
  /** 上下の見上げ角（度）。正で上を向く。 */
  pitch: number;
  /** どの会場を向くか。null なら真俯瞰。 */
  faces: 0 | 1 | null;
  /** true なら位置を固定してドラッグで見回すモード。 */
  freeLook: boolean;
  /** 俯瞰視点用：注視点からの距離（m）。 */
  distance?: number;
  /**
   * 方位角（度）の上書き。省略すると対象会場への方位を自動計算する。
   * 2 つの会場を同時に画面に入れたいときなど、自動計算では収まらない場合に使う。
   */
  heading?: number;
  /**
   * 垂直画角（度）の上書き。省略すると既定値（60 度）。
   * 広い範囲を 1 画面に入れたいときに広げる。
   */
  fov?: number;
};

/**
 * 観覧スポット。座標はすべて国土地理院 地名検索 API の実測値。
 * 「同じ花火が、場所によってどう違って見え／どれだけ遅れて聞こえるか」を
 * 体験させるための並び。近い順から遠い順に並べている。
 */
export const VIEWPOINTS: Viewpoint[] = [
  {
    id: "sakurabashi",
    name: "桜橋の上",
    note: "第一会場の上流端。歩行者専用橋の上から至近距離で見上げる。",
    lng: BRIDGES.桜橋.lng,
    lat: BRIDGES.桜橋.lat,
    eye: 9,
    pitch: 40,
    faces: 0,
    freeLook: true,
  },
  {
    id: "sensoji",
    name: "浅草寺 本堂前",
    note: "街の側から見る。建物に遮られて花火の下側が見えない。",
    lng: BRIDGES.桜橋.lng, // 下で上書きする（浅草寺の座標）
    lat: BRIDGES.桜橋.lat,
    eye: 10,
    pitch: 34,
    faces: 0,
    freeLook: true,
  },
  {
    id: "kuramaebashi",
    name: "蔵前橋の上",
    note: "第二会場のすぐ下流。近い会場の音だけが先に届く。",
    lng: BRIDGES.蔵前橋.lng,
    lat: BRIDGES.蔵前橋.lat,
    eye: 8,
    pitch: 26,
    faces: 1,
    freeLook: true,
  },
  {
    id: "skytree",
    name: "東京スカイツリー 天望デッキ（350m）",
    note: "両会場を一望できる唯一の視点。花火を見下ろす高さ。",
    lng: 139.810713,
    lat: 35.709529,
    eye: 350,
    // 第一会場が -5.5 度、第二会場が -3.6 度の見下ろし。その中間に置く。
    pitch: -5,
    faces: 0,
    freeLook: true,
    // 打ち上げ区間の端まで含めた方位範囲は 250.3〜338.3 度。その中央。
    heading: 294,
    // 方位の幅 88 度を収めるため画角を広げる（既定 60 度では入りきらない）
    fov: 75,
  },
  {
    id: "ryogokubashi",
    name: "両国橋の上",
    note: "両会場を一望できる下流側。音が二重に届く。",
    lng: BRIDGES.両国橋.lng,
    lat: BRIDGES.両国橋.lat,
    eye: 8,
    pitch: 16,
    faces: 1,
    freeLook: true,
  },
  {
    id: "odaiba",
    name: "お台場海浜公園（約 10 km）",
    note: "光ってから 28 秒たって、低くこもった音だけが届く。",
    lng: 139.771030,
    lat: 35.631043,
    eye: 4,
    pitch: 5,
    faces: 0,
    freeLook: true,
  },
  {
    id: "aerial",
    name: "上空からの俯瞰",
    note: "二つの会場の位置関係と、玉の開く高さを俯瞰で確認する。",
    lng: 139.7995,
    lat: 35.7075,
    eye: 260,
    pitch: -24,
    faces: null,
    freeLook: false,
    distance: 2800,
  },
];

// 浅草寺の実測座標（国土地理院 地名検索 API）
const sensoji = VIEWPOINTS.find((v) => v.id === "sensoji")!;
sensoji.lng = 139.796977;
sensoji.lat = 35.716297;

/** a から b を見たときの方位角（度、北 = 0、時計回り）。 */
export function bearingDegrees(
  a: { lng: number; lat: number },
  b: { lng: number; lat: number },
): number {
  const toRad = Math.PI / 180;
  const p1 = a.lat * toRad;
  const p2 = b.lat * toRad;
  const dl = (b.lng - a.lng) * toRad;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}
