/**
 * 撤销 / 重做的数据流回归测试。
 *
 * 针对用户反馈的「点撤销没反应」「点重做把画面清空」编写：
 * 一次拖动会产生几十个落点，历史必须按**整条笔画**记录，
 * 只记最后一个落点会导致撤销 / 重做只回退笔画的末尾（看起来像没生效或清空）。
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_TERRAIN_PALETTE, type MapHostAdapter } from "@worldmap/core";
import { HistoryStack, type RectReader } from "../history";
import { paintRect } from "../brush-engine";
import { RasterTileStore, type PixelRect } from "../tile-store";

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

/** 建一个 512×256 的空白仓库 */
async function makeStore(): Promise<RasterTileStore> {
  const store = new RasterTileStore({
    adapter: createAdapter(),
    mapId: "m1",
    layerId: "terrain",
    width: 512,
    height: 256,
    palette: DEFAULT_TERRAIN_PALETTE,
  });
  await store.load();
  return store;
}

/** 一个覆盖指定矩形的单笔（模拟 pointerdown → pointerup） */
function stroke(store: RasterTileStore, history: HistoryStack, rect: PixelRect, value: number): void {
  const reader: RectReader = (target) => store.readRect(target);
  history.begin(value === 0 ? "橡皮" : "笔刷");
  history.record("terrain", rect, reader);
  paintRect(store.indices, store.width, rect, value);
  store.markDirty(rect);
  history.commit(reader);
}

/** 一条由多个落点组成的拖动笔画（模拟 pointermove 的补点） */
function dragStroke(
  store: RasterTileStore,
  history: HistoryStack,
  rects: PixelRect[],
  value: number,
): void {
  const reader: RectReader = (target) => store.readRect(target);
  history.begin("笔刷");
  for (const rect of rects) {
    history.record("terrain", rect, reader);
    paintRect(store.indices, store.width, rect, value);
    store.markDirty(rect);
  }
  history.commit(reader);
}

/** 撤销一步 */
function applyUndo(store: RasterTileStore, history: HistoryStack): boolean {
  const entry = history.peekUndo();
  if (!entry) {
    return false;
  }
  store.writeRect(entry.rect, entry.before);
  history.confirmUndo();
  return true;
}

/** 重做一步 */
function applyRedo(store: RasterTileStore, history: HistoryStack): boolean {
  const entry = history.peekRedo();
  if (!entry) {
    return false;
  }
  store.writeRect(entry.rect, entry.after);
  history.confirmRedo();
  return true;
}

