/**
 * 测量与面积统计测试。
 *
 * 这两块是「用户照着数字改图」的依据，算错比没有更糟：
 * - 距离必须走球面最短路径（haversine），而不是像素估算
 * - 面积必须按纬度带加权（每像素面积随纬度衰减 cos(lat)）
 */
import { describe, expect, it } from "vitest";
import { EARTH_RADIUS_KM, type BoardSpec } from "@worldmap/core";
import { computeRasterStats, dominantTerrain, measurePolyline } from "../measure";

/** 地球 + 512×256 白板（小尺寸便于手算） */
const BOARD: BoardSpec = {
  width: 512,
  height: 256,
  projection: "equirect",
  radiusKm: EARTH_RADIUS_KM,
};

/** 相对误差是否在容差内 */
function withinTolerance(actual: number, expected: number, tolerance = 0.01): boolean {
  return Math.abs(actual - expected) / Math.max(Math.abs(expected), 1e-9) <= tolerance;
}

describe("测量：距离与方位", () => {
  it("沿赤道的两点距离与球面公式一致", () => {
    // 赤道上经度 0 → 90：应为四分之一周长
    const result = measurePolyline(
      [
        { lon: 0, lat: 0 },
        { lon: 90, lat: 0 },
      ],
      EARTH_RADIUS_KM,
    );
    const expected = (Math.PI * EARTH_RADIUS_KM) / 2;
    expect(result).not.toBeNull();
    expect(withinTolerance(result?.directKm ?? 0, expected, 0.001)).toBe(true);
  });

  it("折线累计长度等于各段之和", () => {
    const result = measurePolyline(
      [
        { lon: 0, lat: 0 },
        { lon: 30, lat: 0 },
        { lon: 60, lat: 0 },
      ],
      EARTH_RADIUS_KM,
    );
    expect(result?.segmentsKm).toHaveLength(2);
    const sum = (result?.segmentsKm ?? []).reduce((total, value) => total + value, 0);
    expect(withinTolerance(result?.polylineKm ?? 0, sum, 1e-6)).toBe(true);
  });

  it("直线距离取起终点，不随中间折点变长", () => {
    const direct = measurePolyline(
      [
        { lon: 0, lat: 0 },
        { lon: 60, lat: 0 },
      ],
      EARTH_RADIUS_KM,
    );
    const bent = measurePolyline(
      [
        { lon: 0, lat: 0 },
        { lon: 30, lat: 40 },
        { lon: 60, lat: 0 },
      ],
      EARTH_RADIUS_KM,
    );
    // 折线更长，但起终点直线距离一致
    expect((bent?.polylineKm ?? 0) > (direct?.polylineKm ?? 0)).toBe(true);
    expect(withinTolerance(bent?.directKm ?? 0, direct?.directKm ?? 0, 0.001)).toBe(true);
  });

  it("方位角：正北为 0°、正东为 90°", () => {
    const north = measurePolyline(
      [
        { lon: 0, lat: 0 },
        { lon: 0, lat: 45 },
      ],
      EARTH_RADIUS_KM,
    );
    expect(Math.round(north?.directBearing ?? -1)).toBe(0);

    const east = measurePolyline(
      [
        { lon: 0, lat: 0 },
        { lon: 45, lat: 0 },
      ],
      EARTH_RADIUS_KM,
    );
    expect(Math.round(east?.directBearing ?? -1)).toBe(90);
  });

  it("点数不足时返回 null", () => {
    expect(measurePolyline([], EARTH_RADIUS_KM)).toBeNull();
    expect(measurePolyline([{ lon: 0, lat: 0 }], EARTH_RADIUS_KM)).toBeNull();
  });
});

