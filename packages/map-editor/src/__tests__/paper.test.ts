/**
 * 纸张铺法的几何回归测试。
 *
 * 换纸张素材后最容易错的两处（肉眼很难定位）：
 * 1. **拉伸取景**：素材宽高比通常不是 2:1，直接拉会把纹理压扁
 * 2. **局部重烘的坐标**：目标上下文被平移到区域原点后，
 *    世界坐标不减原点就会整体位移——撤销一笔后纹理会「跳一下」
 *
 * 这两个函数是纯几何计算，因此可以在没有 DOM 的环境里直接验证。
 */
import { describe, expect, it } from "vitest";
import { resolvePaperStretchDraw, resolveStretchCrop } from "../terrain-render";

describe("拉伸铺法的取景", () => {
  it("整张直接用：不裁切、不留边（纸张是有机纹理，轻微拉伸看不出来，丢画面看得出来）", () => {
    const crop = resolveStretchCrop(1440, 1080);
    expect(crop).toEqual({ sx: 0, sy: 0, sw: 1440, sh: 1080 });
  });

  it("横图竖图都取整张", () => {
    expect(resolveStretchCrop(1000, 2000)).toEqual({ sx: 0, sy: 0, sw: 1000, sh: 2000 });
    expect(resolveStretchCrop(2048, 1024)).toEqual({ sx: 0, sy: 0, sw: 2048, sh: 1024 });
  });
});

describe("拉伸铺法的区域换算", () => {
  const board = { width: 2048, height: 1024 };
  const paper = { width: 1440, height: 720 };

  it("整幅铺满：源取样覆盖整张纸", () => {
    const rect = resolvePaperStretchDraw(0, 0, board.width, board.height, board.width, board.height, paper.width, paper.height);
    expect(rect.sx).toBe(0);
    expect(rect.sy).toBe(0);
    expect(rect.sw).toBe(paper.width);
    expect(rect.sh).toBe(paper.height);
    expect(rect.dx).toBe(0);
    expect(rect.dy).toBe(0);
    expect(rect.dw).toBe(board.width);
    expect(rect.dh).toBe(board.height);
  });

  it("右下角一小块：只取整张纸的对应象限", () => {
    const half = board.width / 2;
    const halfH = board.height / 2;
    const rect = resolvePaperStretchDraw(half, halfH, half, halfH, board.width, board.height, paper.width, paper.height);
    expect(rect.sx).toBe(paper.width / 2);
    expect(rect.sy).toBe(paper.height / 2);
    expect(rect.sw).toBe(paper.width / 2);
    expect(rect.sh).toBe(paper.height / 2);
  });

  it("局部重烘的目标矩形始终落在区域原点（与世界坐标无关）", () => {
    // 这是防「图案整体位移」的关键：无论重烘哪一块，画到目标画布时都从 0,0 开始
    for (const [x, y] of [
      [0, 0],
      [300, 200],
      [1900, 900],
    ] as const) {
      const rect = resolvePaperStretchDraw(x, y, 128, 128, board.width, board.height, paper.width, paper.height);
      expect(rect.dx).toBe(0);
      expect(rect.dy).toBe(0);
      expect(rect.dw).toBe(128);
      expect(rect.dh).toBe(128);
    }
  });

  it("白板原点与整幅原点一致：区域 0,0 取的就是纸张左上角", () => {
    const rect = resolvePaperStretchDraw(0, 0, 256, 256, board.width, board.height, paper.width, paper.height);
    expect(rect.sx).toBe(0);
    expect(rect.sy).toBe(0);
  });
});
