import ThreeView, {
  CameraDirection,
  Color,
  geodeticSurfaceNormal,
} from "@navaramap/three";
import { DefaultPlugin } from "@navaramap/three-default-plugin";
import type {
  CloudsEffectDesc,
  RainMeshDesc,
  SelectiveBloomEffectDesc,
  SSREffectDesc,
  AmbientLightDesc,
} from "@navaramap/three-default-descs";
import { Matrix4, Vector3 } from "three";

import type { AppDescriptions } from "./navara";
import { registerSmoothBloom, type SmoothBloomEffectDesc } from "./smoothBloom";

import {
  distanceMeters,
  enuFrame,
  enuOffset,
  fromEcef,
  toEcef,
  TOKYO_GEOID_HEIGHT,
  type Geodetic,
} from "./geo";
import { FireworkSystem } from "./fireworks";
import { SmokeSystem } from "./smoke";
import {
  loadRiver,
  projectOnCenterline,
  riversideNoEntry,
  riverSurface,
} from "./river";
import {
  areaOutlineGeoJson,
  loadAreas,
  loadPedestrianRoutes,
  PedestrianFlow,
} from "./traffic";
import { PROGRAM_LENGTH, ShowProgram, type Venue } from "./program";
import { HanabiAudio, SPEED_OF_SOUND } from "./audio";
import { makeRng } from "./rng";
import {
  bearingDegrees,
  REFERENCE,
  venueCenter,
  VENUE_SITES,
  VIEWPOINTS,
  type Viewpoint,
} from "./viewpoints";
import { buildUi } from "./ui";

// ---------------------------------------------------------------------------
// ビューの初期化
// ---------------------------------------------------------------------------

const canvas = document.getElementById("map") as HTMLCanvasElement;

/**
 * 描画設定の A/B 用クエリ。`?dpr=1&msaa=4` のように付けてリロードする。
 * pixelRatio と multisampling は初期化専用で、後から変えられない。
 * MSAA は G-buffer の全アタッチメントに乗るので、DPR 2 のまま 4x にすると
 * VRAM が数百 MB 増える。試すときは dpr=1 と組み合わせる。
 */
const query = new URLSearchParams(location.search);
const queryNumber = (key: string): number | undefined => {
  const raw = query.get(key);
  if (raw === null) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
};

const view = new ThreeView<AppDescriptions>({
  canvas,
  // 花火は毎フレーム動くので常時描画にする。
  // false のままだと forceUpdate() を毎フレーム呼ぶ必要がある。
  animation: true,
  useNormal: true,
  // 既定はデバイスの DPR をそのまま使う（上限なし）。
  // 3 以上の端末で描画面積が膨らみすぎないよう 2 で止める。
  pixelRatio: queryNumber("dpr") ?? Math.min(window.devicePixelRatio, 2),
  multisampling: queryNumber("msaa") ?? 0,
});

const defaultPlugin = new DefaultPlugin();
view.addPlugin(defaultPlugin);

await view.init();

// 空・星・太陽・大気・トーンマッピング・アンチエイリアスを一括で用意する
defaultPlugin.addDefaultPhotorealScene();

// アプリ内で試作しているカスタム効果
registerSmoothBloom(view);

// ---------------------------------------------------------------------------
// 隅田川の中心線
//
// 水面・川沿いの立入禁止帯・打ち上げ位置・橋の上の視点は、
// すべてこの 1 本の線から決まる。編集するのは
// public/data/river-centerline.geojson だけでよい。
// ---------------------------------------------------------------------------

const river = await loadRiver();

// ---------------------------------------------------------------------------
// 地図データ
// ---------------------------------------------------------------------------

// ベースマップ：地理院タイル（シームレス空中写真）
const photo = view.addSource({
  type: "raster-tile",
  url: "https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg",
  maxZoom: 18,
});
const photoLayer = view.addLayer({
  type: "raster",
  source: photo,
  raster: {
    // 明るさは昼夜に応じて applyNight() が上書きする
    color: new Color().setStyle("#f2f5fa"),
  },
});

// 地形（楕円体高ベース）
const terrain = view.addSource({
  type: "quantized-mesh",
  url: "https://terrain.reearth.land/cesium-mesh/ellipsoid/{z}/{x}/{y}.terrain",
  maxZoom: 18,
  requestVertexNormals: true,
  requestWaterMask: true,
});
view.addLayer({ type: "terrain", source: terrain, terrain: {} });

// 花火を光らせる主役。これがないと球体がただ並んでいるだけに見える。
//
// 閾値は 0 だと「発光しているもの全部」が滲み、街全体が白飛びする。
// 一方で上げすぎると、夜は光源がないため発光物が色パスでも真っ黒になり、
// 道路のような線は「滲まない＝完全に見えない」状態になる。
// 道路が細く光り、花火が大きく滲む境目を狙って 0.22 に置いている。
const BLOOM_THRESHOLD = 0.22;

// 既定はアプリ内で試作した smoothBloom（1 段ずつテントフィルタで拡大する方式）。
// Navara 標準の selectiveBloom は 5 段のミップを単純バイリニアで引き伸ばして
// 足すため、遠くまで滲ませると低解像度ミップの四角い形が残る。
// `?bloom=unreal` で標準に切り替えて見比べられる。
const bloom =
  query.get("bloom") === "unreal"
    ? view.addEffect<SelectiveBloomEffectDesc>({
        selectiveBloom: {
          strength: 1.0,
          // 半径は bloom テクスチャの texel 基準。resolutionScale 1.0 に合わせた値。
          radius: 0.4,
          threshold: BLOOM_THRESHOLD,
          // UnrealBloomPassRGBA はこの倍率の上でさらに半分から滲みを作る。
          // 0.75 だと画面の 3/8 解像度になり四角いブロックが目立った。
          resolutionScale: 1.0,
        },
      })
    : view.addEffect<SmoothBloomEffectDesc>({
        smoothBloom: {
          strength: 1.0,
          threshold: BLOOM_THRESHOLD,
          smoothing: 0.1,
          radius: 0.85,
          levels: 8,
          resolutionScale: 1.0,
        },
      });

// PLATEAU 3D 都市モデル（建築物 LOD1）。台東区と墨田区が隅田川を挟んでいる。
const PLATEAU_TILESETS = [
  {
    name: "台東区",
    url: "https://plateau.geospatial.jp/main/data/3d-tiles/bldg/13100_tokyo/13106_taito-ku/notexture/tileset.json",
  },
  {
    name: "墨田区",
    url: "https://plateau.geospatial.jp/main/data/3d-tiles/bldg/13100_tokyo/13107_sumida-ku/notexture/tileset.json",
  },
];

const buildingLayers = PLATEAU_TILESETS.map((t) => {
  const src = view.addSource({ type: "3d-tiles", url: t.url });
  return view.addLayer({
    type: "3d-tiles",
    source: src,
    model: {
      show: true,
      // 色は applyNight() が昼夜に応じて上書きする。
      // 建物は発光させない。発光させると「光るブロック」が並んで見えてしまう。
      // 夜景（窓や街灯の明かり）は今回のスコープ外。FEEDBACK.md を参照。
      color: new Color().setStyle("#b4bcc9"),
    },
  });
});

/**
 * 夜の環境光。建物の面が完全な黒にならないよう、わずかに起こす。
 * 大気散乱だけだと日没後の街の陰影が消えてしまう。
 */
const nightAmbient = view.addLight<AmbientLightDesc>({
  ambient: { color: new Color().setStyle("#2a3550"), intensity: 0 },
});

