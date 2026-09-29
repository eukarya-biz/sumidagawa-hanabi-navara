import type ThreeView from "@navaramap/three";
import {
  Pass,
  SelectiveEffectDesc,
  createFullscreenQuad,
  type EffectConfig,
  type EffectUpdate,
  type GBufferName,
  type SelectiveEffectConfig,
  type ViewContext,
} from "@navaramap/three";
import { MipmapBlurPass, Pass as PostProcessingPass } from "postprocessing";
import {
  HalfFloatType,
  Mesh,
  RGBAFormat,
  Scene,
  ShaderMaterial,
  Vector2,
  WebGLRenderTarget,
  type OrthographicCamera,
  type PlaneGeometry,
  type Texture,
  type WebGLRenderer,
} from "three";
import type { AppView } from "./navara";

/**
 * 選択的 Bloom の、滲みが丸く滑らかになる版。
 *
 * Navara 標準の `selectiveBloom` は UnrealBloomPass 系で、5 段のミップを
 * それぞれ単純バイリニアで引き伸ばして足す。最も低いミップは画面の 1/32
 * 解像度なので、遠くまで滲ませると拡大時の四角いピラミッドの形が残る。
 *
 * ここでは抽出と合成は標準と同じにして、ブラーだけを postprocessing の
 * `MipmapBlurPass`（13 タップでダウンサンプル → 9 タップのテントで 1 段ずつ
 * アップサンプル）に差し替える。1 段ずつ拡大するので四角い形が出ない。
 *
 * 同じ方式は Navara 本体にも入った（maplibre/navara #832）。リリースされたら
 * 標準の `selectiveBloom` に戻し、このファイルは外す。
 */
export type SmoothBloomConfig = {
  /** 加算する強さ。 */
  strength?: number;
  /** この輝度（0.299/0.587/0.114 の重み）未満は滲ませない。 */
  threshold?: number;
  /** 閾値の立ち上がり幅。0 に近いと境目がジャギる。 */
  smoothing?: number;
  /** アップサンプル時に下の段を混ぜる割合 0〜1。大きいほど広く柔らかい。 */
  radius?: number;
  /** ミップの段数。1 段ごとに滲みの広がりが倍になる。 */
  levels?: number;
  /** 抽出バッファの解像度倍率。ブラーはこの半分から始まる。 */
  resolutionScale?: number;
};

type SmoothBloomSettings = Required<SmoothBloomConfig>;

const DEFAULTS: SmoothBloomSettings = {
  strength: 1.0,
  threshold: 0.0,
  smoothing: 0.1,
  radius: 0.85,
  levels: 8,
  resolutionScale: 1.0,
};

export type SmoothBloomEffectConfig = {
  smoothBloom: SmoothBloomConfig;
} & SelectiveEffectConfig;

export type SmoothBloomEffectUpdate = {
  smoothBloom?: SmoothBloomConfig;
} & EffectUpdate;

const hasSmoothBloom = (config: EffectConfig): config is SmoothBloomEffectConfig =>
  "smoothBloom" in config;

export class SmoothBloomEffectDesc extends SelectiveEffectDesc<
  SmoothBloomEffectConfig,
  SmoothBloomEffectUpdate
> {
  static key = "smoothBloom";
  static insertAfter = ["mrt"];
  static insertBefore = ["transparent"];
  /** 抽出は id マスクに加えて emissive バッファを読む。 */
  static requiredBuffers: readonly GBufferName[] = ["selectiveEffect", "emissive"];

  /** 現在の設定。パスが毎フレーム読む。 */
  readonly settings: SmoothBloomSettings;

  // registerEffect は基底の EffectConfig を渡す型なので、ここで自分の config へ絞る
  constructor(view: ThreeView, ctx: ViewContext, config: EffectConfig) {
    const smoothBloom = hasSmoothBloom(config) ? config.smoothBloom : {};
    super(view, ctx, { ...config, selectiveEffect: true, smoothBloom });
    this.settings = { ...DEFAULTS, ...smoothBloom };
  }

  createPass(): Pass<SmoothBloomPass, null> {
    return new Pass(new SmoothBloomPass(this), null, { enabled: true });
  }

  onUpdateConfig(updates: SmoothBloomEffectUpdate): void {
    super.onUpdateConfig(updates);
    if (updates.smoothBloom) Object.assign(this.settings, updates.smoothBloom);
  }
}

type ExtractUniforms = {
  tEmissive: { value: Texture | null };
  tEffectIds: { value: Texture | null };
  uSlotBit: { value: number };
  uThreshold: { value: number };
  uSmoothing: { value: number };
};

type CompositeUniforms = {
  tBase: { value: Texture | null };
  tBloom: { value: Texture | null };
  uStrength: { value: number };
};

const FULLSCREEN_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

/** 抽出 → MipmapBlurPass → 加算合成。 */
class SmoothBloomPass extends PostProcessingPass {
  private readonly blur = new MipmapBlurPass();
  private readonly sourceRT: WebGLRenderTarget;
  // postprocessing の Pass が持つ scene/camera とは別に、自前の全画面クアッドで描く
  private readonly quadCamera: OrthographicCamera;
  private readonly geometry: PlaneGeometry;
  private readonly extractUniforms: ExtractUniforms;
  private readonly extractMaterial: ShaderMaterial;
  private readonly extractScene = new Scene();
  private readonly compositeUniforms: CompositeUniforms;
  private readonly compositeMaterial: ShaderMaterial;
  private readonly compositeScene = new Scene();
  private readonly size = new Vector2();

