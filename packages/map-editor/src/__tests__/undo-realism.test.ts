/**
 * 撤销 / 重做的**真实场景**回归测试。
 *
 * 用户反馈「撤销后画面畸形、色块飘到别处」，因此这里不再只测单个矩形，
 * 而是在真实白板尺寸（2048×1024）上模拟完整的绘制 → 撤销 → 重做流程，
 * 逐像素断言「内容要么在该在的位置，要么不存在」，不允许出现在别处。
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_TERRAIN_PALETTE, type MapHostAdapter } from "@worldmap/core";
import { createHistoryBaseline, HistoryStack, type RectReader } from "../history";
import { brushRect, paintRect, interpolatePointerPath } from "../brush-engine";
import { RasterTileStore, type PixelRect } from "../tile-store";

/** 真实白板尺寸（方案默认 2048×1024） */
const BOARD_WIDTH = 2048;
const BOARD_HEIGHT = 1024;

/** 内存宿主（全空瓦片） */
function createAdapter(): MapHostAdapter {
  return {
    async loadMeta() {
      throw new Error("本测试不使用");
    },
    async loadTiles(_m, _l, coords) {
      void coords;
      return coords.map(() => null);
    },
    async saveTiles(input) {
      return { revision: input.revision + 1 };
    },
  };
}

async function makeStore(): Promise<RasterTileStore> {
  const store = new RasterTileStore({
    adapter: createAdapter(),
    mapId: "m1",
    layerId: "terrain",
    width: BOARD_WIDTH,
    height: BOARD_HEIGHT,
    palette: DEFAULT_TERRAIN_PALETTE,
  });
  await store.load();
  return store;
}

/** 与 MapEditor 完全一致的「一次完整拖动」：pointerdown → 多个补点 → pointerup */
function fullDrag(
  store: RasterTileStore,
  history: HistoryStack,
  from: { x: number; y: number },
  to: { x: number; y: number },
  terrainIndex: number,
  screenSize = 12,
): void {
  const reader: RectReader = (target) => store.readRect(target);
  const zoom = 1; // 简化：1 像素屏幕 = 1 像素世界
  // 与真实实现一致：先冻结基线，再落笔
  history.begin("笔刷", createHistoryBaseline(store.width, store.height, reader));
  const points = [{ x: from.x, y: from.y }, ...interpolatePointerPath(from, to, Math.max(1, screenSize / 2))];
  for (const point of points) {
    const rect = brushRect(point.x, point.y, screenSize, zoom, store.width, store.height);
    if (!rect) {
      continue;
    }
    history.record("terrain", rect);
    paintRect(store.indices, store.width, rect, terrainIndex);
  }
  history.commit(reader);
}

/** 撤销一步（与 MapEditor.undo 相同的写入） */
function applyUndo(store: RasterTileStore, history: HistoryStack): void {
  const entry = history.peekUndo();
  if (!entry) {
    throw new Error("没有可撤销的步骤");
  }
  store.writeRect(entry.rect, entry.before);
  history.confirmUndo();
}

/** 重做一步（与 MapEditor.redo 相同的写入） */
function applyRedo(store: RasterTileStore, history: HistoryStack): void {
  const entry = history.peekRedo();
  if (!entry) {
    throw new Error("没有可重做的步骤");
  }
  store.writeRect(entry.rect, entry.after);
  history.confirmRedo();
}

/** 逐像素比较两份栅格，返回第一处差异（便于定位错位） */
function firstDifference(
  actual: Uint8Array,
  expected: Uint8Array,
  width: number,
): { index: number; x: number; y: number; actual: number; expected: number } | null {
  for (let index = 0; index < expected.length; index += 1) {
    if (actual[index] !== expected[index]) {
      return {
        index,
        x: index % width,
        y: Math.floor(index / width),
        actual: actual[index] ?? 0,
        expected: expected[index] ?? 0,
      };
    }
  }
  return null;
}

/** 统计栅格中非 0 像素的个数（用于确认「东西都回来了」） */
function countPainted(data: Uint8Array): number {
  let total = 0;
  for (const value of data) {
    if (value !== 0) {
      total += 1;
    }
  }
  return total;
}

