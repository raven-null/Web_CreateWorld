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
    /**
     * 关闭模块预加载：Vite 会为所有懒加载 chunk 的静态依赖插 <link rel=modulepreload>，
     * 结果首屏就把 404KB 的富文本编辑器（vendor-editor）预下载了——打开首页根本用不到，
     * 在跨境网络下这一下就是一两秒。关掉后首屏只下载真正执行的那几个 chunk，
     * 懒加载页面在切换时按需拉取自己的依赖。
     */
    modulePreload: false,
    rollupOptions: {
      output: {
        /**
         * 排除「重依赖」：这些库只被懒加载页面使用，绝不该出现在首屏。
         *
         * 之前用 manualChunks 手工分组反而更糟——构建器会把分组后的 chunk 静态塞进入口，
         * 导致打开首页也要下载 395KB 的富文本编辑器；官方推荐的 exclude 语义正好相反：
         * 「这些包不要合并进主图，让动态导入页面各自引用」。
         */
        exclude: [
          // 富文本编辑器（条目编辑页）
          "@tiptap/core",
          "@tiptap/react",
          "@tiptap/pm",
          "@tiptap/starter-kit",
          // 地图编辑器（地图页）
          "@worldmap/core",
          "@worldmap/editor",
          "@worldmap/editor-web",
          // 地图库（地图页）
          "leaflet",
        ],
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