// ---------------------------------------------------------------------------
// 隅田川の水面
//
// Navara の水面表現はポリゴンのマテリアル側にある（`water: true`）。
// 地形レイヤーには水面のパラメータがないので、川の形のポリゴンを
// 1 枚敷いて、そこに水面マテリアルを載せる。
// SSR（スクリーンスペース反射）と組み合わせて花火を映す。
// ---------------------------------------------------------------------------

const riverSource = view.addSource({
  type: "geojson",
  data: riverSurface(river),
});

const riverLayer = view.addLayer({
  type: "vector",
  source: riverSource,
  polygon: {
    show: true,
    // 水面マテリアル。法線が波打ち、SSR の反射がゆらぐ。
    water: true,
    // 小さくすると水面が粗くなる（波が細かくなる）
    waterScaleNormal: 0.06,
    waterSpeed: 0.35,
    // 反射の強さ。SSR がこの値を見て反射量を決める。
    reflectivity: 0.85,
    // 小さいほど鏡に近い
    roughness: 0.16,
    color: new Color().setStyle("#0a121c"),
    perPositionHeight: false,
    height: 0,
    receiveShadow: false,
  },
});

// ---------------------------------------------------------------------------
// エフェクト
// ---------------------------------------------------------------------------

// ボリュメトリック雲
const clouds = view.addEffect<CloudsEffectDesc>({
  clouds: {
    coverage: 0.2,
    shadows: false,
    haze: true,
    resolutionScale: 0.5,
  },
});

/**
 * 雨。空間を落ちてくる粒として描く。
 *
 * `followCamera` を有効にすると、カメラの周囲に一定の体積の雨を
 * 保ち続けるので、どこへ動いても雨の中にいるように見える。
 *
 * レンズに付く水滴（`RainDropEffectDesc`）は使っていない。
 * 河川敷に立って見上げている設定なので、カメラのレンズという前提が合わない。
 */
const rain = view.addMesh<RainMeshDesc>({
  rain: {
    particleCount: 0,
    speed: 22,
    color: 0xaac4dd,
    // カメラの周囲に確保する雨の範囲（m）
    areaWidth: 70,
    areaHeight: 70,
    // 1 粒の太さと長さ。強い雨ほど太く長い筋になる。
    width: 0.015,
    height: 0.5,
    opacity: 0,
    // 光が当たる側と陰になる側のアルファ。差をつけると粒に立体感が出る。
    alphaMax: 0.6,
    alphaMin: 0.12,
    followCamera: true,
    // この高さに近づくほど不透明度を落とす（上空へ抜けると雨が消える）
    maxHeight: 3000,
    // 画角 60 度を基準に見かけの大きさを保つ。
    // これがないと望遠にしたとき雨粒が巨大化する。
    baseFov: 60,
  },
});

/**
 * 水面への映り込み（スクリーンスペース反射）。
 *
 * 画面に写っているものだけが反射に使える方式なので、
 * 花火と川面が同じ画面に入っているときに効きます。
 * 花火だけを見上げて川が画面外にあるときは、当然映りません。
 *
 * 【花火を水面に映そうとして、やめた経緯】
 * 既定では岸の明かりしか映らない。原因は次の 2 つで、どちらも変えれば
 * 花火の映り込み自体は出せることを確認した。
 *
 *   - `maxRayDistance`（反射光線が進める距離の上限、m）の既定が 10 m。
 *     花火は上空 250〜330 m で開くので、光線がまったく届かない。
 *   - `iterations`（光線が画面上を探索する回数）の既定が 200。
 *     歩幅は 1 px 固定なので、これは「画面上で何 px 先まで探せるか」に等しい。
 *     SSR は 0.5 倍解像度で動くため、実画面では約 400 px しか届かない。
 *     水面のピクセルから上空の花火までは画面上でそれ以上離れている。
 *
 * `maxRayDistance: 2200` + `iterations: 900` で花火は映った。
 * ただし見た目が成立しなかったため採用していない。
 *
 *   - 遠くの水面は視線に対してほぼ真横（すれすれの角度）になるため、
 *     反射が縦につぶれて水平線上に白い団子として積み上がる。
 *   - 光線が遠くまで飛べるようになった結果、無関係な地形や建物を拾い、
 *     手前の川面に黒い塊や横線が出る。
 *
 * どちらも SSR（画面に写っているものだけを反射に使う方式）の原理的な限界で、
 * パラメータでは解決できない。水面に正しく花火を映すには、
 * 水面から見た平面反射（リフレクションカメラ）が必要になる。
 * 詳細は FEEDBACK.md に記載。
 *
 * 【触ってはいけないパラメータ】
 * `pixelStride`（光線が 1 ステップで進む画面上の距離）と
 * `pixelStrideZCutoff`（歩幅を広げてよいカメラからの距離）は既定のままにする。
 *
 * シェーダはこう計算している:
 *   strideScaler = 1 - min(1, カメラからの距離 / pixelStrideZCutoff)
 *   実際の歩幅   = 1 + strideScaler * pixelStride
 *
 * 既定の cutoff は 100 m。川面はほぼ全部それより遠いので strideScaler が 0 になり、
 * 歩幅は常に 1 px に落ち着く。さらに「歩幅 > 1 のときだけ走る二分探索」も
 * 走らないので、当たり位置は素直に決まる。
 *
 * ここを引き上げて歩幅を約 10 px にしたところ、二分探索が有効になり、
 * 水面の映り込みが丸ごと消えた。速くはなるが結果が合わない。
 */
const ssr = view.addEffect<SSREffectDesc>({
  ssr: {
    resolutionScale: 0.5,
    // ぼかしのカーネルは奇数。水面の反射を少しにじませる。
    resolveKernelSize: 3,
    useConeTracing: true,
    coneTracingMaxDistance: 3000,
    // 画面端の反射は破綻しやすいので早めにフェードさせる
    screenEdgeFadeStart: 0.72,
    jitter: 0.35,
  },
});

// ---------------------------------------------------------------------------
// 地形の高さ解決
//
// 標高（T.P.）と楕円体高は東京では約 37 m ずれている。
// 数値をハードコードすると視点が地面に埋まったり浮いたりするので、
// 地形データから実際の高さを取得して使う。読み込み前は近似値で代用する。
// ---------------------------------------------------------------------------

const groundCache = new Map<string, number>();
const groundKey = (lng: number, lat: number) => `${lng.toFixed(5)},${lat.toFixed(5)}`;

/** その地点の地面の楕円体高。まだ地形が来ていなければ近似値。 */
function groundHeight(lng: number, lat: number): number {
  return groundCache.get(groundKey(lng, lat)) ?? TOKYO_GEOID_HEIGHT + 2;
}

/** 地形の高さを監視し、判明したらキャッシュして callback を呼ぶ。 */
function watchGround(lng: number, lat: number, onResolved?: (h: number) => void) {
  const key = groundKey(lng, lat);
  const pos = { lng, lat };
  const immediate = view.sampleTerrainHeight(pos);
  if (immediate !== undefined) {
    groundCache.set(key, immediate);
    onResolved?.(immediate);
  }
  view.observeTerrainHeightAt(pos, (h) => {
    const prev = groundCache.get(key);
    groundCache.set(key, h);
    if (prev === undefined || Math.abs(prev - h) > 0.5) onResolved?.(h);
  });
}

// ---------------------------------------------------------------------------
// 花火システム
// ---------------------------------------------------------------------------

