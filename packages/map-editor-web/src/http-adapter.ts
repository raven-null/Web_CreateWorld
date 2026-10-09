/**
 * `HttpMapHostAdapter`：把宿主的 REST 接口包装成插件要的 `MapHostAdapter`。
 *
 * 位置说明：这个实现属于**平台适配层**（浏览器侧），所以放在 `@worldmap/editor-web`，
 * 而不是插件本体或内核里 —— 换一个宿主（Tauri / Capacitor）时只需换掉这一个文件。
 *
 * 本层是**唯一**允许出现宿主业务字段名（如主站的「条目」概念）与直接访问网络的地方：
 * 协议翻译与网络访问就发生在这里（CI 边界检查对本包豁免这两条规则）。
 * 插件本体与内核仍然只见 `mapId` / `layerId` / `linkRef` 这类中性标识。
 */
import {
  createNativeGzip,
  decodeTile,
  encodeTile,
  type BoardSpec,
  type HostMarker,
  type MapHostAdapter,
  type MapLayer,
  type MapMeta,
  type SaveTilesResult,
  type Tile,
  type TileCoord,
} from "@worldmap/core";

/** 宿主返回的标记行（主站字段名） */
interface HostMarkerResponse {
  id: string;
  x: number;
  y: number;
  label: string;
  entryId: string | null;
  entryTitle: string | null;
}

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

    /** 标记：走主站既有的地图详情 / 标记接口，不需要为画布新增接口 */
    async loadMarkers(mapId: string): Promise<HostMarker[]> {
      // 注意：这里用的是宿主既有的地图详情接口（标记嵌在详情里）
      const detail = await requestJson<{ markers?: HostMarkerResponse[] }>(request, `${baseUrl}/maps/${mapId}`);
      return (detail.markers ?? []).map((row) => ({
        id: row.id,
        u: row.x,
        v: row.y,
        label: row.label,
        // 主站的「条目」概念只在适配器这一层出现，插件侧只看到中性的 linkRef
        linkRef: row.entryId,
        linkLabel: row.entryTitle,
      }));
    },

    async saveMarkerPosition(input: { mapId: string; markerId: string; u: number; v: number }): Promise<void> {
      await requestJson<{ updated: boolean }>(request, `${baseUrl}/markers/${input.markerId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ x: input.u, y: input.v }),
      });
    },

    async createMarker(input: {
      mapId: string;
      u: number;
      v: number;
      label: string;
      linkRef: string | null;
    }): Promise<{ id: string }> {
      return requestJson<{ id: string }>(request, `${baseUrl}/maps/${input.mapId}/markers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ x: input.u, y: input.v, label: input.label, entryId: input.linkRef }),
      });
    },

    async deleteMarker(input: { mapId: string; markerId: string }): Promise<void> {
      await requestJson<{ deleted: boolean }>(request, `${baseUrl}/markers/${input.markerId}`, {
        method: "DELETE",
      });
    },

    /** 改白板尺寸：把重采样后的瓦片按批提交给后端 */
    async resizeBoard(input: {
      mapId: string;
      width: number;
      revision: number;
      first: boolean;
      tiles: { layerId: string; tiles: Tile[] }[];
    }): Promise<{ revision: number }> {
      // 后端单次最多接收 16 个瓦片，这里先把各层瓦片摊平再切块
      const payload: { layerId: string; col: number; row: number; data: string }[] = [];
      for (const group of input.tiles) {
        for (const tile of group.tiles) {
          payload.push({
            layerId: group.layerId,
            col: tile.coord.col,
            row: tile.coord.row,
            data: bytesToBase64(tile.data),
          });
        }
      }

      let revision = input.revision;
      const chunkSize = 16;
      for (let i = 0; i < payload.length; i += chunkSize) {
        const chunk = payload.slice(i, i + chunkSize);
        const result = await requestJson<{ width: number; height: number; firstBatch: boolean }>(
          request,
          `${baseUrl}/maps/${input.mapId}/resize`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ revision, width: input.width, tiles: chunk }),
          },
        );
        // 首批服务端会把 revision +1，之后的批次沿用新版本号
        if (result.firstBatch) {
          revision += 1;
        }
      }
      return { revision };
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
 * @param init 请求选项（方法、请求头、请求体）
 * @returns data 字段
 */
async function requestJson<T>(
  request: (input: string, init?: RequestInit) => Promise<Response>,
  url: string,
  init: RequestInit = { method: "GET" },
): Promise<T> {
  const response = await request(url, init);
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
