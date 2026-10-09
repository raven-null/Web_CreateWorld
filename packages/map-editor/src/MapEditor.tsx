/**
 * 地图编辑器插件的主组件（2D 画布）。
 *
 * 设计约束（方案 §15.1，由 scripts/check-boundaries.mjs 强制）：
 * - 所需状态一律从 props 传入，**不使用 React Context、不读写全局单例**
 *   → 这样将来补一层 Web Component 薄壳就能给任意框架使用
 * - 数据进出全部走 props.adapter（插件自身不直接 fetch）
 * - 颜色只走 theme token，不假设宿主 CSS 变量
 *
 * 首期（M1/T6）实现的是「只读浏览 + 自由缩放平移 + 经纬网」，
 * 用于验证插件能被主站装进来；笔刷绘制在 M2 落地。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CWT1_HEADER_BYTES,
  DEFAULT_TERRAIN_PALETTE,
  isTileEmpty,
  terrainPaletteToUint32,
  type BoardSpec,
  type MapEditorProps,
  type MapEditorTheme,
  type MapMeta,
  type TileCoord,
} from "@worldmap/core";
import { resolveTheme, themeToCssVars } from "./theme";

/** 瓦片边长（与后端一致） */
const TILE_SIZE = 256;
/** 缩放范围（方案 §5.6.1：适应窗口 ~ 32×，自由连续） */
const MIN_ZOOM = 0.05;
const MAX_ZOOM = 32;
/** 经纬网间隔（度） */
const GRATICULE_STEP = 30;

/** 已解码并转成 RGBA 的瓦片 */
interface CachedTile {
  width: number;
  height: number;
  /** 缓冲类型显式写成 ArrayBuffer：ImageData 不接受 SharedArrayBuffer 底层的视图 */
  rgba: Uint8ClampedArray<ArrayBuffer>;
}

/** 视口状态：缩放与平移偏移（单位都是世界像素） */
interface Viewport {
  zoom: number;
  offsetX: number;
  offsetY: number;
}

/**
 * 地图编辑器主组件。
 * @param props 见 `MapEditorProps`
 * @returns 编辑器节点
 */
