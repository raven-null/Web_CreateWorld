/**
 * 本地草稿测试（用 fake-indexeddb 提供 IndexedDB 环境，无需浏览器）。
 *
 * 草稿是「用户刚画完就关页面 / 断网保存失败」时的最后一道保险，
 * 因此重点验证：写入后能原样读回、白板尺寸变化时自动作废、清除后不再提示。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { encodeTile, type Tile } from "@worldmap/core";
import { createIndexedDbDraftStore, type IndexedDbDraftStore } from "../indexeddb-draft";

/** 造一个小的 cwt1 瓦片（16×16，未压缩） */
async function makeTile(col: number, row: number, fill: number): Promise<Tile> {
  const indices = new Uint8Array(16 * 16).fill(fill);
  const data = await encodeTile({ indices, width: 16, height: 16 }, null);
  return { coord: { col, row }, format: "cwt1", data };
}

/** 搭建隔离的存储与全局 IndexedDB */
function setup(): IndexedDbDraftStore {
  // 每个用例一个全新的 IndexedDB 实现，避免用例之间相互污染
  (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  return createIndexedDbDraftStore();
}

describe("IndexedDB 草稿", () => {
  let store: IndexedDbDraftStore;

  beforeEach(() => {
    store = setup();
  });

  it("环境可用性探测", () => {
    expect(store.isAvailable()).toBe(true);
  });

  it("写入后能读回同一批瓦片", async () => {
    const tiles = [await makeTile(0, 0, 3), await makeTile(1, 0, 5)];
    await store.saveTiles({ mapId: "m1", layerId: "terrain", width: 512, height: 256, tiles });

    const loaded = await store.loadTiles("m1", 512, 256);
    expect(loaded).not.toBeNull();
    expect(loaded?.tiles).toHaveLength(2);
    expect(loaded?.tiles[0]?.coord).toEqual({ col: 0, row: 0 });
    // 逐字节一致（草稿必须能原样恢复）
    expect(Array.from(loaded?.tiles[0]?.data ?? [])).toEqual(Array.from(tiles[0]?.data ?? []));
    expect(loaded?.savedAt).toBeGreaterThan(0);
  });

  it("白板尺寸变化时草稿自动作废（坐标语义已不同）", async () => {
    await store.saveTiles({
      mapId: "m1",
      layerId: "terrain",
      width: 512,
      height: 256,
      tiles: [await makeTile(0, 0, 3)],
    });

    const mismatched = await store.loadTiles("m1", 1024, 512);
    expect(mismatched).toBeNull();
    // 作废后应已被清除，不再反复提示
    expect(await store.loadTiles("m1", 512, 256)).toBeNull();
  });

  it("清除后读不到草稿", async () => {
    await store.saveTiles({
      mapId: "m1",
      layerId: "terrain",
      width: 512,
      height: 256,
      tiles: [await makeTile(0, 0, 7)],
    });
    await store.clear("m1");
    expect(await store.loadTiles("m1", 512, 256)).toBeNull();
    expect(await store.load("m1")).toBeNull();
  });

  it("没有草稿时返回 null（首次打开不该提示恢复）", async () => {
    expect(await store.loadTiles("never-saved", 512, 256)).toBeNull();
    expect(await store.load("never-saved")).toBeNull();
  });

  it("重复保存同一地图只保留最新一份", async () => {
    await store.saveTiles({
      mapId: "m1",
      layerId: "terrain",
      width: 512,
      height: 256,
      tiles: [await makeTile(0, 0, 1)],
    });
    await store.saveTiles({
      mapId: "m1",
      layerId: "terrain",
      width: 512,
      height: 256,
      tiles: [await makeTile(0, 0, 4), await makeTile(1, 0, 2)],
    });

    const loaded = await store.loadTiles("m1", 512, 256);
    expect(loaded?.tiles).toHaveLength(2);
    // 瓦片已被新内容覆盖（草稿只留最新）：cwt1 头部 9 字节之后的第一个索引
    expect(loaded?.tiles[0]?.data[9]).toBe(4);
  });

  it("草稿瓦片可解码回索引数据（恢复时要用）", async () => {
    const tile = await makeTile(0, 0, 6);
    await store.saveTiles({ mapId: "m1", layerId: "terrain", width: 512, height: 256, tiles: [tile] });

    const loaded = await store.loadTiles("m1", 512, 256);
    const first = loaded?.tiles[0];
    expect(first).toBeDefined();
    const indices = await store.decodeDraftTile(first as Tile);
    expect(indices).not.toBeNull();
    expect(indices?.length).toBe(16 * 16);
    expect(indices?.[0]).toBe(6);
  });
});
