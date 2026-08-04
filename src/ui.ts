import type { Viewpoint } from "./viewpoints";

type UiOptions = {
  viewpoints: Viewpoint[];
  initial: {
    hour: number;
    playing: boolean;
    cloud: number;
    rain: number;
    exposure: number;
    speed: number;
    quality: number;
    freeCamera: boolean;
    windFrom: number;
    windSpeed: number;
    smoke: number;
    roadGlow: boolean;
    roadGlowStrength: number;
    showRegulation: boolean;
    showPedestrian: boolean;
    reflection: number;
    waterRoughness: number;
    viewpoint: Viewpoint;
  };
  delayInfo: (vp: Viewpoint) => { distance: number; delay: number };
  onViewpoint: (vp: Viewpoint) => void;
  onFreeCamera: (on: boolean) => void;
  onResetZoom: () => void;
  onWindFrom: (v: number) => void;
  onWindSpeed: (v: number) => void;
  onSmoke: (v: number) => void;
  onRoadGlow: (on: boolean) => void;
  onRoadGlowStrength: (v: number) => void;
  onRegulation: (on: boolean) => void;
  onPedestrian: (on: boolean) => void;
  onReflection: (v: number) => void;
  onWaterRoughness: (v: number) => void;
  onHour: (v: number) => void;
  onPlaying: (on: boolean) => void;
  onCloud: (v: number) => void;
  onRain: (v: number) => void;
  onExposure: (v: number) => void;
  onSpeed: (v: number) => void;
  onVolume: (v: number) => void;
  onQuality: (v: number) => void;
  onSound: (on: boolean) => Promise<boolean>;
};

export type UiTickInfo = {
  /** いま何をしている時間か（場面名、または「打ち上げ前」）。 */
  phaseLabel: string;
  particles: number;
  emitters: number;
  lastDelay: number;
  lastDistance: number;
  /** 現在のカメラ位置から第一会場までの距離と音の遅れ。 */
  venue0: { distance: number; delay: number };
  /** 同じく第二会場まで。 */
  venue1: { distance: number; delay: number };
  freeCamera: boolean;
};

const fmtHour = (h: number) => {
  const hh = Math.floor(h);
  const mm = Math.floor((h - hh) * 60);
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
};

/** 方位角を 16 方位の日本語表記にする。 */
const COMPASS = [
  "北", "北北東", "北東", "東北東", "東", "東南東", "南東", "南南東",
  "南", "南南西", "南西", "西南西", "西", "西北西", "北西", "北北西",
];
const compass = (deg: number) => COMPASS[Math.round((deg % 360) / 22.5) % 16]!;

/** 風速の体感表現。 */
const beaufort = (v: number) => {
  if (v < 0.3) return "（無風）";
  if (v < 1.6) return "（そよ風）";
  if (v < 3.4) return "（軽風）";
  if (v < 5.5) return "（軟風）";
  if (v < 8.0) return "（和風）";
  return "（疾風）";
};

