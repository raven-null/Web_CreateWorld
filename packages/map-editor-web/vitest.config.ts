import { defineConfig } from "vitest/config";

/**
 * 测试配置（与 map-core / map-editor 一致）。
 *
 * 使用**线程池单线程**：避免在受限环境（容器 / 沙箱 / CI）中因进程 fork 被拒而失败。
 * 本包的测试用 fake-indexeddb 提供 IndexedDB 环境，因此不需要浏览器。
 */
export default defineConfig({
  test: {
    include: ["src/**/__tests__/**/*.test.ts"],
    pool: "threads",
    poolOptions: { threads: { singleThread: true, isolate: false } },
  },
});