export function MapEditor(props: MapEditorProps) {
  const { mapId, adapter, readOnly = false } = props;
  const theme = useMemo(() => resolveTheme(props.theme), [props.theme]);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [meta, setMeta] = useState<MapMeta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [viewport, setViewport] = useState<Viewport>({ zoom: 1, offsetX: 0, offsetY: 0 });
  const [loadedCount, setLoadedCount] = useState(0);

  // 瓦片缓存与离屏画布都放在 ref 里：它们是渲染数据，不该触发 React 重渲染
  const tileCacheRef = useRef<Map<string, CachedTile>>(new Map());
  const offscreenRef = useRef<Map<string, HTMLCanvasElement>>(new Map());
  const requestedRef = useRef<Set<string>>(new Set());
  const viewportRef = useRef<Viewport>(viewport);
  const dragRef = useRef<{ x: number; y: number; offsetX: number; offsetY: number } | null>(null);

  viewportRef.current = viewport;

  /** 加载地图元信息 */
  useEffect(() => {
    let cancelled = false;
    setError(null);
    adapter
      .loadMeta(mapId)
      .then((result) => {
        if (cancelled) {
          return;
        }
        setMeta(result);
        // 初始视图：适应窗口
        const container = containerRef.current;
        if (container) {
          const fit = fitViewport(result.board, container.clientWidth, container.clientHeight);
          setViewport(fit);
        }
      })
      .catch((err: Error) => {
        if (!cancelled) {
          setError(err.message);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [mapId, adapter]);

  /** 画布尺寸跟随容器 */
  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) {
      return;
    }
    const observer = new ResizeObserver(() => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.max(1, container.clientWidth);
      const height = Math.max(1, container.clientHeight);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      const context = canvas.getContext("2d");
      if (context) {
        context.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
      setViewport((current) => ({ ...current }));
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  /** 拉取当前视口内缺失的瓦片 */
  useEffect(() => {
    if (!meta) {
      return;
    }
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const cssWidth = canvas.width / Math.min(window.devicePixelRatio || 1, 2);
    const cssHeight = canvas.height / Math.min(window.devicePixelRatio || 1, 2);
    const needed = collectVisibleTiles(meta.board, viewport, cssWidth, cssHeight);
    const missing = needed.filter((coord) => !tileCacheRef.current.has(coordKey(coord)) && !requestedRef.current.has(coordKey(coord)));
    if (missing.length === 0) {
      return;
    }
    for (const coord of missing) {
      requestedRef.current.add(coordKey(coord));
    }
    const layerId = meta.layers.find((layer) => layer.storage === "raster")?.id;
    if (!layerId) {
      return;
    }

    let cancelled = false;
    adapter
      .loadTiles(mapId, layerId, missing)
      .then((tiles) => {
        if (cancelled) {
          return;
        }
        for (const [index, coord] of missing.entries()) {
          const tile = tiles[index];
          if (!tile) {
            continue; // 不存在的瓦片 = 空瓦片
          }
          const decoded = decodeTileBytes(tile.data, meta.board, coord);
          if (decoded) {
            tileCacheRef.current.set(coordKey(coord), decoded);
          }
        }
        setLoadedCount(tileCacheRef.current.size);
      })
      .catch((err: Error) => {
        for (const coord of missing) {
          requestedRef.current.delete(coordKey(coord));
        }
        if (!cancelled) {
          props.onError?.(err);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [meta, viewport, mapId, adapter, props]);

  /** 主渲染：先贴瓦片，再画经纬网 */
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container || !meta) {
      return;
    }
    const context = canvas.getContext("2d");
    if (!context) {
      return;
    }
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cssWidth = canvas.width / dpr;
    const cssHeight = canvas.height / dpr;

    context.save();
    context.fillStyle = "#0f1a24"; // 未绘制区域：深水色底
    context.fillRect(0, 0, cssWidth, cssHeight);

    const { zoom, offsetX, offsetY } = viewport;
    const smoothing = zoom < 1;
    context.imageSmoothingEnabled = smoothing;

    for (const [key, tile] of tileCacheRef.current) {
      const [colText, rowText] = key.split(":");
      const col = Number(colText);
      const row = Number(rowText);
      if (!Number.isFinite(col) || !Number.isFinite(row)) {
        continue;
      }
      const tileScreenX = col * TILE_SIZE * zoom - offsetX * zoom;
      const tileScreenY = row * TILE_SIZE * zoom - offsetY * zoom;
      const tileScreenSize = TILE_SIZE * zoom;
      // 视口外直接跳过
      if (
        tileScreenX + tileScreenSize < 0 ||
        tileScreenY + tileScreenSize < 0 ||
        tileScreenX > cssWidth ||
        tileScreenY > cssHeight
      ) {
        continue;
      }
      const offscreen = getOffscreenCanvas(key, tile, offscreenRef.current);
      context.drawImage(offscreen, tileScreenX, tileScreenY, tileScreenSize, tileScreenSize);
    }

    // 经纬网：每 30° 一条，缩放足够大时才画
    if (zoom >= 0.3) {
      context.strokeStyle = "rgba(232, 224, 211, 0.12)";
      context.lineWidth = 1;
      context.beginPath();
      for (let lon = -180; lon <= 180; lon += GRATICULE_STEP) {
        const worldX = ((lon + 180) / 360) * meta.board.width;
        const screenX = worldX * zoom - offsetX * zoom;
        if (screenX < 0 || screenX > cssWidth) {
          continue;
        }
        context.moveTo(screenX, 0);
        context.lineTo(screenX, cssHeight);
      }
      for (let lat = -90; lat <= 90; lat += GRATICULE_STEP) {
        const worldY = ((90 - lat) / 180) * meta.board.height;
        const screenY = worldY * zoom - offsetY * zoom;
        if (screenY < 0 || screenY > cssHeight) {
          continue;
        }
        context.moveTo(0, screenY);
        context.lineTo(cssWidth, screenY);
      }
      context.stroke();
    }

    context.restore();
  }, [meta, viewport, loadedCount]);

  /** 滚轮缩放（以光标为锚点） */
  const handleWheel = useCallback((event: React.WheelEvent<HTMLCanvasElement>) => {
    event.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const cursorX = event.clientX - rect.left;
    const cursorY = event.clientY - rect.top;
    setViewport((current) => {
      const factor = event.deltaY < 0 ? 1.15 : 1 / 1.15;
      const nextZoom = clamp(current.zoom * factor, MIN_ZOOM, MAX_ZOOM);
      // 光标下的世界点保持不动
      const worldX = current.offsetX + cursorX / current.zoom;
      const worldY = current.offsetY + cursorY / current.zoom;
      return {
        zoom: nextZoom,
        offsetX: worldX - cursorX / nextZoom,
        offsetY: worldY - cursorY / nextZoom,
      };
    });
  }, []);

  /** 拖拽平移 */
  const handlePointerDown = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      x: event.clientX,
      y: event.clientY,
      offsetX: viewportRef.current.offsetX,
      offsetY: viewportRef.current.offsetY,
    };
  }, []);

  const handlePointerMove = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (!drag) {
      return;
    }
    const zoom = viewportRef.current.zoom;
    setViewport((current) => ({
      ...current,
      offsetX: drag.offsetX - (event.clientX - drag.x) / zoom,
      offsetY: drag.offsetY - (event.clientY - drag.y) / zoom,
    }));
  }, []);

  const handlePointerUp = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  /** 适应窗口 */
  const handleFit = useCallback(() => {
    const container = containerRef.current;
    if (!container || !meta) {
      return;
    }
    setViewport(fitViewport(meta.board, container.clientWidth, container.clientHeight));
  }, [meta]);

  const zoomPercent = Math.round(viewport.zoom * 100);

  return (
    <div
      style={{
        ...themeToCssVars(theme),
        display: "flex",
        flexDirection: "column",
        gap: 8,
        fontFamily: theme.fontSans,
        color: theme.text,
      }}
    >
      {/* 顶部动作栏 */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          flexWrap: "wrap",
          padding: "8px 10px",
          background: theme.panel,
          border: `1px solid ${theme.border}`,
          borderRadius: theme.radius,
          fontSize: 13,
        }}
      >
        <span>{meta?.layers.find((layer) => layer.storage === "raster")?.name ?? "地形"}</span>
        <span style={{ color: theme.textFaint }}>
          {meta ? `${meta.board.width}×${meta.board.height}` : "加载中…"}
        </span>
        <span style={{ marginLeft: "auto", color: theme.textDim }}>{zoomPercent}%</span>
        <button type="button" onClick={handleFit} style={buttonStyle(theme)}>
          适应窗口
        </button>
        <button
          type="button"
          onClick={() => setViewport((current) => ({ ...current, zoom: clamp(current.zoom * 2, MIN_ZOOM, MAX_ZOOM) }))}
          style={buttonStyle(theme)}
        >
          放大
        </button>
        <button
          type="button"
          onClick={() => setViewport((current) => ({ ...current, zoom: clamp(current.zoom / 2, MIN_ZOOM, MAX_ZOOM) }))}
          style={buttonStyle(theme)}
        >
          缩小
        </button>
        {readOnly && <span style={{ color: theme.textFaint }}>只读</span>}
      </div>

      {/* 画布 */}
      <div
        ref={containerRef}
        style={{
          position: "relative",
          height: 520,
          border: `1px solid ${theme.border}`,
          borderRadius: theme.radius,
          overflow: "hidden",
          background: theme.background,
        }}
      >
        <canvas
          ref={canvasRef}
          onWheel={handleWheel}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          style={{
            display: "block",
            width: "100%",
            height: "100%",
            cursor: dragRef.current ? "grabbing" : "grab",
            // 关键：否则移动端拖拽会变成页面滚动（方案 §12.3）
            touchAction: "none",
          }}
        />
        {error && (
          <div style={overlayStyle(theme)}>
            <span style={{ color: "#c25e5e" }}>{error}</span>
          </div>
        )}
        {!meta && !error && <div style={overlayStyle(theme)}>正在加载白板…</div>}
      </div>

      {/* 底部信息条 */}
      <div
        style={{
          display: "flex",
          gap: 12,
          flexWrap: "wrap",
          fontSize: 12,
          color: theme.textFaint,
        }}
      >
        <span>缩放 {zoomPercent}%</span>
        <span>已载入瓦片 {loadedCount}</span>
        <span>滚轮缩放 · 拖拽平移</span>
        {readOnly && <span>无编辑权限</span>}
      </div>
    </div>
  );
}

