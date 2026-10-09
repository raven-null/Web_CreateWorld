/**
 * 标记仓库测试：归一化坐标 ↔ 世界像素、命中测试、拖动与删除。
 *
 * 标记是「画布」与「宿主数据」的接缝处，坐标系转换最容易出错，
 * 因此这里覆盖得细一些。
 */
import { describe, expect, it } from "vitest";
import type { HostMarker, MapHostAdapter } from "@worldmap/core";
import { MarkerStore } from "../marker-store";

/** 内存宿主：记录被写回的标记操作 */
function createMarkerAdapter(initial: HostMarker[] = []): {
  adapter: MapHostAdapter;
  saved: { mapId: string; markerId: string; u: number; v: number }[];
  created: { label: string; linkRef: string | null }[];
  deleted: string[];
  markers: HostMarker[];
} {
  const markers = [...initial];
  const saved: { mapId: string; markerId: string; u: number; v: number }[] = [];
  const created: { label: string; linkRef: string | null }[] = [];
  const deleted: string[] = [];

  const adapter: MapHostAdapter = {
    async loadMeta() {
      throw new Error("本测试不使用");
    },
    async loadTiles() {
      return [];
    },
    async saveTiles() {
      return { revision: 1 };
    },
    async loadMarkers() {
      return markers;
    },
    async saveMarkerPosition(input) {
      saved.push(input);
    },
    async createMarker(input) {
      created.push({ label: input.label, linkRef: input.linkRef });
      return { id: `new-${created.length}` };
    },
    async deleteMarker(input) {
      deleted.push(input.markerId);
    },
  };
  return { adapter, saved, created, deleted, markers };
}

describe("标记仓库", () => {
  it("载入时把归一化坐标换算成世界像素", async () => {
    const { adapter } = createMarkerAdapter([
      { id: "m1", u: 0.5, v: 0.25, label: "银月城", linkRef: "entry-1", linkLabel: "银月城条目" },
    ]);
    const store = new MarkerStore({ adapter, mapId: "map", boardWidth: 2048, boardHeight: 1024, revision: 1 });
    const count = await store.load();

    expect(count).toBe(1);
    const marker = store.markers[0];
    expect(marker?.x).toBe(1024);
    expect(marker?.y).toBe(256);
    expect(marker?.label).toBe("银月城");
    // 宿主侧业务标识只作为中性的 linkRef 透传
    expect(marker?.linkRef).toBe("entry-1");
    expect(marker?.linkLabel).toBe("银月城条目");
  });

  it("宿主未实现标记能力时列表为空（缺能力不影响绘制）", async () => {
    const bare: MapHostAdapter = {
      async loadMeta() {
        throw new Error("本测试不使用");
      },
      async loadTiles() {
        return [];
      },
      async saveTiles() {
        return { revision: 1 };
      },
    };
    const store = new MarkerStore({ adapter: bare, mapId: "map", boardWidth: 2048, boardHeight: 1024, revision: 1 });
    expect(await store.load()).toBe(0);
    expect(store.markers).toHaveLength(0);
  });

  it("命中测试：只命中半径内的标记，且优先命中上层", async () => {
    const { adapter } = createMarkerAdapter([
      { id: "far", u: 0.1, v: 0.1, label: "远处" },
      { id: "near", u: 0.5, v: 0.5, label: "近处" },
      { id: "overlap", u: 0.5, v: 0.5, label: "重叠的后者" },
    ]);
    const store = new MarkerStore({ adapter, mapId: "map", boardWidth: 2048, boardHeight: 1024, revision: 1 });
    await store.load();

    // 半径 10 世界像素：命中 0.5/0.5 上的两个，取后者
    const hit = store.hitTest(1024, 512, 10);
    expect(hit?.id).toBe("overlap");

    // 半径外返回 null
    expect(store.hitTest(1500, 900, 10)).toBeNull();
    // 稍远处仍可命中（半径够大）
    expect(store.hitTest(1024, 512, 200)?.id).toBe("overlap");
  });

  it("拖动会夹在画布范围内，并同步归一化坐标", async () => {
    const { adapter, saved } = createMarkerAdapter([{ id: "m1", u: 0.5, v: 0.5, label: "城" }]);
    const store = new MarkerStore({ adapter, mapId: "map", boardWidth: 2048, boardHeight: 1024, revision: 1 });
    await store.load();

    // 拖到画布外：应被夹回边界
    store.moveTo("m1", -100, 5000);
    expect(store.markers[0]?.x).toBe(0);
    expect(store.markers[0]?.y).toBe(1024);
    expect(store.markers[0]?.u).toBe(0);
    expect(store.markers[0]?.v).toBe(1);

    // 正常移动并写回宿主
    store.moveTo("m1", 512, 256);
    expect(await store.persistPosition("m1")).toBe(true);
    expect(saved).toHaveLength(1);
    expect(saved[0]?.u).toBeCloseTo(0.25, 6);
    expect(saved[0]?.v).toBeCloseTo(0.25, 6);
  });

  it("新增标记：位置换算正确并带中性别名", async () => {
    const { adapter, created } = createMarkerAdapter();
    const store = new MarkerStore({ adapter, mapId: "map", boardWidth: 2048, boardHeight: 1024, revision: 1 });
    await store.load();

    const marker = await store.create(512, 256, "北境哨所", "entry-9");
    expect(marker?.id).toBe("new-1");
    expect(marker?.u).toBeCloseTo(0.25, 6);
    expect(marker?.v).toBeCloseTo(0.25, 6);
    expect(created[0]?.label).toBe("北境哨所");
    expect(created[0]?.linkRef).toBe("entry-9");
    expect(store.markers).toHaveLength(1);
  });

  it("删除标记后从列表移除", async () => {
    const { adapter, deleted } = createMarkerAdapter([
      { id: "m1", u: 0.2, v: 0.2, label: "甲" },
      { id: "m2", u: 0.6, v: 0.6, label: "乙" },
    ]);
    const store = new MarkerStore({ adapter, mapId: "map", boardWidth: 2048, boardHeight: 1024, revision: 1 });
    await store.load();

    expect(await store.remove("m1")).toBe(true);
    expect(deleted).toEqual(["m1"]);
    expect(store.markers.map((item) => item.id)).toEqual(["m2"]);
  });
});
