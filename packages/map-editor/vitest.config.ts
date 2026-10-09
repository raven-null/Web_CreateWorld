import { defineConfig } from "vitest/config";

/**
 * 测试配置（与 map-core 保持一致）。
 *
 * 使用**线程池单线程**：绘制内核是纯逻辑测试，单线程足够快，
 * 也避免在受限环境（容器 / 沙箱 / CI）中因进程 fork 被拒而失败。
 */
export default defineConfig({
  test: {
    include: ["src/**/__tests__/**/*.test.ts"],
    pool: "threads",
    poolOptions: { threads: { singleThread: true, isolate: false } },
  },
});