/**
 * 计算「适应窗口」的视口。
 * @param board 白板规格
 * @param viewWidth 容器宽（css 像素）
 * @param viewHeight 容器高（css 像素）
 * @returns 视口状态
 */
function fitViewport(board: BoardSpec, viewWidth: number, viewHeight: number): Viewport {
  if (viewWidth <= 0 || viewHeight <= 0) {
    return { zoom: 1, offsetX: 0, offsetY: 0 };
  }
  const zoom = clamp(Math.min(viewWidth / board.width, viewHeight / board.height), MIN_ZOOM, MAX_ZOOM);
  return {
    zoom,
    // 居中：偏移让白板中心对齐视口中心
    offsetX: board.width / 2 - viewWidth / 2 / zoom,
    offsetY: board.height / 2 - viewHeight / 2 / zoom,
  };
}

/**
 * 收集当前视口内需要的瓦片坐标（含经度环绕）。
 * @param board 白板规格
 * @param viewport 视口
 * @param viewWidth 视口宽
 * @param viewHeight 视口高
 * @returns 瓦片坐标列表
 */
function collectVisibleTiles(
  board: BoardSpec,
  viewport: Viewport,
  viewWidth: number,
  viewHeight: number,
): TileCoord[] {
  const cols = Math.ceil(board.width / TILE_SIZE);
  const rows = Math.ceil(board.height / TILE_SIZE);
  const { zoom, offsetX, offsetY } = viewport;

  const startCol = Math.floor(offsetX / TILE_SIZE) - 1;
  const endCol = Math.floor((offsetX + viewWidth / zoom) / TILE_SIZE) + 1;
  const startRow = Math.max(0, Math.floor(offsetY / TILE_SIZE));
  const endRow = Math.min(rows - 1, Math.floor((offsetY + viewHeight / zoom) / TILE_SIZE));

  const result: TileCoord[] = [];
  for (let row = startRow; row <= endRow; row += 1) {
    for (let rawCol = startCol; rawCol <= endCol; rawCol += 1) {
      // 列环绕：经度方向首尾相连
      const col = ((rawCol % cols) + cols) % cols;
      result.push({ col, row });
    }
  }
  return result;
}

