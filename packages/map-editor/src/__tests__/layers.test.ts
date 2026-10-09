/**
 * 图层门面测试：多图层的增删改排序、显隐、脏瓦片汇总与跨图层读写。
 *
 * 这些是「图层是数据不是代码」这条设计的落地保证：
 * 用户自建图层、调顺序、显隐都不该影响已画内容。
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_TERRAIN_PALETTE, type MapHostAdapter, type MapLayer, type Tile } from "@worldmap/core";
import { MapLayerStore } from "../layer-store";

/** 内存宿主：支持保存图层配置与瓦片 */
function createAdapter(initialLayers: MapLayer[]): {
  adapter: MapHostAdapter;
  savedLayers: MapLayer[][];
  savedTiles: { layerId: string; count: number }[];
} {
  const savedLayers: MapLayer[][] = [];
  const savedTiles: { layerId: string; count: number }[] = [];

  const adapter: MapHostAdapter = {
    async loadMeta() {
      throw new Error("本测试不使用");
    },
    async loadTiles(_mapId, _layerId, coords) {
      // 全部返回空瓦片（缺失即空）
      void coords;
      return coords.map(() => null);
    },
    async saveTiles(input) {
      savedTiles.push({ layerId: input.layerId, count: input.tiles.length });
      return { revision: input.revision + 1 };
    },
    async saveLayers(input) {
      savedLayers.push(input.layers.map((layer) => ({ ...layer })));
    },
  };
  void initialLayers;
  return { adapter, savedLayers, savedTiles };
}

/** 造一个图层 */
function makeLayer(id: string, name: string, zIndex: number, storage: MapLayer["storage"] = "raster"): MapLayer {
  return {
    id,
    name,
    type: "terrain",
    storage,
    visible: true,
    opacity: 1,
    zIndex,
    legend: [],
  };
}

/** 搭建门面 */
async function setup(layers: MapLayer[]): Promise<{
  store: MapLayerStore;
  savedLayers: MapLayer[][];
}> {
  const { adapter, savedLayers } = createAdapter(layers);
  const store = new MapLayerStore({
    adapter,
    mapId: "m1",
    width: 512,
    height: 256,
    layers,
    revision: 0,
    palette: DEFAULT_TERRAIN_PALETTE,
  });
  await store.load();
  return { store, savedLayers };
}

describe("加载与查询", () => {
  it("载入后按 zIndex 升序排列，且每个栅格图层都有数据仓库", async () => {
    const { store } = await setup([
      makeLayer("top", "政治", 2),
      makeLayer("base", "地形", 0),
      makeLayer("mid", "宗教", 1),
    ]);

    expect(store.layers.map((layer) => layer.id)).toEqual(["base", "mid", "top"]);
    expect(store.rasterLayers()).toHaveLength(3);
    expect(store.storeOf("base")).not.toBeNull();
    expect(store.storeOf("missing")).toBeNull();
  });

  it("可见图层按顺序返回，隐藏的被排除", async () => {
    const { store } = await setup([makeLayer("base", "地形", 0), makeLayer("top", "政治", 1)]);
    await store.updateLayer("base", { visible: false });

    const visible = store.visibleRasterLayers();
    expect(visible.map((layer) => layer.id)).toEqual(["top"]);
  });

  it("矢量图层不参与栅格渲染", async () => {
    const { store } = await setup([
      makeLayer("base", "地形", 0),
      makeLayer("labels", "注记", 1, "vector"),
    ]);
    expect(store.visibleRasterLayers().map((layer) => layer.id)).toEqual(["base"]);
  });
});

