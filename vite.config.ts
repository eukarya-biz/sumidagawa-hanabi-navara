import { defineConfig } from "vite";

export default defineConfig({
  // GitHub Pages はリポジトリ名のサブパス（/repo-name/）で配信されるため、
  // 相対パスにしておくとリポジトリ名に依存せずそのまま動く。
  base: "./",
  server: { port: 8080 },
  build: {
    // Navara の WASM が大きいので警告の閾値を上げておく
    chunkSizeWarningLimit: 9000,
  },
});