/**
 * 把服务端字节解码成 RGBA 瓦片。
 * @param bytes cwt1 字节
 * @param board 白板规格（用于算出边缘瓦片的实际尺寸）
 * @param coord 瓦片坐标
 * @returns 解码结果；失败返回 null
 */
function decodeTileBytes(bytes: Uint8Array, board: BoardSpec, coord: TileCoord): CachedTile | null {
  try {
    const width = Math.min(TILE_SIZE, board.width - coord.col * TILE_SIZE);
    const height = Math.min(TILE_SIZE, board.height - coord.row * TILE_SIZE);
    if (width <= 0 || height <= 0) {
      return null;
    }
    const indices = decodeTileSync(bytes, width, height);
    if (!indices) {
      return null;
    }
    if (isTileEmpty(indices)) {
      return null; // 空瓦片不缓存，也不绘制
    }
    return { width, height, rgba: indicesToRgba(indices) };
  } catch {
    return null;
  }
}

/**
 * 同步解码：本插件在浏览器环境里数据都是未压缩（或已由适配器解压）的，
 * 因此这里只处理原始字节分支；遇到 gzip 数据交给调用方（适配器）处理。
 * @param bytes cwt1 字节
 * @param width 期望宽
 * @param height 期望高
 * @returns 索引数组；不匹配返回 null
 */