  constructor(private readonly desc: SmoothBloomEffectDesc) {
    super("SmoothBloomPass");
    this.needsSwap = true;

    const quad = createFullscreenQuad();
    this.quadCamera = quad.camera;
    this.geometry = quad.geometry;

    this.extractUniforms = {
      tEmissive: { value: null },
      tEffectIds: { value: null },
      uSlotBit: { value: 0 },
      uThreshold: { value: 0 },
      uSmoothing: { value: 0.1 },
    };
    this.extractMaterial = new ShaderMaterial({
      uniforms: this.extractUniforms,
      vertexShader: FULLSCREEN_VERTEX,
      fragmentShader: /* glsl */ `
        uniform sampler2D tEmissive;
        uniform sampler2D tEffectIds;
        uniform int uSlotBit;
        uniform float uThreshold;
        uniform float uSmoothing;
        varying vec2 vUv;

        // マスクは半精度に入った 2047 以下の整数。int 経由なら誤差なく取り出せる
        // （exp2/floor は一部ドライバで 1 ビットずれる）。
        float extractEffectBit(float maskValue, int bitIndex) {
          return float((int(maskValue + 0.5) >> bitIndex) & 1);
        }

        void main() {
          float mask = texture2D(tEffectIds, vUv).r;
          if (extractEffectBit(mask, uSlotBit) < 0.5) {
            gl_FragColor = vec4(0.0);
            return;
          }
          vec3 emissive = texture2D(tEmissive, vUv).rgb;
          float luma = dot(emissive, vec3(0.299, 0.587, 0.114));
          float pass = smoothstep(uThreshold, uThreshold + uSmoothing, luma);
          gl_FragColor = vec4(emissive * pass, 1.0);
        }
      `,
      depthTest: false,
      depthWrite: false,
    });
    this.extractScene.add(new Mesh(this.geometry, this.extractMaterial));

    this.compositeUniforms = {
      tBase: { value: null },
      tBloom: { value: null },
      uStrength: { value: 0 },
    };
    this.compositeMaterial = new ShaderMaterial({
      uniforms: this.compositeUniforms,
      vertexShader: FULLSCREEN_VERTEX,
      fragmentShader: /* glsl */ `
        uniform sampler2D tBase;
        uniform sampler2D tBloom;
        uniform float uStrength;
        varying vec2 vUv;

        void main() {
          vec4 base = texture2D(tBase, vUv);
          vec3 bloom = texture2D(tBloom, vUv).rgb;
          gl_FragColor = vec4(base.rgb + bloom * uStrength, base.a);
        }
      `,
      depthTest: false,
      depthWrite: false,
    });
    this.compositeScene.add(new Mesh(this.geometry, this.compositeMaterial));

    // 発光値は 1 を超える HDR なので半精度で持つ
    this.sourceRT = new WebGLRenderTarget(1, 1, {
      format: RGBAFormat,
      type: HalfFloatType,
      depthBuffer: false,
      stencilBuffer: false,
    });
    this.sourceRT.texture.name = `SmoothBloom_Source_${desc.id}`;

    this.blur.levels = desc.settings.levels;
    this.blur.radius = desc.settings.radius;
  }

  /** EffectComposer に追加されたときに呼ばれる。ミップも HDR で持たせる。 */
  override initialize(renderer: WebGLRenderer, alpha: boolean): void {
    this.blur.initialize(renderer, alpha, HalfFloatType);
  }

  private updateSizes(width: number, height: number): void {
    if (this.size.x === width && this.size.y === height) return;
    this.size.set(width, height);
    this.sourceRT.setSize(width, height);
    this.blur.setSize(width, height);
  }

  override render(
    renderer: WebGLRenderer,
    inputBuffer: WebGLRenderTarget,
    outputBuffer: WebGLRenderTarget | null,
  ): void {
    const s = this.desc.settings;
    this.updateSizes(
      Math.floor(inputBuffer.width * s.resolutionScale),
      Math.floor(inputBuffer.height * s.resolutionScale),
    );
    this.blur.levels = s.levels;
    this.blur.radius = s.radius;

    const target = this.renderToScreen ? null : outputBuffer;
    this.compositeUniforms.tBase.value = inputBuffer.texture;

    // G-buffer は必要とする効果が生きている間だけ存在する。毎フレーム取り直す。
    const emissive = this.desc.getEmissiveBuffer();
    const effectIds = this.desc.getEffectIdsBuffer();
    const slot = this.desc.getEffectSlot();
    if (!emissive || !effectIds || slot < 0) {
      this.compositeUniforms.uStrength.value = 0;
      renderer.setRenderTarget(target);
      renderer.render(this.compositeScene, this.quadCamera);
      return;
    }

    this.extractUniforms.tEmissive.value = emissive;
    this.extractUniforms.tEffectIds.value = effectIds;
    this.extractUniforms.uSlotBit.value = slot;
    this.extractUniforms.uThreshold.value = s.threshold;
    // smoothstep は edge0 == edge1 で未定義
    this.extractUniforms.uSmoothing.value = Math.max(s.smoothing, 1e-4);
    renderer.setRenderTarget(this.sourceRT);
    renderer.render(this.extractScene, this.quadCamera);

    this.blur.render(renderer, this.sourceRT, null);

    this.compositeUniforms.tBloom.value = this.blur.texture;
    this.compositeUniforms.uStrength.value = s.strength;
    renderer.setRenderTarget(target);
    renderer.render(this.compositeScene, this.quadCamera);
  }

  override dispose(): void {
    this.blur.dispose();
    this.sourceRT.dispose();
    this.geometry.dispose();
    this.extractMaterial.dispose();
    this.compositeMaterial.dispose();
  }
}

/** アプリの ThreeView に smoothBloom 記述子を登録する。`view.init()` の後に一度だけ呼ぶ。 */
export function registerSmoothBloom(view: AppView): void {
  view.registerEffect("smoothBloom", SmoothBloomEffectDesc);
}