/** 全ての花火を配置する ENU 接平面フレーム（隅田川の基準点、楕円体高 0）。 */
const frame: Matrix4 = enuFrame(REFERENCE);

/**
 * 会場の打ち上げ区間（2 つの橋を結ぶ線分）を ENU ローカルに落とす。
 *
 * 橋の座標は国土地理院の地名検索によるものだが、それが川の中心とは限らない。
 * そのまま使うと打ち上げ位置が川からはみ出すので、
 * **描いた中心線に投影してから**区間を作る。
 */
function buildVenue(site: (typeof VENUE_SITES)[number]): Venue {
  const c = venueCenter(site);
  // 水面の高さは会場中央の地形高さで代表させる
  const h = groundHeight(c.lng, c.lat);
  const [aLng, aLat] = projectOnCenterline(river, [site.from.lng, site.from.lat]);
  const [bLng, bLat] = projectOnCenterline(river, [site.to.lng, site.to.lat]);
  return {
    id: site.id,
    name: site.name,
    a: enuOffset(REFERENCE, { lng: aLng, lat: aLat, height: h }),
    b: enuOffset(REFERENCE, { lng: bLng, lat: bLat, height: h }),
    span: site.span,
    across: site.across,
  };
}

const venues: Venue[] = VENUE_SITES.map(buildVenue);

// 水面の高さを地形から決める（東京では標高と楕円体高が約 37 m ずれる）
watchGround(139.797879, 35.710223, (h) => {
  riverLayer.update({
    type: "vector",
    source: riverSource,
    polygon: { height: h + 0.3 },
  });
});

// 会場の水面の高さが判明したら打ち上げ位置を補正する
VENUE_SITES.forEach((site, i) => {
  const c = venueCenter(site);
  watchGround(c.lng, c.lat, () => {
    venues[i] = buildVenue(site);
  });
});

const audio = new HanabiAudio();
const rng = makeRng(20260725);


/** ENU ローカル座標 → ECEF。音の距離計算に使う。 */
const localToEcef = (local: Vector3): Vector3 => local.clone().applyMatrix4(frame);

/** 現在のカメラ位置（ECEF）。 */
const cameraEcef = new Vector3();
function readCameraEcef(): Vector3 {
  const p = view.camera.positionECEF;
  cameraEcef.set(p.x, p.y, p.z);
  return cameraEcef;
}

/** 花火の煙。風で流れる。 */
const smoke = new SmokeSystem({ view, frame, rng, bloomId: bloom.id });

/** 直近の開花の距離と、音が届くまでの秒数。UI に出す。 */
let lastDelay = 0;
let lastDistance = 0;

const fireworks = new FireworkSystem({
  view,
  frame,
  bloomId: bloom.id,
  rng,
  events: {
    onBurst: ({ position, burstRadius, crackle, tintColor }) => {
      const dist = readCameraEcef().distanceTo(localToEcef(position));
      lastDistance = dist;
      lastDelay = dist / SPEED_OF_SOUND;
      audio.scheduleBurst(dist, burstRadius, crackle);
      // 煙は開花した玉の色に染まる
      smoke.spawnBurst(position, burstRadius, state.quality, tintColor);
    },
    onLaunch: ({ position, riseTime }) => {
      const dist = readCameraEcef().distanceTo(localToEcef(position));
      audio.scheduleLaunch(dist, riseTime);
      smoke.spawnLaunch(position, state.quality);
    },
  },
});

const program = new ShowProgram(venues, rng);

// ---------------------------------------------------------------------------
// 光る道路
//
// 夜景の代わりになる。建物を光らせるとブロックが並んで見えてしまうが、
// 道路を光らせると実際の夜景に近い「光の線」になる。
// しかも位置がでたらめではなく、国土地理院のベクトルタイルの実データ。
// ---------------------------------------------------------------------------

const roadSource = view.addSource({
  type: "vector-tile",
  // 地理院ベクトルタイル（提供実験）。ズーム 16 のみ提供されている。
  url: "https://cyberjapandata.gsi.go.jp/xyz/experimental_bvmap/{z}/{x}/{y}.pbf",
  maxZoom: 16,
});

const roadLayer = view.addLayer({
  type: "vector",
  source: roadSource,
  // ベクトルタイルの中の道路レイヤーだけを描く
  sourceLayers: ["road"],
  polyline: {
    show: true,
    // 地形に貼り付ける。坂でも道路から浮かない。
    clampToGround: true,
    width: 2.5,
    maxWidth: 4,
    // 夜は環境光しか当たらないので、素の色は明るめにしておく
    color: new Color().setStyle("#ffd0a0"),
    emissiveIntensity: 0.6,
    effectIds: [bloom.id],
    transparent: true,
    opacity: 0.85,
    // 大量の線になるのでタイル分割して描く
    tiled: true,
  },
});

// ---------------------------------------------------------------------------
// 交通規制と歩行者動線
//
// ⚠️ 座標は概略値。公式の道路規制図と照合して差し替えること（src/traffic.ts）。
// ---------------------------------------------------------------------------

// データは public/data/ の GeoJSON から読む。差し替えればそのまま反映される。
const regulationAreas = await loadAreas("data/regulation-area.geojson", "regulation");
const reducedAreas = await loadAreas("data/regulation-area-reduced.geojson", "reduced");
const noEntryAreas = await loadAreas("data/no-entry.geojson", "no-entry");
const pedestrianRoutes = await loadPedestrianRoutes();

/**
 * 交通規制区域（PM6:00〜9:30）。
 * 公式図では塗りつぶさず境界線だけなので、リングを線に変換して描く。
 */
const regulationSource = view.addSource({
  type: "geojson",
  data: areaOutlineGeoJson(regulationAreas),
});
const regulationLayer = view.addLayer({
  type: "vector",
  source: regulationSource,
  polyline: {
    show: true,
    // 地形に貼り付ける。起伏があっても浮かない。
    clampToGround: true,
    width: 7,
    maxWidth: 10,
    color: new Color().setStyle("#3d8bff"),
    emissiveIntensity: 0.95,
    effectIds: [bloom.id],
    transparent: true,
    opacity: 0.9,
  },
});

/** 縮小規制区域（PM9:30〜10:00）。同じく境界線だけ。 */
const reducedSource = view.addSource({
  type: "geojson",
  data: areaOutlineGeoJson(reducedAreas),
});
const reducedLayer = view.addLayer({
  type: "vector",
  source: reducedSource,
  polyline: {
    show: true,
    clampToGround: true,
    width: 6,
    maxWidth: 9,
    color: new Color().setStyle("#3ddc84"),
    emissiveIntensity: 0.95,
    effectIds: [bloom.id],
    transparent: true,
    opacity: 0.9,
  },
});

/**
 * 立入禁止区域（隅田公園・大会本部など）の輪郭線。
 *
 * ⚠️ この 3 つのポリラインレイヤーは **必ず連続して作ること**。
 *
 * もともとこのレイヤーは、下の塗りつぶし（ポリゴン）レイヤーを作ったあとに
 * 追加していた。すると、設定もデータも交通規制区域とまったく同じなのに、
 * 読み込み直後の数秒だけ描かれて、そのあと消えるという症状が出た。
 * エラーも警告も出ない。
 *
 * 切り分けの結果:
 *   - データは届いている（console で 5 件確認）
 *   - ジオメトリの大きさは無関係（大きいリングを混ぜても同じく消えた）
 *   - 明るさ・ブルームは無関係（昼にしても出ない）
 *   - 更新経路は無関係（設定を毎回全部渡しても同じ）
 *   - 同じデータを交通規制区域のレイヤーに相乗りさせると **正しく描かれた**
 *
 * つまり原因はデータではなく、レイヤーを作る順番にある。
 * clampToGround のポリゴンレイヤーより後にポリラインレイヤーを作ると
 * 描画されなくなる、という Navara 側の問題と見ている。
 * 詳細は FEEDBACK.md に記載。
 */
