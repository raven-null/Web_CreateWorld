/**
 * 绘制内核测试：笔刷几何、撤销栈、瓦片仓库。
 *
 * 这些是「能画」的核心逻辑，与 DOM 无关，因此可以完整单测；
 * 渲染与指针交互留给浏览器实测。
 */
import { describe, expect, it } from "vitest";
import {
  CWT1_HEADER_BYTES,
  DEFAULT_TERRAIN_PALETTE,
  encodeTile,
  type MapHostAdapter,
  type MapMeta,
  type Tile,
  type TileCoord,
} from "@worldmap/core";
import {
  MAX_BRUSH_SCREEN_SIZE,
  MIN_BRUSH_SCREEN_SIZE,
  brushRect,
  brushWorldSize,
  clampBrushSize,
  expandRect,
  interpolatePointerPath,
  paintRect,
  unionRect,
} from "../brush-engine";
import { HistoryStack } from "../history";
import { RasterTileStore, TILE_SIZE } from "../tile-store";

/** 内存宿主适配器：测试用，不碰网络 */
function createMemoryAdapter(options: { tiles?: Map<string, Uint8Array> } = {}): {
  adapter: MapHostAdapter;
  saved: { tiles: Tile[]; revision: number }[];
} {
  const store = options.tiles ?? new Map<string, Uint8Array>();
  const saved: { tiles: Tile[]; revision: number }[] = [];
  const meta: MapMeta = {
    id: "test-map",
    kind: "canvas",
    board: { width: 512, height: 256, projection: "equirect", radiusKm: 6371 },
    revision: 3,
    palette: DEFAULT_TERRAIN_PALETTE,
    layers: [
      {
        id: "terrain",
        name: "地形",
        type: "terrain",
        storage: "raster",
        visible: true,
        opacity: 1,
        zIndex: 0,
        legend: [],
      },
    ],
    canEdit: true,
  };

  const adapter: MapHostAdapter = {
    async loadMeta() {
      return meta;
    },
    async loadTiles(_mapId, _layerId, coords) {
      return coords.map((coord) => {
        const data = store.get(`${coord.col}:${coord.row}`);
        return data ? { coord, format: "cwt1", data } : null;
      });
    },
    async saveTiles(input) {
      saved.push({ tiles: input.tiles, revision: input.revision });
      return { revision: input.revision + 1 };
    },
  };
  return { adapter, saved };
}

/** 造一个 cwt1 未压缩瓦片 */
async function makeTile(col: number, row: number, fill: number, width = TILE_SIZE, height = TILE_SIZE): Promise<Uint8Array> {
  const indices = new Uint8Array(width * height).fill(fill);
  const encoded = await encodeTile({ indices, width, height }, null);
  void col;
  void row;
  return encoded;
}

describe("笔刷几何", () => {
  it("笔刷大小按屏幕像素定义，缩放后换算成世界像素", () => {
    expect(brushWorldSize(24, 1)).toBe(24);
    expect(brushWorldSize(24, 2)).toBe(12);
    // 最小 1 像素：满足极精细绘制（方案 §7.3）
    expect(brushWorldSize(1, 8)).toBe(1);
  });

  it("方块笔刷的覆盖矩形以落点为中心并被夹在画布内", () => {
    const rect = brushRect(100, 100, 20, 1, 512, 256);
    expect(rect).not.toBeNull();
    expect(rect?.width).toBe(20);
    expect(rect?.height).toBe(20);
    expect(rect?.x).toBe(90);
    expect(rect?.y).toBe(90);
  });

  it("落点在边角时矩形被裁剪，不会越界", () => {
    const topLeft = brushRect(0, 0, 20, 1, 512, 256);
    expect(topLeft?.x).toBe(0);
    expect(topLeft?.y).toBe(0);

    const bottomRight = brushRect(511, 255, 20, 1, 512, 256);
    expect((bottomRight?.x ?? 0) + (bottomRight?.width ?? 0)).toBe(512);
    expect((bottomRight?.y ?? 0) + (bottomRight?.height ?? 0)).toBe(256);
  });

  it("落点完全在画布外时返回 null（不产生空撤销步）", () => {
    expect(brushRect(-50, -50, 10, 1, 512, 256)).toBeNull();
    expect(brushRect(600, 300, 10, 1, 512, 256)).toBeNull();
  });

  it("涂抹写入指定的调色板下标，擦除写 0", () => {
    const indices = new Uint8Array(8 * 8);
    paintRect(indices, 8, { x: 1, y: 1, width: 2, height: 2 }, 3);
    expect(indices[1 * 8 + 1]).toBe(3);
    expect(indices[2 * 8 + 2]).toBe(3);
    expect(indices[0]).toBe(0);

    paintRect(indices, 8, { x: 1, y: 1, width: 2, height: 2 }, 0);
    expect(indices[1 * 8 + 1]).toBe(0);
  });

  it("矩形合并与扩边", () => {
    const a = { x: 10, y: 10, width: 5, height: 5 };
    const b = { x: 20, y: 4, width: 5, height: 5 };
    const union = unionRect(a, b);
    expect(union.x).toBe(10);
    expect(union.y).toBe(4);
    expect(union.x + union.width).toBe(25);
    expect(union.y + union.height).toBe(15);

    const expanded = expandRect(a, 512, 256, 2);
    expect(expanded.x).toBe(8);
    expect(expanded.width).toBe(9);
  });

  it("笔刷大小限制在 1~64", () => {
    expect(clampBrushSize(0)).toBe(MIN_BRUSH_SCREEN_SIZE);
    expect(clampBrushSize(999)).toBe(MAX_BRUSH_SCREEN_SIZE);
    expect(clampBrushSize(24.4)).toBe(24);
  });

  it("快速拖动时两点之间会补点（否则笔画成虚线）", () => {
    const points = interpolatePointerPath({ x: 0, y: 0 }, { x: 100, y: 0 }, 10);
    expect(points.length).toBe(10);
    expect(points[0]?.x).toBeCloseTo(10, 6);
    expect(points[points.length - 1]?.x).toBeCloseTo(100, 6);

    // 距离小于步长时只返回终点
    const near = interpolatePointerPath({ x: 0, y: 0 }, { x: 3, y: 0 }, 10);
    expect(near).toHaveLength(1);
    expect(near[0]?.x).toBe(3);
  });
});

