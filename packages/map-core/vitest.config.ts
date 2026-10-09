import { defineConfig } from "vitest/config";

/**
 * 测试配置。
 *
 * 使用**线程池单线程**：本包只有纯函数测试，单线程足够快，
 * 也避免在受限环境（容器 / 沙箱 / CI）中因进程 fork 被拒而失败。
 */
export default defineConfig({
  test: {
    include: ["src/**/__tests__/**/*.test.ts"],
    pool: "threads",
    poolOptions: { threads: { singleThread: true, isolate: false } },
  },
});
