/**
 * 3D 地球仪的数学与档位测试。
 *
 * 3D 画面本身要在浏览器里看，但「球面顶点位置」「相机矩阵」「昼夜方向」
 * 这些是可以算清的——把它们测住，剩下的就只是观感问题。
 */
import { describe, expect, it } from "vitest";
import {
  lonLatToPosition,
  lonLatToUnit,
  mat4Multiply,
  mat4Perspective,
  mat4RotateX,
  mat4RotateY,
  mat4Translate,
  mat4ViewFromOrbit,
  type Mat4,
} from "../gl/mat4";
import { effectsForQuality, recommendQuality } from "../gl/renderer-3d";

/** 矩阵左乘向量（列主序，w 默认 1） */
function applyMatrix(m: Mat4, v: [number, number, number]): [number, number, number] {
  const x = (m[0] ?? 0) * v[0] + (m[4] ?? 0) * v[1] + (m[8] ?? 0) * v[2] + (m[12] ?? 0);
  const y = (m[1] ?? 0) * v[0] + (m[5] ?? 0) * v[1] + (m[9] ?? 0) * v[2] + (m[13] ?? 0);
  const z = (m[2] ?? 0) * v[0] + (m[6] ?? 0) * v[1] + (m[10] ?? 0) * v[2] + (m[14] ?? 0);
  return [x, y, z];
}

describe("经纬度 → 球面位置", () => {
  it("赤道与极点的基本位置（y 向上、z 朝观察者）", () => {
    const north = lonLatToUnit(0, 90);
    expect(north.y).toBeCloseTo(1, 6);
    expect(north.x).toBeCloseTo(0, 6);
    expect(north.z).toBeCloseTo(0, 6);

    const south = lonLatToUnit(0, -90);
    expect(south.y).toBeCloseTo(-1, 6);

    // 经纬度 (0,0) 在 +Z 方向（正对初始观察者）
    const origin = lonLatToUnit(0, 0);
    expect(origin.z).toBeCloseTo(1, 6);

    // 东经 90° 在 +X 方向
    const east = lonLatToUnit(90, 0);
    expect(east.x).toBeCloseTo(1, 6);
    expect(east.z).toBeCloseTo(0, 6);
  });

  it("始终落在单位球面上", () => {
    const cases: [number, number][] = [
      [0, 0],
      [45, 45],
      [-120, -30],
      [179, 89],
      [-179, -89],
    ];
    for (const [lon, lat] of cases) {
      const unit = lonLatToUnit(lon, lat);
      expect(Math.hypot(unit.x, unit.y, unit.z)).toBeCloseTo(1, 6);
    }
  });

  it("半径可缩放", () => {
    const position = lonLatToPosition(0, 0, 2.5);
    expect(position.z).toBeCloseTo(2.5, 6);
  });
});

describe("矩阵", () => {
  it("透视矩阵把近远平面映射到 NDC 的 -1 / +1", () => {
    const near = 0.1;
    const far = 100;
    const projection = mat4Perspective(Math.PI / 3, 1, near, far);

    /** 取投影后的 z / w */
    const zOverW = (z: number): number => {
      const clipZ = (projection[10] ?? 0) * z + (projection[14] ?? 0);
      const clipW = (projection[11] ?? 0) * z + (projection[15] ?? 0);
      return clipZ / clipW;
    };

    expect(zOverW(-near)).toBeCloseTo(-1, 5);
    expect(zOverW(-far)).toBeCloseTo(1, 5);
  });

  it("视图矩阵：相机在 +Z 轴上时把球心映射到 -Z 方向", () => {
    const view = mat4ViewFromOrbit(0, 0, 3);
    const origin = applyMatrix(view, [0, 0, 0]);
    expect(origin[0]).toBeCloseTo(0, 6);
    expect(origin[1]).toBeCloseTo(0, 6);
    expect(origin[2]).toBeCloseTo(-3, 6);
  });

  it("视图矩阵：相机绕到侧面后，球心仍在视线前方", () => {
    const view = mat4ViewFromOrbit(Math.PI / 2, 0, 3);
    const origin = applyMatrix(view, [0, 0, 0]);
    expect(origin[2]).toBeCloseTo(-3, 6);
    // 相机在 +X 轴上 → 球心在视图空间的 x 仍为 0
    expect(origin[0]).toBeCloseTo(0, 6);
  });

  it("绕 Y 轴 90°：+Z 转到 +X", () => {
    const rotated = applyMatrix(mat4RotateY(Math.PI / 2), [0, 0, 1]);
    expect(rotated[0]).toBeCloseTo(1, 6);
    expect(rotated[2]).toBeCloseTo(0, 6);
  });

  it("绕 X 轴 90°：+Y 转到 +Z（俯视方向的直觉）", () => {
    const rotated = applyMatrix(mat4RotateX(Math.PI / 2), [0, 1, 0]);
    expect(rotated[1]).toBeCloseTo(0, 6);
    expect(rotated[2]).toBeCloseTo(1, 6);
  });

  it("平移矩阵按预期搬移点", () => {
    const moved = applyMatrix(mat4Translate(1, 2, 3), [10, 0, 0]);
    expect(moved[0]).toBeCloseTo(11, 6);
    expect(moved[1]).toBeCloseTo(2, 6);
    expect(moved[2]).toBeCloseTo(3, 6);
  });

  it("矩阵相乘顺序：先 b 后 a", () => {
    const rotate = mat4RotateY(Math.PI / 2);
    const translate = mat4Translate(1, 0, 0);
    // 先平移 (+X) 再旋转 90°：点 (0,0,0) → (1,0,0) → (0,0,-1)
    const combined = mat4Multiply(rotate, translate);
    const result = applyMatrix(combined, [0, 0, 0]);
    expect(result[0]).toBeCloseTo(0, 6);
    expect(result[2]).toBeCloseTo(-1, 6);
  });
});

describe("性能档位与效果组合", () => {
  it("桌面默认完整：三项美术全开", () => {
    expect(recommendQuality({ screenWidth: 1920, touchPrimary: false })).toBe("full");
    expect(effectsForQuality("full")).toEqual({ atmosphere: true, stars: true, dayNight: true });
  });

  it("移动端默认精简：关大气辉光，保留星空与昼夜", () => {
    expect(recommendQuality({ screenWidth: 1920, touchPrimary: true })).toBe("lite");
    expect(effectsForQuality("lite")).toEqual({ atmosphere: false, stars: true, dayNight: true });
  });

  it("窄屏也算移动端（即便没有触摸）", () => {
    expect(recommendQuality({ screenWidth: 600, touchPrimary: false })).toBe("lite");
  });

  it("最简档位关闭全部美术效果（但 3D 本身仍可用）", () => {
    expect(effectsForQuality("minimal")).toEqual({ atmosphere: false, stars: false, dayNight: false });
  });
});