const noEntryOutlineSource = view.addSource({
  type: "geojson",
  data: areaOutlineGeoJson(noEntryAreas),
});
const noEntryOutlineLayer = view.addLayer({
  type: "vector",
  source: noEntryOutlineSource,
  polyline: {
    show: true,
    clampToGround: true,
    // 値は交通規制区域（青）・縮小規制区域（緑）と揃えている。
    // 立入禁止だけ描き方が違うと、凡例として読みにくくなるため。
    width: 7,
    maxWidth: 10,
    // 公式図と塗りつぶしの帯に合わせて赤。青・緑と並ぶ 3 色目。
    color: new Color().setStyle("#ff3b2f"),
    emissiveIntensity: 0.95,
    effectIds: [bloom.id],
    transparent: true,
    opacity: 0.9,
  },
});

/**
 * 川沿いの立入禁止の帯（両岸の親水テラス）。こちらは塗りつぶし。
 *
 * 河川敷には建物がないので、塗りつぶしでも隠れない。
 * 一方、市街地のブロックに載る区域を塗りつぶすと PLATEAU の建物に
 * 覆われてしまうので、そちらは上の輪郭線で描き分けている。
 *
 * 中心線から生成しているため、中心線を動かすと自動で追従する。
 */
const noEntryData = riversideNoEntry(river);
const noEntrySource = view.addSource({
  type: "geojson",
  data: noEntryData,
});
const noEntryLayer = view.addLayer({
  type: "vector",
  source: noEntrySource,
  polygon: {
    show: true,
    // 地形に貼り付ける。河川敷の起伏に沿う。
    clampToGround: true,
    color: new Color().setStyle("#ff3b2f"),
    emissiveIntensity: 0.5,
    effectIds: [bloom.id],
    transparent: true,
    opacity: 0.32,
  },
});

// 歩行者の進行方向（地面を流れる点線）
const pedestrianFlow = new PedestrianFlow({
  view,
  frame,
  bloomId: bloom.id,
  groundAt: groundHeight,
  routes: pedestrianRoutes,
});

