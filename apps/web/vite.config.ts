import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Vite 配置：
 * - 开发时把 /api 代理到本地 Worker（8787 端口），避免跨域
 * - 生产构建产物由 Worker 静态资源托管（部署阶段配置）
 *
 * 只保留单入口（主应用）。原先的多入口（+ diagnose.html）会让构建把共享代码
 * 拆成独立 chunk，入口 JS 必须再多下载一个 217KB 的 chunk 才能启动；
 * 更重要的是任何一处 chunk 加载异常都会导致整页白屏，得不偿失。
 */
export default defineConfig({
  plugins: [react()],
  // 构建时注入画布版本戳：只在每次构建时变化，使浏览器/CDN 能长期缓存画布文件
  define: {
    __CANVAS_VERSION__: JSON.stringify(new Date().toISOString().slice(0, 10) + "-" + Date.now().toString(36)),
  },
  build: {
    // 单独产出的共享 chunk 会让首屏多一次网络往返，这里明确关闭
    rollupOptions: {
      output: {
        manualChunks: undefined,
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
