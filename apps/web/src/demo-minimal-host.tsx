/**
 * 最小宿主示例（不依赖主站的任何模块）。
 *
 * 用途：验证「插件真的独立」——这里只给了三样东西：
 *   1. 一个 mapId
 *   2. 一个用内存数据实现的 `MapHostAdapter`
 *   3. （可选）一点主题覆盖
 * 除此之外没有任何后端、路由、登录、世界/条目概念，编辑器照样能跑起来。
 *
 * 它同时也是接入文档的活样例：别的项目照抄这段就能用上地图编辑器。
 *
 * 运行方式：`pnpm dev:web` 后打开 http://localhost:5173/demo.html
 */
import { createRoot } from "react-dom/client";
import { MapEditor } from "@worldmap/editor";
import {
  CWT1_HEADER_BYTES,
  type MapHostAdapter,
  type MapMeta,
  type Tile,
  type TileCoord,
} from "@worldmap/core";

/** 白板尺寸：2048×1024（默认档位） */
const BOARD_WIDTH = 2048;
const BOARD_HEIGHT = 1024;
/** 瓦片边长（与主站后端一致） */
const TILE_SIZE = 256;

/**
 * 造一块「有内容」的白板：左侧海洋、中间大陆（带森林与山地）、右侧海洋。
 * 这样一眼就能看出渲染、缩放、经纬网是否正常。
 * @param col 瓦片列号
 * @param row 瓦片行号
 * @returns 索引栅格
 */
function buildTileIndices(col: number, row: number): Uint8Array {
  const indices = new Uint8Array(TILE_SIZE * TILE_SIZE);
  const originX = col * TILE_SIZE;
  const originY = row * TILE_SIZE;
  for (let y = 0; y < TILE_SIZE; y += 1) {
    for (let x = 0; x < TILE_SIZE; x += 1) {
      const worldX = originX + x;
      const worldY = originY + y;
      // 居中的椭圆大陆
      const dx = (worldX - BOARD_WIDTH * 0.5) / (BOARD_WIDTH * 0.34);
      const dy = (worldY - BOARD_HEIGHT * 0.5) / (BOARD_HEIGHT * 0.42);
      const distance = Math.hypot(dx, dy);
      let value = 1; // 海洋
      if (distance < 0.55) {
        value = 4; // 森林
      } else if (distance < 0.8) {
        value = 3; // 草地
      } else if (distance < 0.95) {
        value = 2; // 浅海
      }
      // 北侧加一条山地
      if (distance < 0.8 && worldY < BOARD_HEIGHT * 0.3) {
        value = 6;
      }
      indices[y * TILE_SIZE + x] = value;
    }
  }
  return indices;
}

/**
 * 把索引栅格打包成未压缩的 cwt1 字节（示例里省掉 gzip，保持零依赖）。
 * @param indices 索引栅格
 * @returns cwt1 字节
 */
function packTile(indices: Uint8Array): Uint8Array {
  const out = new Uint8Array(CWT1_HEADER_BYTES + indices.length);
  out[0] = 0x43; // C
  out[1] = 0x57; // W
  out[2] = 0x54; // T
  out[3] = 0x31; // 1
  out[4] = TILE_SIZE & 0xff;
  out[5] = (TILE_SIZE >> 8) & 0xff;
  out[6] = TILE_SIZE & 0xff;
  out[7] = (TILE_SIZE >> 8) & 0xff;
  out[8] = 0; // 未压缩
  out.set(indices, CWT1_HEADER_BYTES);
  return out;
}

/** 内存适配器：所有数据都在浏览器内存里，不碰任何后端 */
function createMemoryAdapter(): MapHostAdapter {
  const meta: MapMeta = {
    id: "demo-map",
    kind: "canvas",
    board: { width: BOARD_WIDTH, height: BOARD_HEIGHT, projection: "equirect", radiusKm: 6371 },
    revision: 1,
    palette: [
      { index: 1, key: "ocean", name: "海洋", color: "#1d3a4e" },
      { index: 2, key: "shallow", name: "浅海", color: "#2f5a72" },
      { index: 3, key: "grass", name: "草地", color: "#5d7a4a" },
      { index: 4, key: "forest", name: "森林", color: "#3f5c3a" },
      { index: 6, key: "mountain", name: "山地", color: "#7b6a58" },
    ],
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

  // 内存里的「服务器端数据」：缓存瓦片字节与版本号，保存时更新它们
  const cache = new Map<string, Uint8Array>();
  let revision = 1;

  return {
    async loadMeta() {
      return { ...meta, revision };
    },
    async loadTiles(_mapId: string, _layerId: string, coords: TileCoord[]): Promise<(Tile | null)[]> {
      return coords.map((coord) => {
        const key = `${coord.col}:${coord.row}`;
        let bytes = cache.get(key);
        if (!bytes) {
          bytes = packTile(buildTileIndices(coord.col, coord.row));
          cache.set(key, bytes);
        }
        return { coord, format: "cwt1", data: bytes };
      });
    },
    async saveTiles(input) {
      // 真实行为：把变化的瓦片写回「服务器端」，并把版本号 +1
      for (const tile of input.tiles) {
        cache.set(`${tile.coord.col}:${tile.coord.row}`, tile.data);
      }
      revision = input.revision + 1;
      return { revision };
    },
  };
}

/** 挂载示例编辑器 */
function mountDemo(): void {
  const container = document.getElementById("root");
  if (!container) {
    return;
  }
  createRoot(container).render(
    <div style={{ maxWidth: 1100, margin: "0 auto", padding: 20 }}>
      <h1 style={{ fontSize: 20, marginBottom: 4 }}>地图编辑器插件 · 最小宿主示例</h1>
      <p style={{ color: "#a89c88", fontSize: 13, marginTop: 0 }}>
        本页不依赖主站任何模块：只提供一个 mapId、一个内存适配器，编辑器照常运行。
      </p>
      <MapEditor mapId="demo-map" adapter={createMemoryAdapter()} />
    </div>,
  );
}

mountDemo();