describe("撤销栈", () => {
  it("一次笔画合并为一步，可撤销可重做", () => {
    const history = new HistoryStack();
    history.begin("笔刷");
    history.record({ x: 1, y: 1, width: 2, height: 2 }, new Uint8Array(4), new Uint8Array(4).fill(3));
    history.record({ x: 3, y: 3, width: 2, height: 2 }, new Uint8Array(4), new Uint8Array(4).fill(3));
    history.commit();

    expect(history.undoCount).toBe(1);
    expect(history.redoCount).toBe(0);

    const entry = history.peekUndo();
    expect(entry?.before[0]).toBe(0);
    expect(entry?.after[0]).toBe(3);
    history.confirmUndo();
    expect(history.undoCount).toBe(0);
    expect(history.redoCount).toBe(1);

    history.confirmRedo();
    expect(history.undoCount).toBe(1);
  });

  it("没有实际记录的步骤不入栈", () => {
    const history = new HistoryStack();
    history.begin("笔刷");
    history.commit();
    expect(history.undoCount).toBe(0);
  });

  it("新操作会清空重做栈", () => {
    const history = new HistoryStack();
    history.begin("a");
    history.record({ x: 0, y: 0, width: 1, height: 1 }, new Uint8Array(1), new Uint8Array(1).fill(1));
    history.commit();
    history.confirmUndo();
    expect(history.redoCount).toBe(1);

    history.begin("b");
    history.record({ x: 0, y: 0, width: 1, height: 1 }, new Uint8Array(1), new Uint8Array(1).fill(2));
    history.commit();
    expect(history.redoCount).toBe(0);
  });

  it("超过深度上限时丢弃最旧的一步", () => {
    const history = new HistoryStack(3);
    for (let i = 0; i < 5; i += 1) {
      history.begin(`step-${i}`);
      history.record({ x: i, y: 0, width: 1, height: 1 }, new Uint8Array(1), new Uint8Array(1).fill(i + 1));
      history.commit();
    }
    expect(history.undoCount).toBe(3);
  });
});