describe("撤销 / 重做在真实白板上的表现", () => {
  it("两笔分开的色块：撤销第二笔后，第一笔原地不动、第二笔彻底消失", async () => {
    const store = await makeStore();
    const history = new HistoryStack();

    // 第一笔：右上区域
    fullDrag(store, history, { x: 1600, y: 200 }, { x: 1700, y: 260 }, 5);
    const afterFirst = new Uint8Array(store.indices);
    expect(countPainted(afterFirst)).toBeGreaterThan(0);

    // 第二笔：左下区域（完全不相邻）
    fullDrag(store, history, { x: 200, y: 800 }, { x: 300, y: 860 }, 9);
    const afterSecond = new Uint8Array(store.indices);
    expect(countPainted(afterSecond)).toBeGreaterThan(countPainted(afterFirst));

    // 撤销第二笔
    applyUndo(store, history);
    const diff = firstDifference(store.indices, afterFirst, store.width);
    expect(diff).toBeNull();

    // 重做第二笔
    applyRedo(store, history);
    expect(firstDifference(store.indices, afterSecond, store.width)).toBeNull();
  });

  it("跨越 256 网格边界的长笔画：撤销后不留残影，也不用把别处抹掉", async () => {
    const store = await makeStore();
    const history = new HistoryStack();
    const blank = new Uint8Array(store.indices);

    // 从 x=200 拖到 x=900（跨 2 个网格块），y 也跨过 256 边界
    fullDrag(store, history, { x: 200, y: 240 }, { x: 900, y: 300 }, 6, 20);

    applyUndo(store, history);
    const diff = firstDifference(store.indices, blank, store.width);
    // 撤销后整块白板必须干净：既不能留残影，也不能把别处涂上
    expect(diff).toBeNull();
  });

  it("连续三笔 + 逐次撤销：每一步都与历史快照逐字节一致", async () => {
    const store = await makeStore();
    const history = new HistoryStack();

    const snapshots: Uint8Array[] = [new Uint8Array(store.indices)];
    fullDrag(store, history, { x: 100, y: 100 }, { x: 200, y: 150 }, 3);
    snapshots.push(new Uint8Array(store.indices));
    fullDrag(store, history, { x: 500, y: 400 }, { x: 640, y: 520 }, 7);
    snapshots.push(new Uint8Array(store.indices));
    fullDrag(store, history, { x: 1000, y: 700 }, { x: 1100, y: 760 }, 11);
    snapshots.push(new Uint8Array(store.indices));

    // 逐次撤销，每次都要求与对应快照完全一致
    for (let step = 3; step >= 1; step -= 1) {
      applyUndo(store, history);
      const diff = firstDifference(store.indices, snapshots[step - 1] as Uint8Array, store.width);
      expect(diff, `第 ${step} 次撤销后出现差异`).toBeNull();
    }

    // 再逐次重做，回到终点
    for (let step = 1; step <= 3; step += 1) {
      applyRedo(store, history);
    }
    expect(firstDifference(store.indices, snapshots[3] as Uint8Array, store.width)).toBeNull();
  });

  it("撤销记录的矩形必须覆盖整条笔画（否则会出现「擦不干净」）", async () => {
    const store = await makeStore();
    const history = new HistoryStack();

    const from = { x: 300, y: 300 };
    const to = { x: 1200, y: 900 };
    fullDrag(store, history, from, to, 8, 24);

    const entry = history.peekUndo();
    const rect = entry?.rect as PixelRect;
    // 笔画两端都在记录范围内
    expect(rect.x).toBeLessThanOrEqual(from.x);
    expect(rect.y).toBeLessThanOrEqual(from.y);
    expect(rect.x + rect.width).toBeGreaterThanOrEqual(to.x);
    expect(rect.y + rect.height).toBeGreaterThanOrEqual(to.y);

    // 撤销之后，记录矩形内不允许有非 0 残留
    applyUndo(store, history);
    const painted = countPainted(store.indices);
    expect(painted).toBe(0);
  });
});