function decodeTileSync(bytes: Uint8Array, width: number, height: number): Uint8Array | null {
  if (bytes.length < CWT1_HEADER_BYTES + width * height) {
    return null;
  }
  const compression = bytes[8] ?? 0;
  if (compression !== 0) {
    return null; // 压缩数据需异步解压，首期适配器会传未压缩字节
  }
  const payload = bytes.subarray(CWT1_HEADER_BYTES, CWT1_HEADER_BYTES + width * height);
  return new Uint8Array(payload);
}

/**
 * 索引栅格转 RGBA 像素数据（用 Uint32 视图一次写入，比逐像素快一个量级）。
 * 调色板在模块加载时转成 Uint32 查表，避免每像素解析颜色字符串。
 *
 * 返回类型显式写成 `Uint8ClampedArray<ArrayBuffer>`：TS 5.9 的默认泛型是
 * `ArrayBufferLike`（可能是 SharedArrayBuffer），而 `ImageData` 只接受普通 ArrayBuffer。
 *
 * @param indices 调色板索引
 * @returns RGBA 字节
 */
function indicesToRgba(indices: Uint8Array): Uint8ClampedArray<ArrayBuffer> {
  const rgba = new Uint8ClampedArray(new ArrayBuffer(indices.length * 4));
  const view = new Uint32Array(rgba.buffer);
  for (let i = 0; i < indices.length; i += 1) {
    const value = indices[i] ?? 0;
    if (value === 0) {
      view[i] = 0; // 透明
      continue;
    }
    const packed = PALETTE_UINT32[value];
    view[i] = packed === undefined ? 0xff000000 : packed | 0xff000000;
  }
  return rgba;
}

/** 调色板查表：下标 → 0xAABBGGRR（小端写入时的字节顺序为 R,G,B,A） */
const PALETTE_UINT32: number[] = terrainPaletteToUint32(DEFAULT_TERRAIN_PALETTE);

/**
 * 取得（或创建）瓦片的离屏画布。
 * @param key 瓦片键
 * @param tile 已解码瓦片
 * @param store 离屏画布缓存
 * @returns 离屏画布
 */
function getOffscreenCanvas(key: string, tile: CachedTile, store: Map<string, HTMLCanvasElement>): HTMLCanvasElement {
  const cached = store.get(key);
  if (cached) {
    return cached;
  }
  const canvas = document.createElement("canvas");
  canvas.width = tile.width;
  canvas.height = tile.height;
  const context = canvas.getContext("2d");
  if (context) {
    context.putImageData(new ImageData(tile.rgba, tile.width, tile.height), 0, 0);
  }
  store.set(key, canvas);
  return canvas;
}

/** 瓦片键 */
function coordKey(coord: TileCoord): string {
  return `${coord.col}:${coord.row}`;
}

/**
 * 数值区间限制。
 * @param value 输入
 * @param min 下限
 * @param max 上限
 * @returns 限制后的值
 */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 按钮样式（用主题 token，不依赖宿主 CSS） */
function buttonStyle(theme: MapEditorTheme): React.CSSProperties {
  return {
    background: "transparent",
    color: theme.text,
    border: `1px solid ${theme.border}`,
    borderRadius: theme.radius,
    padding: "4px 10px",
    fontSize: 13,
    cursor: "pointer",
  };
}

/** 画布上的浮层样式 */
function overlayStyle(theme: MapEditorTheme): React.CSSProperties {
  return {
    position: "absolute",
    inset: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: `${theme.background}cc`,
    fontSize: 13,
    color: theme.textDim,
    pointerEvents: "none",
  };
}