/**
 * 動線の各点の地形高さを取りにいく。
 *
 * 以前は REFERENCE 1 地点の標高を全動線に使い回していたため、
 * 地面が上がっていく台東区側で矢印が地中に埋まり、
 * 隅田川の西側だけ動線が見えない状態になっていた。
 *
 * 地形はタイルで非同期に届くので、判明するたびに作り直す。
 * 点ごとに毎回作り直すと無駄なので、1 フレームにまとめる。
 */
{
  let pending = false;
  const scheduleRebuild = () => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      pedestrianFlow.rebuild();
    });
  };
  const seen = new Set<string>();
  for (const route of pedestrianRoutes) {
    for (const [lng, lat] of route.path) {
      const key = `${lng.toFixed(5)},${lat.toFixed(5)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      watchGround(lng, lat, scheduleRebuild);
    }
  }
}

// ---------------------------------------------------------------------------
// 天候・時刻の状態
// ---------------------------------------------------------------------------

const state = {
  /** 表示する時刻（JST の 0〜24 時、小数）。 */
  hour: 18.5,
  /** 時刻を自動で進めるか。 */
  playing: true,
  /** 雲量 0〜1（ユーザーがスライダーで指定した値）。 */
  cloud: 0.2,
  /** 雨量 0〜1。 */
  rain: 0,
  /** 露出の補正倍率。1.0 で時刻に応じた標準の明るさ。 */
  exposure: 1.0,
  /** 時間の進む速さの倍率。 */
  speed: 1,
  /** 星の数の倍率。 */
  quality: 0.8,
  /** 風向（吹いてくる方向、度）。7 月の東京は南〜南南西の風が多い。 */
  windFrom: 200,
  /** 風速 (m/s)。 */
  windSpeed: 2.5,
  /** 煙の量。 */
  smoke: 0.1,
  /** 道路を光らせる。 */
  roadGlow: true,
  /** 道路の光の強さ 0〜1。 */
  roadGlowStrength: 0.45,
  /** 交通規制区域・縮小規制区域（境界線）の表示。 */
  showRegulation: false,
  /** 立入禁止区域（赤い面）の表示。 */
  showNoEntry: false,
  /** 歩行者進行方向の表示。 */
  showPedestrian: false,
  /** 水面の映り込みの強さ 0〜1。 */
  reflection: 0.85,
  /** 水面の粗さ（波の細かさ）0〜1。小さいほど鏡に近い。 */
  waterRoughness: 0.16,
  viewpoint: VIEWPOINTS.find((v) => v.id === "aerial") ?? VIEWPOINTS[0]!,
  /** true のとき視点の固定を外し、地図をマウスで自由に動かせる。 */
  freeCamera: true,
};

/** 打ち上げ開始時刻（第一会場）。 */
const SHOW_START_HOUR = 19.0;
/** 終了時刻。実際の大会は 20:30 に両会場とも終了する。 */
const SHOW_END_HOUR = 20.5;
/**
 * 打ち上げ前の時間帯の早送り倍率。
 * 18:30 から 19:00 まで等速で進むと 1 分半待つことになるので、
 * 空だけを早送りして開始時刻に入る。
 */
const PRE_SHOW_FAST_FORWARD = 8;
/** 番組 1 秒あたりに進む時刻（時間）。256 秒で 90 分。 */
const HOUR_PER_SECOND = (SHOW_END_HOUR - SHOW_START_HOUR) / PROGRAM_LENGTH;
/**
 * スライダーの下限。ここまで戻って繰り返す。
 * 18:30 は日没（18:52）の直前で、ここから空が色づき始める。
 */
const CLOCK_START_HOUR = 18.5;
/** スライダーの上限。打ち上げ終了時刻に合わせている。 */
const CLOCK_END_HOUR = SHOW_END_HOUR;

/** 時刻から番組内の位置（秒）を求める。 */
function programTimeFromHour(hour: number): number {
  return ((hour - SHOW_START_HOUR) / (SHOW_END_HOUR - SHOW_START_HOUR)) * PROGRAM_LENGTH;
}

/** いま何をしている時間かのラベル。 */
function phaseLabelFor(hour: number): string {
  if (hour < SHOW_START_HOUR) return "打ち上げ前｜19:00 開始";
  if (hour > SHOW_END_HOUR) return "20:30 打ち上げ終了";
  return program.phase.label;
}

/** 直前に大気へ反映した時刻。無駄な再計算を避けるため。 */
let appliedHour = Number.NaN;

/**
 * JST の時刻を大気の日時に反映する。2026 年 7 月 25 日（第 49 回開催日）。
 * 東京のこの日の日没は 18:52 なので、19:00 はまだ薄明かりが残る。
 */
function applyHour(hour: number, force = false) {
  // 15 秒（空の時間）刻みで十分なめらか。毎フレーム更新する必要はない。
  if (!force && Math.abs(hour - appliedHour) < 1 / 240) return;
  appliedHour = hour;
  const total = Math.round(hour * 3600);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  // JST = UTC+9
  view.atmosphere.date = new Date(Date.UTC(2026, 6, 25, h - 9, m, sec));
}

/** 雨量から導かれる雲量の下限。雨なのに晴れているのは不自然なので。 */
function cloudFloorForRain(rainAmount: number): number {
  return rainAmount > 0.05 ? Math.min(1, 0.35 + rainAmount * 0.45) : 0;
}

/** 実際に適用される雲量（ユーザー指定と雨の下限の大きい方）。 */
function effectiveCloud(): number {
  return Math.max(state.cloud, cloudFloorForRain(state.rain));
}

function applyCloud() {
  const v = effectiveCloud();
  clouds.update({ clouds: { coverage: v } });
  // 雨に押し上げられた分もスライダーに見えるようにする
  ui?.setCloud(v);
}

/**
 * 雨量（0〜1）から雨粒の見た目を組み立てる。
 *
 * 小雨と本降りでは、粒の数だけでなく太さ・長さ・落下速度・濃さのすべてが違う。
 * 数だけ増やすと「細い線が増える」だけで、雨の強さとして読めない。
 */
function applyRain(v: number) {
  const on = v > 0.01;
  const fall = 22 + v * 24;
  // 風で雨が傾く。落下速度と風速の比が傾き角になる。
  const tilt = Math.atan2(state.windSpeed, fall);
  // 風向は「吹いてくる方向」なので、倒れるのはその逆向き
  const wr = ((state.windFrom + 180) * Math.PI) / 180;

  rain.update({
    rain: {
      particleCount: Math.round(v * 14000),
      speed: fall,
      // 強い雨は太く長い筋になる
      width: 0.015 + v * 0.035,
      height: 0.5 + v * 1.7,
      opacity: on ? 0.16 + v * 0.34 : 0,
      alphaMax: 0.45 + v * 0.25,
      alphaMin: 0.1 + v * 0.08,
    },
    // RainMeshDesc に風のパラメータはないので、メッシュ自体を傾けて
    // 横殴りの雨を表現している。
    rotation: {
      x: Math.cos(wr) * tilt,
      y: Math.sin(wr) * tilt,
      z: 0,
    },
  });
  applyCloud();
}

/**
 * 時刻に応じた基準露出。
 *
 * 大気散乱は昼と夜で放射輝度が桁違いなので、露出を固定すると
 * 「昼に合わせると夜が真っ暗、夜に合わせると昼が真っ白」になる。
 * カメラの自動露出と同じ考え方で、昼夜から基準値を決め、
 * スライダーはその補正倍率として扱う。
 */
function baseExposure(daylight: number): number {
  // 夜 3.5 → 昼 9.5。
  //
  // 直感に反するが、**昼のほうが高い露出が要る**。
  // Navara の大気散乱が返す放射輝度の単位では昼の空でも値が小さく、
  // 公式テンプレートも昼（8 時）のシーンで 10 を使っている。
  // 当初これを逆に（昼 0.9 / 夜 3.5）していたため、17:30 でも空が暗いままだった。
  //
  // 指数を掛けているのは、薄暮のあいだは夜側の値に近く保つため。
  // ここが急に上がると日没前後で絵が破綻する。
  return 3.5 + Math.pow(daylight, 1.5) * 6.0;
}

function applyExposure(_v?: number) {
  const daylight = Number.isNaN(appliedDaylight) ? 1 : appliedDaylight;
  view.toneMappingExposure = baseExposure(daylight) * state.exposure;
}

/** 基準点における地表法線（真上の向き）。太陽高度の計算に使う。 */
const localUp = geodeticSurfaceNormal({
  lng: REFERENCE.lng,
  lat: REFERENCE.lat,
  height: 0,
});

/**
 * 暗くなり始める太陽高度（度）。ここで完全な夜として扱う。
 *
 * 当初は市民薄明の終わり（-6 度）を夜としていたが、それだと
 * **実際より 40 分ほど早く暗くなる**。-6 度は 19:21 頃で、
 * 街灯は点くもののまだ十分明るい時間帯。
 * 体感として「暗い」のは航海薄明が終わる -12 度（19:56 頃）なので、
 * そこまで引き延ばしている。
 */
const NIGHT_ELEVATION = -12;
/** 完全な昼として扱う太陽高度（度）。 */
const DAY_ELEVATION = 3;

/**
 * 現在の「昼らしさ」0〜1 を太陽高度から求める。
 *
 * 時刻から決め打ちするのではなく、Navara が計算した太陽の向きを使う。
 * 空そのものは Navara の大気散乱が物理的に描くので、
 * ここで決めるのは地表・建物・環境光・露出の明るさ。
 */
function currentDaylight(): number {
  const sun = view.atmosphere.sunDirection;
  const dot =
    (sun.x * localUp.x + sun.y * localUp.y + sun.z * localUp.z) /
    (Math.hypot(sun.x, sun.y, sun.z) || 1);
  const elevationDeg = (Math.asin(Math.max(-1, Math.min(1, dot))) * 180) / Math.PI;
  const t =
    (elevationDeg - NIGHT_ELEVATION) / (DAY_ELEVATION - NIGHT_ELEVATION);
  const c = Math.max(0, Math.min(1, t));
  // なめらかに（smoothstep）
  return c * c * (3 - 2 * c);
}

/** 昼間の地表の色（航空写真の乗算色）。ほぼ素通しにする。 */
const DAY_GROUND = "#f2f5fa";
/** 夜の地表の色。青く沈ませる。 */
const NIGHT_GROUND = "#2b3444";
/** 昼間の建物の色。コンクリートの明るさ。 */
const DAY_BUILDING = "#b4bcc9";
/** 夜の建物の色。暗いシルエット。 */
const NIGHT_BUILDING = "#1a1f29";

let appliedDaylight = Number.NaN;

/** 環境光と地表の明るさを、昼夜に合わせて更新する。 */
function applyNight(force = false) {
  const daylight = currentDaylight();
  if (!force && Math.abs(daylight - appliedDaylight) < 0.02) return;
  appliedDaylight = daylight;
  const night = 1 - daylight;

  pedestrianFlow.setDaylight(daylight);
  applyRoadGlow();
  applyExposure();

  // 夜だけ環境光を足す。昼は大気散乱に任せる。
  // これがないと日没後に建物が完全な黒になって、街の陰影が消える。
  // 夜の環境光。これがないと建物も道路の線も真っ黒に沈んで、
  // ブルームに入らないものが一切見えなくなる。
  nightAmbient.update({ ambient: { intensity: night * 0.85 } });

  // 地表（航空写真）の明るさ。
  // 昼はほぼ素通し（写真そのままの明るさ）、夜は青く沈ませる。
  // ここを夜想定の暗い色で固定していたため、昼間まで暗くなっていた。
  const ground = new Color().setStyle(DAY_GROUND);
  ground.raw.lerp(new Color().setStyle(NIGHT_GROUND).raw, night);
  photoLayer.update({ type: "raster", source: photo, raster: { color: ground } });

  // 建物も同じ。昼はコンクリートの明るさ、夜は暗いシルエット。
  const bldg = new Color().setStyle(DAY_BUILDING);
  bldg.raw.lerp(new Color().setStyle(NIGHT_BUILDING).raw, night);
  for (const layer of buildingLayers) {
    layer.update({ type: "3d-tiles", model: { color: bldg } });
  }
}

/** 光る道路の表示と強さを反映する。夜だけ光らせる。 */
function applyRoadGlow() {
  const night = 1 - Math.max(0, Math.min(1, appliedDaylight || 0));
  // 昼は消す。航空写真に道路が写っているので二重に描く意味がなく、
  // 半透明の線が煙や地表に重なって汚れて見える。
  const on = state.roadGlow && night > 0.06 && state.roadGlowStrength > 0.02;
  roadLayer.update({
    type: "vector",
    source: roadSource,
    sourceLayers: ["road"],
    polyline: {
      show: on,
      // ブルームの閾値（0.22）を超える必要がある。下回ると夜は
      // 色パスでも真っ黒なので、道路が完全に見えなくなる。
      emissiveIntensity: state.roadGlowStrength * night * 1.15,
      // 半透明にすると、手前の煙に重なったとき煙を暗くしてしまう。
      // ほぼ不透明の細い線にして「光っている線」として読ませる。
      opacity: 0.92,
      width: 1.8 + state.roadGlowStrength * 1.6,
      maxWidth: 4,
    },
  });
}

/** 交通規制まわりのレイヤーの表示を切り替える。 */
function applyTraffic() {
  regulationLayer.update({
    type: "vector",
    source: regulationSource,
    polyline: { show: state.showRegulation },
  });
  reducedLayer.update({
    type: "vector",
    source: reducedSource,
    polyline: { show: state.showRegulation },
  });
  noEntryLayer.update({
    type: "vector",
    source: noEntrySource,
    polygon: { show: state.showNoEntry },
  });
  noEntryOutlineLayer.update({
    type: "vector",
    source: noEntryOutlineSource,
    polyline: { show: state.showNoEntry },
  });
  pedestrianFlow.setVisible(state.showPedestrian);
}

/** 水面の反射と粗さを反映する。 */
function applyWater() {
  riverLayer.update({
    type: "vector",
    source: riverSource,
    polygon: {
      reflectivity: state.reflection,
      roughness: state.waterRoughness,
      // 反射 0 のときは SSR を切って負荷を落とす
      water: state.reflection > 0.02,
    },
  });
  // BaseHandle の visible でエフェクト自体をオン・オフする
  ssr.visible = state.reflection > 0.02;
}

// ---------------------------------------------------------------------------
// 視点
// ---------------------------------------------------------------------------

/** 視点の実際の測地座標（地形の高さ + 目線の高さ）。 */
function viewpointGeodetic(vp: Viewpoint): Geodetic {
  // 橋の上の視点は川の中心線に載せる。橋の名称の代表点は端に寄っていることがあり、
  // そのまま使うと川から外れた場所に立つことになる。
  const [lng, lat] = vp.onRiver
    ? projectOnCenterline(river, [vp.lng, vp.lat])
    : [vp.lng, vp.lat];
  // スカイツリーのような構造物上の視点は、地面 + 建物高さとして扱う
  return { lng, lat, height: groundHeight(lng, lat) + vp.eye };
}

/** 見上げる対象（開花点のあたり）。 */
function targetOf(vp: Viewpoint): Geodetic {
  if (vp.faces === null) {
    return {
      lng: REFERENCE.lng,
      lat: 35.7085,
      height: groundHeight(REFERENCE.lng, 35.7085) + 240,
    };
  }
  const site = VENUE_SITES.find((s) => s.id === vp.faces)!;
  const c = venueCenter(site);
  return { lng: c.lng, lat: c.lat, height: groundHeight(c.lng, c.lat) + 260 };
}

/** 会場の開花点あたりの測地座標。現在地からの距離表示に使う。 */
function venueBurstPoint(id: 0 | 1): Geodetic {
  const site = VENUE_SITES.find((s) => s.id === id)!;
  const c = venueCenter(site);
  return { lng: c.lng, lat: c.lat, height: groundHeight(c.lng, c.lat) + 260 };
}

/** その視点から見た、対象会場までの距離と音の遅延。 */
function delayInfoFor(vp: Viewpoint) {
  const d = distanceMeters(viewpointGeodetic(vp), targetOf(vp));
  return { distance: d, delay: d / SPEED_OF_SOUND };
}

/**
 * 自由視点の初期位置。
 * 蔵前橋の上空 974 m から北北西（方位 344.3 度）を見下ろす。
 * この向きだと第一会場が +26.8 度、第二会場が -26.6 度に入り、
 * 両会場が画面の左右に収まる。
 */
const FREE_CAMERA_HOME = {
  lng: 139.800957,
  lat: 35.701712,
  height: 974,
  pitch: -39.4,
  heading: 344.3,
};

let freeLookTimer = 0;
/** 観覧スポットに固定しているとき、その場所を見回しているか。 */
let lookLocked = false;

// ---------------------------------------------------------------------------
// ホイールで画角を変える（望遠にする）
//
// `cameraFreeLook(true)` はカメラと注視点の距離が 0 になるため、
// Navara の仕様でホイールのズームが無効になる。
// 観覧スポットに立っている状態では「前に進む」より
// 「レンズで寄る」方が体験として正しいので、
// ホイールを画角（fov）に割り当てる。双眼鏡に相当する。
// ---------------------------------------------------------------------------

const DEFAULT_FOV = 60;
const MIN_FOV = 12; // 望遠側（約 5 倍相当）
const MAX_FOV = 75; // 広角側
let fov = DEFAULT_FOV;

function setFov(v: number) {
  fov = Math.min(MAX_FOV, Math.max(MIN_FOV, v));
  view.camera.fov = fov;
}

canvas.addEventListener(
  "wheel",
  (e) => {
    // 自由視点のときは通常のズーム（前後移動）に任せる
    if (!lookLocked) return;
    e.preventDefault();
    // 画角は乗算で動かす。等倍ずつ寄る感覚になる。
    setFov(fov * Math.exp(e.deltaY * 0.0012));
    ui?.setZoom(DEFAULT_FOV / fov);
  },
  { passive: false },
);

/**
 * 視点の固定を外して、地図をマウスで自由に動かせるようにする。
 * ドラッグで回転・移動、ホイールでズーム。
 * 花火の音は常に現在のカメラ位置から計算されるので、
 * 動かした先の「見え方と聞こえ方」がそのまま反映される。
 */
/**
 * 自由視点に切り替える。
 *
 * Navara の左ドラッグは「地球を回す」操作なので、地表すぐの高さで
 * ドラッグすると視界が大きく振れてしまい、移動としては使えない。
 * そのため自由視点に入るときは、いったん上空へ引いて見下ろす姿勢にする。
 * この高さならドラッグが素直に「地図を動かす」ように働く。
 *
 * 地表付近の任意の地点に立ちたい場合は、地図をダブルクリックすると
 * その地点へ移動する（`pickTerrainPosition()` で拾っている）。
 */
function setFreeCamera(on: boolean, animate = true) {
  state.freeCamera = on;
  if (on) {
    view.cameraFreeLook(false);
    window.clearTimeout(freeLookTimer);
    lookLocked = false;
    // 望遠のまま移動すると操作しづらいので画角を戻す
    setFov(DEFAULT_FOV);
    ui?.setZoom(1);
    // 両会場が入る高さまで引いて、見下ろす姿勢にする
    // 蔵前橋の上空から北北西を見下ろす。両会場が左右 ±27 度に収まる構図。
    const cam = { ...FREE_CAMERA_HOME };
    if (animate) view.flyTo(cam, { duration: 1600, maxHeight: 2600 });
    else view.setCamera(cam);
  } else {
    gotoViewpoint(state.viewpoint);
  }
}

// ---------------------------------------------------------------------------
// 移動操作の補助
//
// Navara の標準操作は「左ドラッグ = 地球を回す / 右ドラッグ = 傾ける /
// ホイール = ズーム」で、地点をずらす pan の割り当てがない。
// 地表付近では回転が移動として使いづらいので、次の 2 つを足している。
//   1. ダブルクリック：その地点へ移動する
//   2. WASD / 矢印キー：前後左右に歩く（Q/E で上下、Shift で加速）
// ---------------------------------------------------------------------------

/** ダブルクリックした地点へ移動する。 */
canvas.addEventListener("dblclick", (e) => {
  const hit =
    view.pickTerrainPosition(e.clientX, e.clientY) ??
    view.pickDepthPosition(e.clientX, e.clientY);
  if (!hit) return;
  const g = fromEcef(hit);
  // 目線の高さ（1.6 m）で立つ。向きは今の向きを保つ。
  const o = view.camera.orientation;
  state.freeCamera = true;
  view.cameraFreeLook(false);
  lookLocked = false;
  ui?.setFreeCamera(true);
  view.flyTo(
    {
      lng: g.lng,
      lat: g.lat,
      height: g.height + 1.6,
      pitch: o.pitch ?? 10,
      heading: o.heading ?? 0,
    },
    { duration: 1400, maxHeight: Math.max(400, g.height + 500) },
  );
});

/** 押されているキー。 */
const keys = new Set<string>();
const MOVE_KEYS = new Set([
  "w", "a", "s", "d", "q", "e",
  "arrowup", "arrowdown", "arrowleft", "arrowright",
]);

window.addEventListener("keydown", (e) => {
  const k = e.key.toLowerCase();
  if (!MOVE_KEYS.has(k)) return;
  // 入力欄にフォーカスがあるときは邪魔しない
  const el = document.activeElement;
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return;
  e.preventDefault();
  keys.add(k);
});
window.addEventListener("keydown", (e) => {
  if (e.key === "Shift") keys.add("shift");
});
window.addEventListener("keyup", (e) => {
  keys.delete(e.key.toLowerCase());
  if (e.key === "Shift") keys.delete("shift");
});
window.addEventListener("blur", () => keys.clear());

/** キー入力に応じてカメラを動かす。dt は秒。 */
function applyKeyboardMove(dt: number) {
  if (keys.size === 0) return;
  // 高いところにいるほど速く動く（地図として自然な感覚にする）
  const alt = Math.max(
    2,
    view.camera.positionGeographic.height - TOKYO_GEOID_HEIGHT,
  );
  const base = Math.min(2000, Math.max(12, alt * 0.55));
  const speed = base * (keys.has("shift") ? 3 : 1) * dt;

  if (keys.has("w") || keys.has("arrowup")) view.moveCamera(CameraDirection.Forward, speed);
  if (keys.has("s") || keys.has("arrowdown")) view.moveCamera(CameraDirection.Backward, speed);
  if (keys.has("a") || keys.has("arrowleft")) view.moveCamera(CameraDirection.Left, speed);
  if (keys.has("d") || keys.has("arrowright")) view.moveCamera(CameraDirection.Right, speed);
  if (keys.has("e")) view.moveCamera(CameraDirection.Up, speed);
  if (keys.has("q")) view.moveCamera(CameraDirection.Down, speed);

  // キーで動かしたら視点固定を解除する（固定のままだと位置が戻ってしまう）
  if (!state.freeCamera) {
    state.freeCamera = true;
    window.clearTimeout(freeLookTimer);
    view.cameraFreeLook(false);
    lookLocked = false;
    ui?.setFreeCamera(true);
  }
}

function gotoViewpoint(vp: Viewpoint, animate = true) {
  state.viewpoint = vp;
  state.freeCamera = false;
  const pos = viewpointGeodetic(vp);
  const target = targetOf(vp);
  const heading = vp.heading ?? (vp.faces === null ? 20 : bearingDegrees(pos, target));
  // 視点ごとの画角。指定がなければ既定に戻す。
  setFov(vp.fov ?? DEFAULT_FOV);
  ui?.setZoom(DEFAULT_FOV / (vp.fov ?? DEFAULT_FOV));

  window.clearTimeout(freeLookTimer);
  view.cameraFreeLook(false);
  lookLocked = false;

  if (vp.distance !== undefined) {
    // 俯瞰：注視点から離れた位置に置く
    const cam = {
      lng: target.lng,
      lat: target.lat,
      height: target.height,
      distance: vp.distance,
      pitch: vp.pitch,
      heading,
    };
    if (animate) view.flyTo(cam, { duration: 2400, maxHeight: 3000 });
    else view.setCamera(cam);
    return;
  }

  const cam = {
    lng: pos.lng,
    lat: pos.lat,
    height: pos.height,
    pitch: vp.pitch,
    heading,
  };
  if (animate) view.flyTo(cam, { duration: 2200, maxHeight: Math.max(1500, pos.height + 900) });
  else view.setCamera(cam);

  if (vp.freeLook) {
    // 位置を固定してドラッグで見回すモード。花火を見上げる体験に合う。
    freeLookTimer = window.setTimeout(() => {
      if (state.freeCamera) return; // 途中で自由視点に切り替わっていたら何もしない
      view.cameraFreeLook(true, { lng: pos.lng, lat: pos.lat, height: pos.height });
      lookLocked = true;
    }, animate ? 2300 : 60);
  }
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

const ui = buildUi({
  viewpoints: VIEWPOINTS,
  initial: state,
  delayInfo: delayInfoFor,
  onViewpoint: (vp) => gotoViewpoint(vp),
  onFreeCamera: (on) => setFreeCamera(on),
  onResetZoom: () => {
    setFov(DEFAULT_FOV);
    ui.setZoom(1);
  },
  onHour: (v) => {
    // 時刻スライダーが番組の頭出しも兼ねる
    state.hour = v;
    applyHour(v, true);
    applyNight();
    fireworks.reset();
    smoke.reset();
    // 打ち上げ時間帯の外にいるときは番組を頭に戻しておく
    program.seek(
      v >= SHOW_START_HOUR && v < SHOW_END_HOUR
        ? Math.max(0, programTimeFromHour(v))
        : 0,
    );
  },
  onPlaying: (on) => {
    state.playing = on;
  },
  onCloud: (v) => {
    state.cloud = v;
    applyCloud();
  },
  onRain: (v) => {
    state.rain = v;
    applyRain(v);
  },
  onExposure: (v) => {
    state.exposure = v;
    applyExposure();
  },
  onSpeed: (v) => {
    state.speed = v;
  },
  onVolume: (v) => {
    audio.volume = v;
  },
  onQuality: (v) => {
    state.quality = v;
    fireworks.quality = v;
  },
  onWindFrom: (v) => {
    state.windFrom = v;
    smoke.windFrom = v;
    fireworks.windFrom = v;
    applyRain(state.rain); // 雨の傾きは風向で決まる
  },
  onWindSpeed: (v) => {
    state.windSpeed = v;
    smoke.windSpeed = v;
    fireworks.windSpeed = v;
    applyRain(state.rain);
  },
  onSmoke: (v) => {
    state.smoke = v;
    smoke.amount = v;
  },
  onRoadGlow: (v) => {
    state.roadGlow = v;
    applyRoadGlow();
  },
  onRoadGlowStrength: (v) => {
    state.roadGlowStrength = v;
    applyRoadGlow();
  },
  onRegulation: (v) => {
    state.showRegulation = v;
    applyTraffic();
  },
  onNoEntry: (v) => {
    state.showNoEntry = v;
    applyTraffic();
  },
  onPedestrian: (v) => {
    state.showPedestrian = v;
    applyTraffic();
  },
  onReflection: (v) => {
    state.reflection = v;
    applyWater();
  },
  onWaterRoughness: (v) => {
    state.waterRoughness = v;
    applyWater();
  },
  onSound: async (on) => {
    if (on) await audio.enable();
    else audio.disable();
    return audio.enabled;
  },
});

// 各視点の地面の高さが判明したら、距離表示と（表示中なら）カメラ位置を補正する
for (const vp of VIEWPOINTS) {
  watchGround(vp.lng, vp.lat, () => {
    ui.refreshViewpointMeta(vp.id, delayInfoFor(vp));
    if (!state.freeCamera && state.viewpoint.id === vp.id) gotoViewpoint(vp, false);
  });
}

// 初期状態を反映
applyHour(state.hour, true);
applyRain(state.rain);
applyExposure();
fireworks.quality = state.quality;
fireworks.windFrom = state.windFrom;
fireworks.windSpeed = state.windSpeed;
smoke.windFrom = state.windFrom;
smoke.windSpeed = state.windSpeed;
smoke.amount = state.smoke;
applyWater();
applyTraffic();
applyNight(true);
applyRoadGlow();
if (state.freeCamera) setFreeCamera(true, false);
else gotoViewpoint(state.viewpoint, false);

// ---------------------------------------------------------------------------
// メインループ
// ---------------------------------------------------------------------------

let lastT: number | null = null;

view.on("preRender", (t: number) => {
  const dtRaw = lastT === null ? 0 : (t - lastT) / 1000;
  lastT = t;
  // タブを戻したときに一気に進まないよう上限を設ける
  const dtReal = Math.min(0.05, Math.max(0, dtRaw));
  const dt = state.playing ? dtReal * state.speed : 0;

  // カメラ操作は一時停止中も効かせたいので dt ではなく実時間を使う
  applyKeyboardMove(Math.min(0.05, Math.max(0, dtRaw)));

  if (dt > 0) {
    // 打ち上げ中だけ等速。その前後は空だけ早送りする。
    const inShow = state.hour >= SHOW_START_HOUR && state.hour < SHOW_END_HOUR;
    const prevHour = state.hour;
    state.hour +=
      dt * HOUR_PER_SECOND * (inShow ? 1 : PRE_SHOW_FAST_FORWARD);

    // 19:00 をまたいだ瞬間に番組を頭出しする
    if (prevHour < SHOW_START_HOUR && state.hour >= SHOW_START_HOUR) {
      state.hour = SHOW_START_HOUR;
      program.seek(0);
    }

    // 時刻は一方向にだけ進み、上限に達したら下限へ戻る。
    // 以前は番組の進行から時刻を逆算していたため、20:30 を超えると
    // 番組がループして時刻が 19:00 台へ引き戻され、
    // スライダーを 20:30 より先へ動かせなくなっていた。
    if (state.hour >= CLOCK_END_HOUR) {
      state.hour = CLOCK_START_HOUR;
      program.seek(0);
      fireworks.reset();
      smoke.reset();
    }

    if (inShow) {
      for (const shell of program.advance(dt)) fireworks.launch(shell);
    }

    const before = appliedHour;
    applyHour(state.hour);
    if (appliedHour !== before) {
      ui.setHour(Number(state.hour.toFixed(3)));
      applyNight();
    }
    fireworks.update(dt);
    smoke.update(dt);
  }
  // 矢印は一時停止中も流したいので実時間で動かす
  pedestrianFlow.update(Math.min(0.05, Math.max(0, dtRaw)));


  // 現在のカメラ位置から各会場までの距離と音の遅れ（自由視点でも常に正しい）
  const cam = readCameraEcef();
  const d0 = cam.distanceTo(toEcef(venueBurstPoint(0)));
  const d1 = cam.distanceTo(toEcef(venueBurstPoint(1)));

  ui.tick({
    phaseLabel: phaseLabelFor(state.hour),
    particles: fireworks.particleCount,
    emitters: fireworks.activeEmitters,
    lastDelay,
    lastDistance,
    venue0: { distance: d0, delay: d0 / SPEED_OF_SOUND },
    venue1: { distance: d1, delay: d1 / SPEED_OF_SOUND },
    freeCamera: state.freeCamera,
  });
});

// ---------------------------------------------------------------------------
// 帰属表示（ライセンス上必須）
// ---------------------------------------------------------------------------

view.attribution?.add([
  {
    attributionHtml: `出典：<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">地理院タイル（シームレス空中写真）</a>／色調を編集・加工して使用`,
  },
  {
    attributionHtml: `出典：<a href="https://www.mlit.go.jp/plateau/" target="_blank" rel="noopener">国土交通省 PLATEAU</a> 3D都市モデル（東京都台東区・墨田区 建築物）／色を編集・加工して使用`,
  },
  {
    attribution: "© Re:Earth Terrain",
    attributionUrl: "https://terrain.reearth.land/",
  },
  {
    attributionHtml: `出典：<a href="https://maps.gsi.go.jp/development/vt_expt.html" target="_blank" rel="noopener">地理院タイル（ベクトルタイル提供実験）</a>／道路データの表現を編集・加工して使用`,
  },
  { attribution: "© Mapterhorn", attributionUrl: "https://mapterhorn.com/" },
  {
    attribution: "Powered by Navara",
    attributionUrl: "https://github.com/reearth/navara",
  },
]);

