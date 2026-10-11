import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

/**
 * Vite 配置：
 * - 开发时把 /api 代理到本地 Worker（8787 端口），避免跨域
 * - 生产构建产物由 Worker 静态资源托管（部署阶段配置）
 * - 多页入口：主应用 + WebGL 诊断页（排查「不支持 3D 地球仪」用）
 */
export default defineConfig({
  plugins: [react()],
  // 构建时注入画布版本戳：画布 iframe 用它规避 CDN 缓存（每次构建都不同）
  define: {
    __CANVAS_VERSION__: JSON.stringify(Date.now().toString(36)),
  },
  // 显式声明多页入口：Vite 默认只构建 index.html，
  // 不声明的话 diagnose.html 在开发时能打开、生产构建却不会产出
  build: {
    rollupOptions: {
      input: {
        index: fileURLToPath(new URL("./index.html", import.meta.url)),
        diagnose: fileURLToPath(new URL("./diagnose.html", import.meta.url)),
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:8787",
        changeOrigin: true,
      },
    },
  },
});
