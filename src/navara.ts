import type ThreeView from "@navaramap/three";
import type {
  DefaultEffectDescription,
  DefaultLightDescription,
  DefaultMeshDescription,
} from "@navaramap/three-default-plugin";
import type { SmoothBloomEffectConfig } from "./smoothBloom";

/**
 * このアプリで使う記述子の型。DefaultPlugin の記述子に、アプリ側で
 * `registerEffect` するカスタム記述子を足す。これで `addEffect` が
 * キャスト無しで型チェックされる。
 */
export type AppDescriptions = {
  mesh: DefaultMeshDescription;
  light: DefaultLightDescription;
  effect: DefaultEffectDescription | SmoothBloomEffectConfig;
};

export type AppView = ThreeView<AppDescriptions>;
