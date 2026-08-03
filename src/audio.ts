/** 気温 20°C における音速 (m/s)。 */
export const SPEED_OF_SOUND = 343;

/**
 * 花火の音を、視点までの距離に応じて遅らせて鳴らす。
 *
 * この作品の主題そのもの。光は一瞬で届くが、音は 343 m/s しか進まない。
 * 2 km 離れた対岸では、開花から約 6 秒遅れて「ドン」が届く。
 * さらに高い周波数は空気に吸収されやすいので、遠い花火の音は
 * 低くこもった音になる。その両方を再現している。
 */
export class HanabiAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private _volume = 0.7;
  private _enabled = false;
  /** 同時発音数の上限。フィナーレで音が潰れるのを防ぐ。 */
  private voices = 0;
  private static MAX_VOICES = 24;

  get enabled(): boolean {
    return this._enabled;
  }

  get volume(): number {
    return this._volume;
  }

  set volume(v: number) {
    this._volume = v;
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
    }
  }

  /** ユーザー操作の中から呼ぶ必要がある（ブラウザの自動再生制限）。 */
  async enable(): Promise<void> {
    if (this._enabled) return;
    const Ctor = window.AudioContext ?? (window as any).webkitAudioContext;
    if (!Ctor) return;
    const ctx: AudioContext = new Ctor();
    await ctx.resume();
    const master = ctx.createGain();
    master.gain.value = this._volume;
    // 全体を軽く圧縮して、連発時に耳が痛くならないようにする
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.knee.value = 12;
    comp.ratio.value = 6;
    comp.attack.value = 0.004;
    comp.release.value = 0.25;
    master.connect(comp).connect(ctx.destination);

    // ホワイトノイズを 2 秒分だけ作って使い回す
    const len = Math.floor(ctx.sampleRate * 2);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

    this.ctx = ctx;
    this.master = master;
    this.noise = buf;
    this._enabled = true;
  }

  disable() {
    this.ctx?.close();
    this.ctx = null;
    this.master = null;
    this._enabled = false;
  }

  /**
   * 開花音を予約する。
   * @param distance 視点から開花点までの距離 (m)
   * @param power 玉の大きさ（開花半径 m）。大きいほど低く重い音になる。
   * @param crackle 小割（パチパチ）を含むか
   */
  scheduleBurst(distance: number, power: number, crackle: boolean) {
    const ctx = this.ctx;
    const master = this.master;
    const noise = this.noise;
    if (!ctx || !master || !noise) return;
    if (this.voices >= HanabiAudio.MAX_VOICES) return;

    const delay = distance / SPEED_OF_SOUND;
    // あまりに遠い音は捨てる（10 km 超＝30 秒後）
    if (delay > 30) return;
    const t0 = ctx.currentTime + delay;

    // 距離減衰。点音源の逆二乗ではなく、実際の聞こえ方に近い緩い減衰にする。
    const ref = 300;
    const atten = Math.min(1, Math.pow(ref / Math.max(distance, 60), 0.9));
    // 玉が大きいほど音圧が高い
    const size = Math.min(1.6, power / 90);
    const gain = 0.9 * atten * size;
    if (gain < 0.004) return;

    this.voices++;
    const release = () => {
      this.voices = Math.max(0, this.voices - 1);
    };

    // --- 胴体：低い「ドン」。距離が遠いほど低く、長く伸びる ---
    const bodyLen = 0.45 + Math.min(1.6, distance / 1400);
    const osc = ctx.createOscillator();
    osc.type = "sine";
    const f0 = 130 - Math.min(70, distance / 45) + size * 18;
    osc.frequency.setValueAtTime(f0, t0);
    osc.frequency.exponentialRampToValueAtTime(Math.max(24, f0 * 0.35), t0 + bodyLen);

    const bodyGain = ctx.createGain();
    bodyGain.gain.setValueAtTime(0, t0);
    bodyGain.gain.linearRampToValueAtTime(gain, t0 + 0.008);
    bodyGain.gain.exponentialRampToValueAtTime(0.0008, t0 + bodyLen);
    osc.connect(bodyGain).connect(master);
    osc.start(t0);
    osc.stop(t0 + bodyLen + 0.05);
    osc.onended = release;

    // --- 破裂音：ノイズを距離に応じてローパスする ---
    // 高域は空気に吸収されるため、遠いほどこもる。これが距離感の正体。
    const cutoff = Math.max(180, 5200 * Math.exp(-distance / 1600));
    const src = ctx.createBufferSource();
    src.buffer = noise;
    src.playbackRate.value = 0.85 + Math.random() * 0.3;

    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = cutoff;
    lp.Q.value = 0.8;

    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 60;

    const crackLen = 0.16 + Math.min(0.9, distance / 2600);
    const nGain = ctx.createGain();
    nGain.gain.setValueAtTime(0, t0);
    nGain.gain.linearRampToValueAtTime(gain * 0.75, t0 + 0.006);
    nGain.gain.exponentialRampToValueAtTime(0.0008, t0 + crackLen);

    src.connect(hp).connect(lp).connect(nGain).connect(master);
    src.start(t0, Math.random() * 1.5, crackLen + 0.05);

    // --- 小割（パチパチ）：高域なので近くでしか聞こえない ---
    if (crackle && distance < 2600) {
      const cGain = ctx.createGain();
      const cSrc = ctx.createBufferSource();
      cSrc.buffer = noise;
      cSrc.playbackRate.value = 1.6;
      const cBp = ctx.createBiquadFilter();
      cBp.type = "bandpass";
      cBp.frequency.value = Math.max(700, 3600 * Math.exp(-distance / 1100));
      cBp.Q.value = 1.4;
      const cAmt = gain * 0.5 * Math.exp(-distance / 1500);
      cGain.gain.setValueAtTime(0, t0 + 0.05);
      cGain.gain.linearRampToValueAtTime(cAmt, t0 + 0.12);
      cGain.gain.exponentialRampToValueAtTime(0.0006, t0 + 1.5);
      cSrc.connect(cBp).connect(cGain).connect(master);
      cSrc.start(t0 + 0.05, Math.random() * 0.4, 1.6);
    }
  }

  /**
   * 打ち上げの音。近い視点でしか聞こえない。
   *
   * 以前は正弦波を上昇スイープさせていたが、それは花火ではなく
   * サイレンの音だった。実際に聞こえるのは
   *   1. 打ち上げ筒の発射音「ドン」（低くて短い衝撃音）
   *   2. 上昇中のかすかな「シュー」（無音程のノイズ）
   * の 2 つで、どちらも音程を持たない。
   *
   * @param distance 視点から打ち上げ地点までの距離 (m)
   * @param riseTime 開花までの上昇時間 (s)。シューの長さに使う。
   */
  scheduleLaunch(distance: number, riseTime: number) {
    const ctx = this.ctx;
    const master = this.master;
    const noise = this.noise;
    if (!ctx || !master || !noise) return;
    // 発射音は開花音より小さいので、近くでしか聞こえない
    if (distance > 1400) return;
    if (this.voices >= HanabiAudio.MAX_VOICES) return;

    const t0 = ctx.currentTime + distance / SPEED_OF_SOUND;
    const atten = Math.min(1, Math.pow(260 / Math.max(distance, 60), 0.9));

    // --- 1. 発射音：筒から打ち出される低い「ドン」 ---
    const thumpGain = 0.34 * atten;
    if (thumpGain > 0.004) {
      const src = ctx.createBufferSource();
      src.buffer = noise;
      src.playbackRate.value = 0.6;
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      // 距離が遠いほど高域が削れる（開花音と同じ理屈）
      lp.frequency.value = Math.max(120, 900 * Math.exp(-distance / 1200));
      lp.Q.value = 0.7;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(thumpGain, t0 + 0.006);
      g.gain.exponentialRampToValueAtTime(0.0008, t0 + 0.22);
      src.connect(lp).connect(g).connect(master);
      src.start(t0, Math.random() * 1.5, 0.3);

      // 筒の胴鳴り。40〜70 Hz の短い正弦。音程としては認識されない帯域。
      const body = ctx.createOscillator();
      body.type = "sine";
      body.frequency.setValueAtTime(78, t0);
      body.frequency.exponentialRampToValueAtTime(42, t0 + 0.18);
      const bg = ctx.createGain();
      bg.gain.setValueAtTime(0, t0);
      bg.gain.linearRampToValueAtTime(thumpGain * 0.8, t0 + 0.008);
      bg.gain.exponentialRampToValueAtTime(0.0008, t0 + 0.2);
      body.connect(bg).connect(master);
      body.start(t0);
      body.stop(t0 + 0.25);
    }

    // --- 2. 上昇音：無音程の「シュー」。開花に向かって細く消えていく ---
    // 300 m より遠いと聞き取れないので鳴らさない。
    if (distance > 320) return;
    const hissGain = 0.05 * Math.min(1, 160 / Math.max(distance, 50));
    if (hissGain < 0.003) return;
    const dur = Math.max(1.2, Math.min(8, riseTime));
    const hiss = ctx.createBufferSource();
    hiss.buffer = noise;
    hiss.loop = true;
    hiss.playbackRate.value = 1.1;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.Q.value = 0.9;
    // 遠ざかるにつれて音が細くなる（上へ離れていくため）
    bp.frequency.setValueAtTime(1500, t0);
    bp.frequency.linearRampToValueAtTime(900, t0 + dur);
    const hg = ctx.createGain();
    hg.gain.setValueAtTime(0, t0);
    hg.gain.linearRampToValueAtTime(hissGain, t0 + 0.15);
    hg.gain.linearRampToValueAtTime(hissGain * 0.25, t0 + dur * 0.75);
    hg.gain.linearRampToValueAtTime(0, t0 + dur);
    hiss.connect(bp).connect(hg).connect(master);
    hiss.start(t0, Math.random() * 1.5);
    hiss.stop(t0 + dur + 0.05);
  }
}
