import { cp } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { defineConfig, type Plugin, type ResolvedConfig } from "vite";

/**
 * Navara のランタイムアセットをビルド成果物にコピーするプラグイン。
 *
 * `@navaramap/three` は大気散乱の事前計算テクスチャ、雲のノイズボリューム、
 * 水面の法線マップなどを `new URL("./assets/atmosphere", import.meta.url)`
 * のかたちで参照している。
 *
 * この書き方は Vite のビルド時に解決されず、そのまま実行時に評価される
 * （ビルド時に「doesn't exist at build time, it will remain unchanged to be
 * resolved at runtime」と警告が出る）。
 *
 * - `vite dev` では import.meta.url が node_modules 内を指すのでファイルが見つかる
 * - ビルド後は import.meta.url がバンドル済み JS（dist/assets/index-xxx.js）を
 *   指すため、`dist/assets/assets/atmosphere/...` を探しに行く
 *
 * その場所にファイルがないと**大気散乱が読み込めず、空が真っ暗になる**。
 * ローカルでは夕暮れが見えるのに GitHub Pages では見えない、という
 * 症状の原因がこれだった。
 *
 * そこでビルド後に、パッケージのアセットを実行時が期待する場所へコピーする。
 */
function copyNavaraAssets(): Plugin {
  let resolved: ResolvedConfig;
  return {
    name: "copy-navara-runtime-assets",
    apply: "build",
    configResolved(config) {
      resolved = config;
    },
    async closeBundle() {
      const from = path.resolve(
        resolved.root,
        "node_modules/@navaramap/three/dist/assets",
      );
      if (!existsSync(from)) {
        this.warn(`Navara のアセットが見つかりません: ${from}`);
        return;
      }
      // 実行時は「バンドル JS のあるディレクトリ + /assets」を見に行く
      const to = path.resolve(
        resolved.root,
        resolved.build.outDir,
        resolved.build.assetsDir,
        "assets",
      );
      // 大気・雲・ノイズ・水面など、ディレクトリになっているものだけを運ぶ
      // （JS や wasm は Vite が別途バンドルするのでコピー不要）
      const { readdir } = await import("node:fs/promises");
      const entries = await readdir(from, { withFileTypes: true });
      const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
      for (const dir of dirs) {
        await cp(path.join(from, dir), path.join(to, dir), { recursive: true });
      }
      this.info(`Navara のアセットをコピーしました: ${dirs.join(", ")}`);
    },
  };
}

export default defineConfig({
  // GitHub Pages はリポジトリ名のサブパス（/repo-name/）で配信されるため、
  // 相対パスにしておくとリポジトリ名に依存せずそのまま動く。
  base: "./",
  server: { port: 8080 },
  plugins: [copyNavaraAssets()],
  build: {
    // Navara の WASM が大きいので警告の閾値を上げておく
    chunkSizeWarningLimit: 9000,
  },
});