// ---------------------------------------------------------------------------
// 音の自動有効化
//
// ブラウザの自動再生制限があるため、読み込み直後に音を鳴らすことはできない。
// 最初のユーザー操作（クリック・キー入力・スクロール）を捉えて、
// そのタイミングで AudioContext を起こす。ボタンを押す手間がなくなる。
// ---------------------------------------------------------------------------

const enableAudioOnce = async () => {
  window.removeEventListener("pointerdown", enableAudioOnce);
  window.removeEventListener("keydown", enableAudioOnce);
  window.removeEventListener("wheel", enableAudioOnce);
  await audio.enable();
  ui.setSound(audio.enabled);
};
window.addEventListener("pointerdown", enableAudioOnce, { once: true });
window.addEventListener("keydown", enableAudioOnce, { once: true });
window.addEventListener("wheel", enableAudioOnce, { once: true });

// ローディング表示を消す
const loading = document.getElementById("loading");
if (loading) {
  loading.classList.add("done");
  window.setTimeout(() => loading.remove(), 900);
}

// デバッグ用にコンソールから触れるようにしておく
declare global {
  interface Window {
    view: typeof view;
    fireworks: typeof fireworks;
    smoke: typeof smoke;
    program: typeof program;
    state: typeof state;
    buildingLayers: typeof buildingLayers;
    riverLayer: typeof riverLayer;
    rain: typeof rain;
    ssr: typeof ssr;
    roadLayer: typeof roadLayer;
    regulationLayer: typeof regulationLayer;
    reducedLayer: typeof reducedLayer;
    noEntryLayer: typeof noEntryLayer;
    noEntryOutlineLayer: typeof noEntryOutlineLayer;
    pedestrianFlow: typeof pedestrianFlow;
    applyNight: typeof applyNight;
  }
}
Object.assign(window, {
  view,
  fireworks,
  smoke,
  program,
  state,
  buildingLayers,
  riverLayer,
  rain,
  ssr,
  roadLayer,
  regulationLayer,
  reducedLayer,
  noEntryLayer,
  noEntryOutlineLayer,
  pedestrianFlow,
  applyNight,
});
