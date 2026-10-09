/**
 * `HttpMapHostAdapter`：把宿主的 REST 接口包装成插件要的 `MapHostAdapter`。
 *
 * 位置说明：这个实现属于**平台适配层**（浏览器侧），所以放在 `@worldmap/editor-web`，
 * 而不是插件本体或内核里 —— 换一个宿主（Tauri / Capacitor）时只需换掉这一个文件。
 */
import {
  createNativeGzip,
  decodeTile,
  encodeTile,
  type BoardSpec,
  type MapHostAdapter,
  type MapLayer,
  type MapMeta,
  type SaveTilesResult,
  type Tile,
  type TileCoord,
} from "@worldmap/core";

/** 宿主 REST 接口的路径模板（默认对应主站 `/api`） */
export interface HttpMapAdapterOptions {
  /** 接口前缀，默认 `/api` */
  baseUrl?: string;
  /** 请求实现；不传则用全局 fetch（把网络访问集中在这里，插件本体内不出现 fetch） */
  request?: (input: string, init?: RequestInit) => Promise<Response>;
}

/** 宿主返回的画布元信息（字段名与主站接口一致） */
interface CanvasMetaResponse {
  id: string;
  name: string;
  kind: string;
  canEdit: boolean;
  board: BoardSpec;
  revision: number;
  palette: MapMeta["palette"];
  layers: MapLayer[];
}

/**
 * 创建走 HTTP 的宿主适配器。
 *
 * 说明：本文件属于**平台实现层**，是整个插件里唯一允许直接访问网络的地方
 * （CI 边界检查对 `packages/map-editor-web` 豁免"不得 fetch"这条规则）。
 * 插件本体与内核仍然只能通过 MapHostAdapter 取数据。
 *
 * @param options 接口前缀与请求实现
 * @returns MapHostAdapter 实例
 */
export function createHttpMapHostAdapter(options: HttpMapAdapterOptions = {}): MapHostAdapter {
  const baseUrl = options.baseUrl ?? "/api";
  // 默认用全局 fetch；调用方可注入自己的请求实现（便于测试与换端）
  const request = options.request ?? ((input, init) => /* 平台层允许 */ fetch(input, init));
  const gzip = createNativeGzip();

  return {
    /** 读取白板元信息 */
    async loadMeta(mapId: string): Promise<MapMeta> {
      const data = await requestJson<CanvasMetaResponse>(request, `${baseUrl}/maps/${mapId}/canvas`);
      return {
        id: data.id,
        kind: "canvas",
        board: data.board,
        revision: data.revision,
        palette: data.palette,
        layers: data.layers,
        canEdit: data.canEdit,
      };
    },

    /** 读取瓦片：服务端返回多段二进制，这里解成插件要的 Tile 列表 */
    async loadTiles(mapId: string, layerId: string, coords: TileCoord[]): Promise<(Tile | null)[]> {
      if (coords.length === 0) {
        return [];
      }
      const cols = [...new Set(coords.map((coord) => coord.col))].join(",");
      const rows = [...new Set(coords.map((coord) => coord.row))].join(",");
      const url = `${baseUrl}/maps/${mapId}/tiles?layer=${encodeURIComponent(layerId)}&cols=${cols}&rows=${rows}`;
      const response = await request(url, { method: "GET" });
      if (!response.ok) {
        throw new Error(`读取瓦片失败（${response.status}）`);
      }
      const buffer = new Uint8Array(await response.arrayBuffer());

      // 服务端按 行优先 展开（外层 rows、内层 cols），与请求参数的展开顺序一致
      const ordered: TileCoord[] = [];
      for (const row of rows.split(",")) {
        for (const col of cols.split(",")) {
          ordered.push({ col: Number(col), row: Number(row) });
        }
      }

      const result: (Tile | null)[] = [];
      let cursor = 0;
      for (const coord of ordered) {
        if (cursor + 4 > buffer.length) {
          result.push(null);
          continue;
        }
        const length = new DataView(buffer.buffer, buffer.byteOffset + cursor, 4).getUint32(0, true);
        cursor += 4;
        if (length === 0) {
          result.push(null);
          continue;
        }
        const data = buffer.subarray(cursor, cursor + length);
        cursor += length;
        result.push({ coord, format: "cwt1", data: await normalizeTileData(data, gzip?.decompressor) });
      }

      // 按调用方传入的顺序返回
      const byKey = new Map(result.map((tile) => [tile ? `${tile.coord.col}:${tile.coord.row}` : "", tile]));
      return coords.map((coord) => byKey.get(`${coord.col}:${coord.row}`) ?? null);
    },

    /** 增量保存瓦片（服务端以 base64 接收二进制） */
    async saveTiles(input: {
      mapId: string;
      layerId: string;
      tiles: Tile[];
      revision: number;
    }): Promise<SaveTilesResult> {
      const tiles = await Promise.all(
        input.tiles.map(async (tile) => ({
          col: tile.coord.col,
          row: tile.coord.row,
          data: bytesToBase64(tile.data),
        })),
      );
      const response = await request(`${baseUrl}/maps/${input.mapId}/tiles`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ layerId: input.layerId, revision: input.revision, tiles }),
      });
      if (response.status === 409) {
        const payload = (await response.json().catch(() => null)) as { data?: { revision?: number } } | null;
        return { revision: payload?.data?.revision ?? input.revision, conflict: true };
      }
      const data = await parseJson<{ revision: number }>(response);
      return { revision: data.revision };
    },

    /** 矢量对象与图层接口首期未实现，缺接口只少能力、不影响 2D 绘制 */
    loadFeatures: undefined,
    saveFeatures: undefined,
    saveLayers: undefined,
  };
}

/**
 * 把服务端字节规整为「未压缩的 cwt1」：
 * 插件首期的同步渲染只处理原始字节，因此这里解压一次并重新打包压缩标识为 0。
 * @param data 服务端字节
 * @param decompressor gzip 解压器（来自 CompressionStream）
 * @returns 未压缩的 cwt1 字节
 */
async function normalizeTileData(
  data: Uint8Array,
  decompressor: { decompress(bytes: Uint8Array): Promise<Uint8Array> } | undefined,
): Promise<Uint8Array> {
  const compression = data[8] ?? 0;
  if (compression === 0) {
    return data;
  }
  if (!decompressor) {
    throw new Error("当前环境不支持解压瓦片（缺少 CompressionStream）");
  }
  const decoded = await decodeTile(data, decompressor);
  const plain = await encodeTile(
    { indices: decoded.indices, width: decoded.width, height: decoded.height },
    null,
  );
  return plain;
}

/**
 * 解析统一响应结构 `{ ok, data, error }`。
 * @param response 响应
 * @returns data 字段
 * @throws 接口返回 ok:false 或网络异常时抛出（中文提示）
 */
async function parseJson<T>(response: Response): Promise<T> {
  const payload = (await response.json().catch(() => null)) as { ok?: boolean; data?: T; error?: string } | null;
  if (!payload || !payload.ok) {
    throw new Error(payload?.error ?? `请求失败（${response.status}）`);
  }
  return payload.data as T;
}

/**
 * 发起请求并解析统一响应。
 * @param request 请求实现
 * @param url 地址
 * @returns data 字段
 */
async function requestJson<T>(
  request: (input: string, init?: RequestInit) => Promise<Response>,
  url: string,
): Promise<T> {
  const response = await request(url, { method: "GET" });
  return parseJson<T>(response);
}

/**
 * 字节转 base64（不能假设环境有 Buffer）。
 * @param bytes 字节
 * @returns base64 文本
 */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