describe("瓦片仓库", () => {
  it("全量载入：有瓦片则读入，缺失的保持透明", async () => {
    const tiles = new Map<string, Uint8Array>();
    tiles.set("0:0", await makeTile(0, 0, 3));
    // 1:0 故意缺失，代表空瓦片
    const { adapter } = createMemoryAdapter({ tiles });

    const store = new RasterTileStore({
      adapter,
      mapId: "test-map",
      layerId: "terrain",
      width: 512,
      height: 256,
    });
    const loaded = await store.load();

    expect(loaded).toBe(1);
    expect(store.indices[0]).toBe(3); // 左上角来自 0:0
    expect(store.indices[TILE_SIZE]).toBe(0); // 右边瓦片缺失 → 透明
  });

  it("标记脏瓦片后只在内容真的变化时提交", async () => {
    const { adapter } = createMemoryAdapter();
    const store = new RasterTileStore({
      adapter,
      mapId: "test-map",
      layerId: "terrain",
      width: 512,
      height: 256,
    });
    await store.load();

    // 空白 → 涂一笔：内容变化，应提交 1 个瓦片
    paintRect(store.indices, store.width, { x: 10, y: 10, width: 8, height: 8 }, 4);
    store.markDirty({ x: 10, y: 10, width: 8, height: 8 });
    expect(store.dirtyCount).toBe(1);

    const tiles = await store.takeDirtyTiles();
    expect(tiles).toHaveLength(1);
    expect(tiles[0]?.coord).toEqual({ col: 0, row: 0 });

    store.commitBaseline([{ col: 0, row: 0 }]);
    expect(store.dirtyCount).toBe(0);
  });

  it("涂回原样后不提交（避免无意义的上传）", async () => {
    const { adapter } = createMemoryAdapter();
    const store = new RasterTileStore({
      adapter,
      mapId: "test-map",
      layerId: "terrain",
      width: 512,
      height: 256,
    });
    await store.load();

    const rect = { x: 4, y: 4, width: 4, height: 4 };
    paintRect(store.indices, store.width, rect, 5);
    store.markDirty(rect);
    const first = await store.takeDirtyTiles();
    expect(first).toHaveLength(1);
    // 这次不调用 commitBaseline：模拟「涂了还没保存就擦回」
    paintRect(store.indices, store.width, rect, 0);
    store.markDirty(rect);
    const second = await store.takeDirtyTiles();
    expect(second).toHaveLength(0);

    // 脏标记仍需清掉，否则会一直显示「有未保存改动」
    store.clearDirtyAsBaseline();
    expect(store.dirtyCount).toBe(0);
  });

  it("保存成功后基线更新，再涂同样的内容不会重复提交", async () => {
    const { adapter } = createMemoryAdapter();
    const store = new RasterTileStore({
      adapter,
      mapId: "test-map",
      layerId: "terrain",
      width: 512,
      height: 256,
    });
    await store.load();

    const rect = { x: 4, y: 4, width: 4, height: 4 };
    paintRect(store.indices, store.width, rect, 5);
    store.markDirty(rect);
    const first = await store.takeDirtyTiles();
    store.commitBaseline(first.map((tile) => tile.coord));
    expect(store.dirtyCount).toBe(0);

    // 被误标脏（例如撤销又重做）但内容未变：不应再次提交
    store.markDirty(rect);
    const second = await store.takeDirtyTiles();
    expect(second).toHaveLength(0);
  });

  it("矩形读写可回放（撤销的数据来源）", async () => {
    const { adapter } = createMemoryAdapter();
    const store = new RasterTileStore({
      adapter,
      mapId: "test-map",
      layerId: "terrain",
      width: 512,
      height: 256,
    });
    await store.load();

    const rect = { x: 2, y: 3, width: 4, height: 2 };
    const before = store.readRect(rect);
    paintRect(store.indices, store.width, rect, 7);
    const after = store.readRect(rect);
    expect(after[0]).toBe(7);

    store.writeRect(rect, before);
    expect(store.readRect(rect)[0]).toBe(before[0]);
    store.writeRect(rect, after);
    expect(store.readRect(rect)[0]).toBe(7);
  });

  it("吸管取样命中正确像素与越界保护", async () => {
    const { adapter } = createMemoryAdapter();
    const store = new RasterTileStore({
      adapter,
      mapId: "test-map",
      layerId: "terrain",
      width: 512,
      height: 256,
    });
    await store.load();

    paintRect(store.indices, store.width, { x: 5, y: 5, width: 2, height: 2 }, 6);
    expect(store.sampleAt(5, 5)).toBe(6);
    expect(store.sampleAt(6, 6)).toBe(6);
    expect(store.sampleAt(-1, 0)).toBe(0);
    expect(store.sampleAt(0, 9999)).toBe(0);
  });

  it("非 256 倍数白板：边缘瓦片按实际尺寸处理", async () => {
    const { adapter } = createMemoryAdapter();
    // 白板 300×200：列 2 个（第 2 列仅 44 像素宽）、行 1 个（仅 200 像素高）
    const store = new RasterTileStore({
      adapter,
      mapId: "test-map",
      layerId: "terrain",
      width: 300,
      height: 200,
    });
    await store.load();

    expect(store.tileSizeAt({ col: 0, row: 0 })).toEqual({ width: 256, height: 200 });
    expect(store.tileSizeAt({ col: 1, row: 0 })).toEqual({ width: 44, height: 200 });

    // 在边缘瓦片内涂抹后能取出，且切片尺寸正确
    paintRect(store.indices, store.width, { x: 260, y: 10, width: 8, height: 8 }, 4);
    store.markDirty({ x: 260, y: 10, width: 8, height: 8 });
    const tiles = await store.takeDirtyTiles();
    expect(tiles).toHaveLength(1);
    expect(tiles[0]?.coord).toEqual({ col: 1, row: 0 });
    // 44×200 的瓦片：头部 9 字节 + 8800 索引
    expect(tiles[0]?.data.length).toBe(CWT1_HEADER_BYTES + 44 * 200);
  });
});