describe("面积统计", () => {
  it("整幅填满时总面积等于天体表面积（纬度带加权）", () => {
    const indices = new Uint8Array(BOARD.width * BOARD.height).fill(3);
    const stats = computeRasterStats(indices, BOARD.width, BOARD.height, [
      { index: 3, name: "草地", color: "#5d7a4a" },
    ], BOARD);

    const surface = 4 * Math.PI * EARTH_RADIUS_KM * EARTH_RADIUS_KM;
    expect(withinTolerance(stats.paintedKm2, surface, 0.02)).toBe(true);
    expect(Math.round(stats.paintedPercent)).toBe(100);
  });

  it("南北半球各填一半时两块面积相等（cos 的对称性）", () => {
    const width = BOARD.width;
    const height = BOARD.height;
    const indices = new Uint8Array(width * height);
    for (let row = 0; row < height; row += 1) {
      const value = row < height / 2 ? 3 : 5;
      indices.fill(value, row * width, (row + 1) * width);
    }
    const stats = computeRasterStats(
      indices,
      width,
      height,
      [
        { index: 3, name: "草地", color: "#5d7a4a" },
        { index: 5, name: "沙漠", color: "#c2a878" },
      ],
      BOARD,
    );

    expect(stats.terrains).toHaveLength(2);
    const [first, second] = stats.terrains;
    expect(withinTolerance(first?.areaKm2 ?? 0, second?.areaKm2 ?? 0, 0.02)).toBe(true);
    // 各地形像素数完全相同，面积由纬度带加权决定
    expect(first?.pixels).toBe(second?.pixels);
  });

  it("纬度跨度相同时，低纬度带面积明显更大（每像素面积随纬度衰减）", () => {
    const width = 128;
    const height = 128;
    // 取两段纬度跨度相同的带：
    //   高纬带 = 第 0~15 行（纬度 90°~67.5°，中心 78.75°）
    //   低纬带 = 第 48~63 行（纬度 22.5°~0°，中心 11.25°）
    // 两块像素数相同，面积比应约等于 cos(78.75°)/cos(11.25°) ≈ 0.206
    const indices = new Uint8Array(width * height);
    const highStart = 0;
    const lowStart = Math.floor(height * 3 / 8);
    const band = 16;
    indices.fill(3, highStart * width, (highStart + band) * width);
    indices.fill(5, lowStart * width, (lowStart + band) * width);

    const board: BoardSpec = { ...BOARD, width, height };
    const stats = computeRasterStats(
      indices,
      width,
      height,
      [
        { index: 3, name: "高纬", color: "#111111" },
        { index: 5, name: "低纬", color: "#222222" },
      ],
      board,
    );

    const high = stats.terrains.find((terrain) => terrain.name === "高纬");
    const low = stats.terrains.find((terrain) => terrain.name === "低纬");
    expect(high?.pixels).toBe(low?.pixels);

    const ratio = (high?.areaKm2 ?? 0) / (low?.areaKm2 ?? 0);
    const expected = Math.cos((78.75 * Math.PI) / 180) / Math.cos((11.25 * Math.PI) / 180);
    expect(withinTolerance(ratio, expected, 0.02)).toBe(true);
    // 低纬带面积应约为高纬带的 4.8 倍
    expect((low?.areaKm2 ?? 0) > (high?.areaKm2 ?? 0)).toBe(true);
  });

  it("南北半球各填一半时两块面积相等（cos 的对称性）", () => {
    const width = BOARD.width;
    const height = BOARD.height;
    const indices = new Uint8Array(width * height);
    for (let row = 0; row < height; row += 1) {
      indices.fill(row < height / 2 ? 3 : 5, row * width, (row + 1) * width);
    }
    const stats = computeRasterStats(
      indices,
      width,
      height,
      [
        { index: 3, name: "北半球", color: "#5d7a4a" },
        { index: 5, name: "南半球", color: "#c2a878" },
      ],
      BOARD,
    );

    expect(stats.terrains).toHaveLength(2);
    const [first, second] = stats.terrains;
    // 各占半个球面
    expect(withinTolerance(first?.areaKm2 ?? 0, second?.areaKm2 ?? 0, 0.02)).toBe(true);
    expect(withinTolerance(first?.areaKm2 ?? 0, stats.surfaceKm2 / 2, 0.02)).toBe(true);
  });

  it("透明区域不计入统计与总面积", () => {
    const indices = new Uint8Array(BOARD.width * BOARD.height);
    // 只填左上角一小块
    indices.fill(3, 0, BOARD.width * 10);
    const stats = computeRasterStats(indices, BOARD.width, BOARD.height, [
      { index: 3, name: "草地", color: "#5d7a4a" },
    ], BOARD);

    expect(stats.terrains).toHaveLength(1);
    expect(stats.terrains[0]?.pixels).toBe(BOARD.width * 10);
    expect(stats.paintedPercent).toBeLessThan(10);
  });

  it("未在调色板中登记的下标也能统计（给出兜底名称）", () => {
    const indices = new Uint8Array(BOARD.width * BOARD.height);
    indices.fill(9, 0, BOARD.width * 5);
    const stats = computeRasterStats(indices, BOARD.width, BOARD.height, [], BOARD);
    expect(stats.terrains[0]?.name).toBe("地形 9");
  });

  it("面积最大的地形会被选为「主要地形」", () => {
    const indices = new Uint8Array(BOARD.width * BOARD.height);
    indices.fill(3, 0, BOARD.width * 100);
    indices.fill(5, BOARD.width * 100, BOARD.width * 120);
    const stats = computeRasterStats(
      indices,
      BOARD.width,
      BOARD.height,
      [
        { index: 3, name: "草地", color: "#5d7a4a" },
        { index: 5, name: "沙漠", color: "#c2a878" },
      ],
      BOARD,
    );
    expect(dominantTerrain(stats)?.name).toBe("草地");
  });
});