const fmtDist = (m: number) =>
  m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`;

type SliderHandle = { el: HTMLElement; set(v: number): void };

/** チェックボックス 1 個。 */
function checkbox(opts: {
  label: string;
  note?: string;
  checked: boolean;
  onChange: (on: boolean) => void;
}): HTMLElement {
  const wrap = document.createElement("label");
  wrap.className = "check";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = opts.checked;
  input.addEventListener("change", () => opts.onChange(input.checked));
  const body = document.createElement("span");
  body.className = "check-body";
  const name = document.createElement("span");
  name.className = "check-label";
  name.textContent = opts.label;
  body.append(name);
  if (opts.note) {
    const note = document.createElement("span");
    note.className = "check-note";
    note.textContent = opts.note;
    body.append(note);
  }
  wrap.append(input, body);
  return wrap;
}

function slider(opts: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  format: (v: number) => string;
  onInput: (v: number) => void;
}): SliderHandle {
  const wrap = document.createElement("label");
  wrap.className = "ctl";
  const head = document.createElement("div");
  head.className = "ctl-head";
  const name = document.createElement("span");
  name.textContent = opts.label;
  const val = document.createElement("span");
  val.className = "ctl-val";
  val.textContent = opts.format(opts.value);
  head.append(name, val);

  const input = document.createElement("input");
  input.type = "range";
  input.min = String(opts.min);
  input.max = String(opts.max);
  input.step = String(opts.step);
  input.value = String(opts.value);
  input.addEventListener("input", () => {
    const v = Number(input.value);
    val.textContent = opts.format(v);
    opts.onInput(v);
  });

  wrap.append(head, input);
  return {
    el: wrap,
    /** 外部から値を書き戻す（onInput は発火しない）。 */
    set(v: number) {
      input.value = String(v);
      val.textContent = opts.format(v);
    },
  };
}

export function buildUi(opts: UiOptions) {
  const root = document.createElement("div");
  root.id = "ui";

  // --- パネル本体 ------------------------------------------------------------
  const panel = document.createElement("div");
  panel.className = "panel";

  const title = document.createElement("div");
  title.className = "title";
  title.innerHTML = `
    <h1>隅田川花火大会 3Dシミュレーション</h1>
    <p>第49回・2026年7月25日<span class="sub">Navara map engine</span></p>
  `;
  panel.append(title);

  // --- 観覧スポット ---------------------------------------------------------
  const vpSection = document.createElement("section");
  vpSection.innerHTML = `<h2>観覧スポット</h2>`;
  const freeBtn = document.createElement("button");
  freeBtn.className = "btn free";
  freeBtn.innerHTML = `🖱 地図を自由に動かす<span class="free-note">上空に引いて見下ろす姿勢になります。ドラッグで移動・ホイールでズーム</span>`;
  let freeOn = opts.initial.freeCamera;
  freeBtn.addEventListener("click", () => {
    freeOn = !freeOn;
    freeBtn.classList.toggle("active", freeOn);
    if (freeOn) for (const b of buttons.values()) b.classList.remove("active");
    else buttons.get(currentVp)?.classList.add("active");
    opts.onFreeCamera(freeOn);
  });
  vpSection.append(freeBtn);

  const zoomRow = document.createElement("div");
  zoomRow.className = "zoom-row";
  const zoomLabel = document.createElement("span");
  zoomLabel.className = "zoom-label";
  zoomLabel.textContent = "画角 1.0×";
  const zoomReset = document.createElement("button");
  zoomReset.className = "btn tiny";
  zoomReset.textContent = "リセット";
  zoomReset.addEventListener("click", () => opts.onResetZoom());
  zoomRow.append(zoomLabel, zoomReset);
  vpSection.append(zoomRow);

  const vpHint = document.createElement("div");
  vpHint.className = "controls";
  vpHint.innerHTML = `
    <div class="controls-title">移動のしかた</div>
    <dl>
      <dt>ダブルクリック</dt><dd>その地点に立つ</dd>
      <dt>W A S D／矢印</dt><dd>前後左右に歩く（Shift で加速）</dd>
      <dt>Q／E</dt><dd>下がる／上がる</dd>
      <dt>ドラッグ</dt><dd>視線を回す・右ドラッグで傾ける</dd>
      <dt>ホイール</dt><dd>観覧スポット中は画角（望遠）／自由視点中はズーム</dd>
    </dl>
  `;
  vpSection.append(vpHint);

  const vpList = document.createElement("div");
  vpList.className = "vp-list";

  const buttons = new Map<string, HTMLButtonElement>();
  const metaEls = new Map<string, HTMLElement>();
  let currentVp = opts.initial.viewpoint.id;
  const metaHtml = (info: { distance: number; delay: number }) =>
    `${fmtDist(info.distance)} ・ 音の遅れ <b>${info.delay.toFixed(1)}秒</b>`;

  for (const vp of opts.viewpoints) {
    const b = document.createElement("button");
    b.className = "vp";

    const name = document.createElement("span");
    name.className = "vp-name";
    name.textContent = vp.name;

    const meta = document.createElement("span");
    meta.className = "vp-meta";
    meta.innerHTML = metaHtml(opts.delayInfo(vp));

    const note = document.createElement("span");
    note.className = "vp-note";
    note.textContent = vp.note;

    b.append(name, meta, note);
    b.addEventListener("click", () => {
      for (const other of buttons.values()) other.classList.remove("active");
      b.classList.add("active");
      currentVp = vp.id;
      freeOn = false;
      freeBtn.classList.remove("active");
      opts.onViewpoint(vp);
    });
    buttons.set(vp.id, b);
    metaEls.set(vp.id, meta);
    vpList.append(b);
  }
  currentVp = opts.initial.viewpoint.id;
  if (!freeOn) buttons.get(currentVp)?.classList.add("active");
  freeBtn.classList.toggle("active", freeOn);
  vpSection.append(vpList);
  panel.append(vpSection);

  // --- 時刻と天候 -----------------------------------------------------------
  const envSection = document.createElement("section");
  envSection.innerHTML = `<h2>時刻と天候</h2>`;

  // 場面表示（時刻スライダーの真上に置く）
  const phaseLabel = document.createElement("div");
  phaseLabel.className = "phase";
  envSection.append(phaseLabel);

  const hourSlider = slider({
    label: "時刻（JST）",
    // 日没（18:52）直前の 18:30 から、打ち上げ終了の 20:30 まで。
    min: 18.5,
    max: 20.5,
    // 30 秒刻み。場面の頭出しができる細かさ。
    step: 0.5 / 60,
    value: opts.initial.hour,
    format: fmtHour,
    onInput: opts.onHour,
  });

  const cloudSlider = slider({
    label: "雲量",
    min: 0,
    max: 1,
    step: 0.01,
    value: opts.initial.cloud,
    format: (v) => `${Math.round(v * 100)}%`,
    onInput: opts.onCloud,
  });

  const playRow = document.createElement("div");
  playRow.className = "row";
  const playBtn = document.createElement("button");
  playBtn.className = "btn";
  let playing = opts.initial.playing;
  const paintPlay = () => {
    playBtn.textContent = playing ? "⏸ 一時停止" : "▶ 再生";
    playBtn.classList.toggle("active", playing);
  };
  playBtn.addEventListener("click", () => {
    playing = !playing;
    paintPlay();
    opts.onPlaying(playing);
  });
  paintPlay();
  playRow.append(playBtn);

  envSection.append(
    hourSlider.el,
    playRow,
    slider({
      label: "時間の進む速さ",
      min: 0.25,
      max: 4,
      step: 0.25,
      value: opts.initial.speed,
      format: (v) => `${v.toFixed(2)}×`,
      onInput: opts.onSpeed,
    }).el,
    cloudSlider.el,
    slider({
      label: "雨量",
      min: 0,
      max: 1,
      step: 0.01,
      value: opts.initial.rain,
      format: (v) =>
        v < 0.01
          ? "なし"
          : v < 0.25
            ? `小雨（${Math.round(v * 100)}%）`
            : v < 0.6
              ? `本降り（${Math.round(v * 100)}%）`
              : `激しい雨（${Math.round(v * 100)}%）`,
      onInput: opts.onRain,
    }).el,
    slider({
      label: "明るさ補正",
      min: 0.2,
      max: 3,
      step: 0.05,
      value: opts.initial.exposure,
      format: (v) =>
        Math.abs(v - 1) < 0.03 ? "標準" : `${v < 1 ? "" : "+"}${((v - 1) * 100).toFixed(0)}%`,
      onInput: opts.onExposure,
    }).el,
  );
  const envHint = document.createElement("p");
  envHint.className = "hint";
  envHint.textContent =
    "時刻がこの作品の主軸です。動かすと太陽の位置が変わって空の色と明るさが物理的に計算され、同時に番組の頭出しにもなります。打ち上げは 19:00〜20:30。7/25 の東京の日没は 18:52 なので、19:00 はまだ薄明かりが残っています。露出は時刻に応じて自動調整されるので、スライダーはその補正だけを行います。";
  envSection.append(envHint);
  panel.append(envSection);

  // --- 風と煙 -------------------------------------------------------------
  const windSection = document.createElement("section");
  windSection.innerHTML = `<h2>風と煙</h2>`;
  windSection.append(
    slider({
      label: "風向（吹いてくる方向）",
      min: 0,
      max: 355,
      step: 5,
      value: opts.initial.windFrom,
      format: (v) => `${compass(v)}（${Math.round(v)}°）`,
      onInput: opts.onWindFrom,
    }).el,
    slider({
      label: "風速",
      min: 0,
      max: 12,
      step: 0.2,
      value: opts.initial.windSpeed,
      format: (v) => `${v.toFixed(1)} m/s${beaufort(v)}`,
      onInput: opts.onWindSpeed,
    }).el,
    slider({
      label: "煙の量",
      min: 0,
      max: 1.4,
      step: 0.05,
      value: opts.initial.smoke,
      format: (v) => (v < 0.03 ? "なし" : `${Math.round(v * 100)}%`),
      onInput: opts.onSmoke,
    }).el,
  );
  // --- 音 -------------------------------------------------------------------
  const audioSection = document.createElement("section");
  audioSection.innerHTML = `<h2>音</h2>`;
  const soundBtn = document.createElement("button");
  soundBtn.className = "btn primary";
  soundBtn.textContent = "🔊 音を有効にする";
  let soundOn = false;
  soundBtn.addEventListener("click", async () => {
    const ok = await opts.onSound(!soundOn);
    soundOn = ok;
    soundBtn.textContent = ok ? "🔊 音：オン" : "🔇 音を有効にする";
    soundBtn.classList.toggle("active", ok);
  });
  audioSection.append(soundBtn);
  audioSection.append(
    slider({
      label: "音量",
      min: 0,
      max: 1,
      step: 0.01,
      value: 0.7,
      format: (v) => `${Math.round(v * 100)}%`,
      onInput: opts.onVolume,
    }).el,
  );
  const audioHint = document.createElement("p");
  audioHint.className = "hint";
  audioHint.textContent =
    "音速は 343 m/s。開花点から視点までの距離を音速で割った秒数だけ遅らせて鳴らしています。距離が遠いほど高い音は空気に吸収されるので、低くこもった音になります。";
  audioSection.append(audioHint);

  const roadSection = document.createElement("section");
  roadSection.innerHTML = `<h2>夜の街</h2>`;
  roadSection.append(
    checkbox({
      label: "道路を光らせる",
      note: "国土地理院のベクトルタイルの道路データを、地形に貼り付けて光らせます",
      checked: opts.initial.roadGlow,
      onChange: opts.onRoadGlow,
    }),
    slider({
      label: "道路の光の強さ",
      min: 0,
      max: 1,
      step: 0.01,
      value: opts.initial.roadGlowStrength,
      format: (v) => (v < 0.02 ? "なし" : `${Math.round(v * 100)}%`),
      onInput: opts.onRoadGlowStrength,
    }).el,
  );
  const roadHint = document.createElement("p");
  roadHint.className = "hint";
  roadHint.textContent =
    "夜だけ光ります。太陽高度から昼夜を判定しているので、日が暮れるにつれて道路の光が立ち上がります。";
  roadSection.append(roadHint);

  const trafficSection = document.createElement("section");
  trafficSection.innerHTML = `<h2>交通規制</h2>`;
  trafficSection.append(
    checkbox({
      label: "交通規制区域",
      note: "赤＝車両通行止め、黄＝歩行者規制のかかる橋",
      checked: opts.initial.showRegulation,
      onChange: opts.onRegulation,
    }),
    checkbox({
      label: "歩行者の進行方向",
      note: "地面を流れる点線。夜は光ります",
      checked: opts.initial.showPedestrian,
      onChange: opts.onPedestrian,
    }),
  );
  const trafficWarn = document.createElement("p");
  trafficWarn.className = "hint warn";
  trafficWarn.innerHTML =
    "⚠️ ここに表示している規制区間と動線は<b>イメージ</b>です。実際の通行判断には使えません。";
  trafficSection.append(trafficWarn);

  const waterSection = document.createElement("section");
  waterSection.innerHTML = `<h2>水面</h2>`;
  waterSection.append(
    slider({
      label: "映り込みの強さ",
      min: 0,
      max: 1,
      step: 0.01,
      value: opts.initial.reflection,
      format: (v) => (v < 0.02 ? "なし" : `${Math.round(v * 100)}%`),
      onInput: opts.onReflection,
    }).el,
    slider({
      label: "水面の粗さ（波の細かさ）",
      min: 0.02,
      max: 0.6,
      step: 0.01,
      value: opts.initial.waterRoughness,
      format: (v) => (v < 0.1 ? `${v.toFixed(2)}（鏡に近い）` : v.toFixed(2)),
      onInput: opts.onWaterRoughness,
    }).el,
  );
  const waterHint = document.createElement("p");
  waterHint.className = "hint";
  waterHint.textContent =
    "隅田川の水面に花火が映ります。スクリーンスペース反射なので、花火と川面が同じ画面に入っているときに効きます。真上を見上げて川が画面外にあるときは映りません。";
  waterSection.append(waterHint);

  const windHint = document.createElement("p");
  windHint.className = "hint";
  windHint.textContent =
    "風速を 0 にすると煙が会場の上に滞留し、後半の玉が霞んで見えなくなります。実際の花火大会で「今年は煙で見えなかった」と言われる状態です。3〜5 m/s あると流れて最後まできれいに見えます。雨は風下へ傾くので、風速を上げると横殴りになります。";
  windSection.append(windHint);
  panel.append(windSection);
  panel.append(audioSection);
  panel.append(roadSection);
  panel.append(trafficSection);
  panel.append(waterSection);

  // --- 描画 -----------------------------------------------------------------
  const drawSection = document.createElement("section");
  drawSection.innerHTML = `<h2>描画</h2>`;
  drawSection.append(
    slider({
      label: "描画品質（星の数）",
      min: 0.4,
      max: 1,
      step: 0.05,
      value: opts.initial.quality,
      format: (v) => `${Math.round(v * 100)}%`,
      onInput: opts.onQuality,
    }).el,
  );
  const qHint = document.createElement("p");
  qHint.className = "hint";
  qHint.textContent =
    "ピーク時の星は 100% で約 22,000 個です。動きが重いときは下げてください。";
  drawSection.append(qHint);
  panel.append(drawSection);


  // --- 数値表示 -------------------------------------------------------------
  const readout = document.createElement("div");
  readout.className = "readout";
  panel.append(readout);

  root.append(panel);

  // --- 折りたたみボタン（スマホ・スクショ用） --------------------------------
  const toggle = document.createElement("button");
  toggle.className = "toggle";
  toggle.textContent = "≡";
  toggle.title = "パネルの表示切り替え";
  toggle.addEventListener("click", () => root.classList.toggle("collapsed"));
  root.append(toggle);

  document.body.append(root);

  let frame = 0;
  return {
    /** 音が有効になったことをボタンに反映する。 */
    setSound(on: boolean) {
      soundOn = on;
      soundBtn.textContent = on ? "🔊 音：オン" : "🔇 音を有効にする";
      soundBtn.classList.toggle("active", on);
    },
    /** 外部（ダブルクリックやキー操作）から自由視点に入ったことを反映する。 */
    setFreeCamera(on: boolean) {
      if (freeOn === on) return;
      freeOn = on;
      freeBtn.classList.toggle("active", on);
      if (on) for (const b of buttons.values()) b.classList.remove("active");
    },
    /** ホイール操作による画角の倍率表示を更新する。 */
    setZoom(mult: number) {
      zoomLabel.textContent = `画角 ${mult.toFixed(1)}×`;
    },
    /** 番組進行に合わせて時刻スライダーを動かす。 */
    setHour(v: number) {
      hourSlider.set(v);
    },
    /** 雨量に連動して雲量スライダーを動かす。 */
    setCloud(v: number) {
      cloudSlider.set(v);
    },
    /** 地形の高さが判明したあとに距離・遅延の表示を更新する。 */
    refreshViewpointMeta(id: string, info: { distance: number; delay: number }) {
      const el = metaEls.get(id);
      if (el) el.innerHTML = metaHtml(info);
    },
    tick(info: UiTickInfo) {
      // 表示更新は毎フレーム要らない
      if (frame++ % 6 !== 0) return;
      phaseLabel.textContent = info.phaseLabel;
      readout.innerHTML = `
        <div class="wide"><span>現在地${info.freeCamera ? "（自由視点）" : ""}から</span><b>第一会場 ${fmtDist(
          info.venue0.distance,
        )}／遅れ ${info.venue0.delay.toFixed(1)}秒</b></div>
        <div class="wide"><span></span><b>第二会場 ${fmtDist(
          info.venue1.distance,
        )}／遅れ ${info.venue1.delay.toFixed(1)}秒</b></div>
        <div><span>直近の開花まで</span><b>${fmtDist(info.lastDistance)}</b></div>
        <div><span>音の遅れ</span><b>${info.lastDelay.toFixed(2)} 秒</b></div>
        <div><span>描画中の星</span><b>${info.particles.toLocaleString()}</b></div>
        <div><span>発光中の玉</span><b>${info.emitters}</b></div>
      `;
    },
  };
}