describe("撤销 / 重做的数据流", () => {
  it("一次笔画的撤销与重做都能逐字节还原", async () => {
    const store = await makeStore();
    const history = new HistoryStack();
    const initial = new Uint8Array(store.indices);

    const rect = { x: 100, y: 100, width: 20, height: 20 };
    stroke(store, history, rect, 4);

    expect(store.readRect(rect)[0]).toBe(4);
    expect(history.undoCount).toBe(1);

    expect(applyUndo(store, history)).toBe(true);
    expect(Array.from(store.indices)).toEqual(Array.from(initial));

    expect(applyRedo(store, history)).toBe(true);
    const restored = new Uint8Array(initial);
    paintRect(restored, store.width, rect, 4);
    // 关键断言：重做后内容必须完整回来，而不是被清空
    expect(Array.from(store.indices)).toEqual(Array.from(restored));
  });

  it("一次拖动（多个落点）只记一步，撤销能还原整条笔画", async () => {
    const store = await makeStore();
    const history = new HistoryStack();
    const initial = new Uint8Array(store.indices);

    // 模拟从 x=50 拖到 x=250 的一条横线
    const rects: PixelRect[] = [];
    for (let i = 0; i < 21; i += 1) {
      rects.push({ x: 50 + i * 10, y: 50, width: 6, height: 6 });
    }
    dragStroke(store, history, rects, 6);

    // 只产生一步
    expect(history.undoCount).toBe(1);
    const entry = history.peekUndo();
    // 历史矩形必须覆盖整条笔画，而不是最后一小段
    const left = Math.min(...rects.map((rect) => rect.x));
    const right = Math.max(...rects.map((rect) => rect.x + rect.width));
    expect(entry?.rect.x).toBe(left);
    expect((entry?.rect.x ?? 0) + (entry?.rect.width ?? 0)).toBe(right);
    expect(entry?.rect.width).toBe(right - left);

    // 撤销一次：整条笔画消失
    expect(applyUndo(store, history)).toBe(true);
    expect(Array.from(store.indices)).toEqual(Array.from(initial));

    // 重做一次：整条笔画回来
    expect(applyRedo(store, history)).toBe(true);
    const expected = new Uint8Array(initial);
    for (const rect of rects) {
      paintRect(expected, store.width, rect, 6);
    }
    expect(Array.from(store.indices)).toEqual(Array.from(expected));
  });

  it("多笔之后逐次撤销再逐次重做，内容始终一致", async () => {
    const store = await makeStore();
    const history = new HistoryStack();

    const rects = [
      { x: 10, y: 10, width: 8, height: 8 },
      { x: 40, y: 20, width: 8, height: 8 },
      { x: 80, y: 60, width: 8, height: 8 },
    ];
    rects.forEach((rect, index) => stroke(store, history, rect, index + 1));

    const final = new Uint8Array(store.indices);
    expect(history.undoCount).toBe(3);

    for (let i = 0; i < 3; i += 1) {
      expect(applyUndo(store, history)).toBe(true);
    }
    expect(store.indices.every((value) => value === 0)).toBe(true);

    for (let i = 0; i < 3; i += 1) {
      expect(applyRedo(store, history)).toBe(true);
    }
    expect(Array.from(store.indices)).toEqual(Array.from(final));
  });

  it("擦除笔画撤销后能恢复原来的地形", async () => {
    const store = await makeStore();
    const history = new HistoryStack();

    const area = { x: 20, y: 20, width: 40, height: 40 };
    stroke(store, history, area, 7);
    const painted = new Uint8Array(store.indices);

    // 擦掉其中一块（多个落点，模拟拖动擦除）
    const erased: PixelRect[] = [
      { x: 24, y: 24, width: 8, height: 8 },
      { x: 34, y: 24, width: 8, height: 8 },
      { x: 44, y: 24, width: 8, height: 8 },
    ];
    dragStroke(store, history, erased, 0);
    expect(store.readRect({ x: 24, y: 24, width: 1, height: 1 })[0]).toBe(0);

    // 撤销擦除：地形回来
    expect(applyUndo(store, history)).toBe(true);
    expect(Array.from(store.indices)).toEqual(Array.from(painted));
  });

  it("记录过一次落笔就是一步；没有落点记录时不入栈", async () => {
    const store = await makeStore();
    const history = new HistoryStack();
    const reader: RectReader = (target) => store.readRect(target);

    // 用户确实落了一笔（即使内容与改动前相同），也保留为一步：
    // 静默丢弃会让「画一笔 → 撤销」看起来像撤销了别的东西
    history.begin("橡皮");
    history.record("terrain", { x: 0, y: 0, width: 4, height: 4 }, reader);
    history.commit(reader);
    expect(history.undoCount).toBe(1);

    // 没调用过 record 就 commit（例如落笔在画布外）：不入栈
    const other = new HistoryStack();
    other.begin("笔刷");
    other.commit(reader);
    expect(other.undoCount).toBe(0);
  });

  it("脏矩形会被累积，供渲染层局部重烘", async () => {
    const store = await makeStore();
    store.takeDirtyRect();

    const a = { x: 10, y: 10, width: 4, height: 4 };
    const b = { x: 40, y: 30, width: 4, height: 4 };
    store.markDirty(a);
    store.markDirty(b);

    const bounds = store.takeDirtyRect();
    expect(bounds).not.toBeNull();
    expect(bounds?.x).toBe(10);
    expect(bounds?.y).toBe(10);
    expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeGreaterThanOrEqual(44);
    expect((bounds?.y ?? 0) + (bounds?.height ?? 0)).toBeGreaterThanOrEqual(34);
    expect(store.takeDirtyRect()).toBeNull();
  });
});