describe("增删改排序", () => {
  it("新增图层：zIndex 位于最上层，且立即可绘制（有仓库）", async () => {
    const { store, savedLayers } = await setup([makeLayer("base", "地形", 0)]);
    const layer = await store.addLayer({ name: "外交", type: "custom" });

    expect(layer.zIndex).toBe(1);
    expect(layer.name).toBe("外交");
    expect(store.rasterLayers()).toHaveLength(2);
    expect(store.storeOf(layer.id)).not.toBeNull();
    // 图层配置已回写宿主
    expect(savedLayers.at(-1)?.map((item) => item.name)).toContain("外交");
  });

  it("改名 / 显隐 / 透明度都会回写宿主", async () => {
    const { store, savedLayers } = await setup([makeLayer("base", "地形", 0)]);
    await store.updateLayer("base", { name: "地形底图", visible: false, opacity: 0.5 });

    const layer = store.layers.find((item) => item.id === "base");
    expect(layer?.name).toBe("地形底图");
    expect(layer?.visible).toBe(false);
    expect(layer?.opacity).toBe(0.5);
    expect(savedLayers.length).toBeGreaterThan(0);
  });

  it("重排：按传入顺序从底到顶重设 zIndex", async () => {
    const { store } = await setup([
      makeLayer("a", "甲", 0),
      makeLayer("b", "乙", 1),
      makeLayer("c", "丙", 2),
    ]);
    await store.reorder(["c", "a", "b"]);

    expect(store.layers.map((layer) => layer.id)).toEqual(["c", "a", "b"]);
    expect(store.layers.map((layer) => layer.zIndex)).toEqual([0, 1, 2]);
  });

  it("删除图层会同时丢弃它的仓库", async () => {
    const { store } = await setup([makeLayer("a", "甲", 0), makeLayer("b", "乙", 1)]);
    expect(await store.removeLayer("b")).toBe(true);
    expect(store.layers).toHaveLength(1);
    expect(store.storeOf("b")).toBeNull();

    // 不存在的图层返回 false
    expect(await store.removeLayer("missing")).toBe(false);
  });

  it("宿主未实现 saveLayers 时仍可操作（退化为仅内存）", async () => {
    const bare: MapHostAdapter = {
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
    const store = new MapLayerStore({
      adapter: bare,
      mapId: "m1",
      width: 512,
      height: 256,
      layers: [makeLayer("a", "甲", 0)],
      revision: 0,
    });
    await store.load();
    const layer = await store.addLayer({ name: "乙", type: "custom" });
    expect(layer.name).toBe("乙");
    expect(store.layers).toHaveLength(2);
  });
});

describe("栅格读写与脏瓦片", () => {
  it("写入某图层后只该图层变脏", async () => {
    const { store } = await setup([makeLayer("a", "甲", 0), makeLayer("b", "乙", 1)]);
    const storeA = store.storeOf("a");
    const storeB = store.storeOf("b");
    expect(storeA).not.toBeNull();
    expect(storeB).not.toBeNull();

    storeA?.indices.fill(3, 0, 10);
    store.markDirty("a", { x: 0, y: 0, width: 10, height: 1 });

    expect(store.dirtyLayerIds()).toEqual(["a"]);
    expect(store.totalDirtyCount()).toBeGreaterThan(0);
    expect(storeB?.dirtyCount).toBe(0);
  });

  it("按图层汇总待保存瓦片", async () => {
    const { store } = await setup([makeLayer("a", "甲", 0), makeLayer("b", "乙", 1)]);
    store.storeOf("a")?.indices.fill(3, 0, 10);
    store.markDirty("a", { x: 0, y: 0, width: 10, height: 1 });
    store.storeOf("b")?.indices.fill(5, 300, 310);
    store.markDirty("b", { x: 300, y: 0, width: 10, height: 1 });

    const groups = await store.takeAllDirtyTiles();
    expect(groups.map((group) => group.layerId).sort()).toEqual(["a", "b"]);
    for (const group of groups) {
      expect(group.tiles.length).toBeGreaterThan(0);
    }
  });

  it("跨图层读写矩形（撤销回到原图层）", async () => {
    const { store } = await setup([makeLayer("a", "甲", 0), makeLayer("b", "乙", 1)]);
    const rect = { x: 2, y: 2, width: 2, height: 2 };

    // 在 b 层写，再从 a 层读：应仍是空的（互不干扰）
    const beforeB = store.readRect("b", rect);
    expect(beforeB).not.toBeNull();
    if (!beforeB) {
      return;
    }
    store.writeRect("b", rect, new Uint8Array([9, 9, 9, 9]));
    expect(Array.from(store.readRect("b", rect) ?? [])).toEqual([9, 9, 9, 9]);
    expect(Array.from(store.readRect("a", rect) ?? [])).toEqual(Array.from(beforeB));

    // 回滚 b
    store.writeRect("b", rect, beforeB);
    expect(Array.from(store.readRect("b", rect) ?? [])).toEqual(Array.from(beforeB));
  });

  it("吸管自上而下取第一个非透明值（吸到用户看到的那层）", async () => {
    const { store } = await setup([makeLayer("base", "地形", 0), makeLayer("top", "政治", 1)]);
    const baseStore = store.storeOf("base");
    const topStore = store.storeOf("top");
    expect(baseStore).not.toBeNull();
    expect(topStore).not.toBeNull();
    if (!baseStore || !topStore) {
      return;
    }
    baseStore.indices.fill(3, 0, 100);
    topStore.indices.fill(0, 0, 100);
    topStore.indices[5] = 5;

    expect(store.sampleTopDown(5, 0)).toBe(5); // 上层有值
    expect(store.sampleTopDown(10, 0)).toBe(3); // 上层透明 → 落到下层
  });

  it("隐藏的图层不参与吸管取样", async () => {
    const { store } = await setup([makeLayer("base", "地形", 0), makeLayer("top", "政治", 1)]);
    const baseStore = store.storeOf("base");
    const topStore = store.storeOf("top");
    expect(baseStore).not.toBeNull();
    expect(topStore).not.toBeNull();
    if (!baseStore || !topStore) {
      return;
    }
    baseStore.indices.fill(3, 0, 10);
    topStore.indices[5] = 5;
    await store.updateLayer("top", { visible: false });

    expect(store.sampleTopDown(5, 0)).toBe(3);
  });
});

describe("瓦片保存结果", () => {
  it("返回的瓦片带正确坐标与格式", async () => {
    const { store } = await setup([makeLayer("a", "甲", 0)]);
    store.storeOf("a")?.indices.fill(7, 0, 10);
    store.markDirty("a", { x: 0, y: 0, width: 10, height: 1 });

    const groups = await store.takeAllDirtyTiles();
    const tile: Tile | undefined = groups[0]?.tiles[0];
    expect(tile?.coord).toEqual({ col: 0, row: 0 });
    expect(tile?.format).toBe("cwt1");
    expect((tile?.data.length ?? 0) > 0).toBe(true);
  });
});
