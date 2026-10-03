import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Vite 配置：
 * - 开发时把 /api 代理到本地 Worker（8787 端口），避免跨域
 * - 生产构建产物由 Worker 静态资源托管（部署阶段配置）
 */
export default defineConfig({
  plugins: [react()],
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
