/**
 * 地图编辑器插件的主组件：2D 画布 + 地形绘制。
 *
 * 设计约束（方案 §15.1，由 scripts/check-boundaries.mjs 强制）：
 * - 所需状态一律从 props 传入，**不使用 React Context、不读写全局单例**
 *   → 这样将来补一层 Web Component 薄壳就能给任意框架使用
 * - 数据进出全部走 props.adapter（插件自身不直接 fetch）
 * - 颜色只走 theme token，不假设宿主 CSS 变量
 *
 * 渲染结构：离屏全幅底图 + 主画布逐帧拷贝。绘制时只更新离屏底图的**脏区域**，
 * 主画布每帧从底图拷贝可见部分并叠加经纬网与笔刷光标 —— 这样缩放平移流畅，
 * 落笔也不会引发全幅重建。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_TERRAIN_PALETTE,
  terrainPaletteToUint32,
  type MapEditorProps,
  type MapEditorTheme,
  type MapMeta,
  type SaveState,
  type TerrainBrush,
} from "@worldmap/core";
import {
  DEFAULT_BRUSH,
  MAX_BRUSH_SCREEN_SIZE,
  MIN_BRUSH_SCREEN_SIZE,
  brushRect,
  clampBrushSize,
  interpolatePointerPath,
  paintRect,
  unionRect,
  type BrushSettings,
} from "./brush-engine";
import { HistoryStack } from "./history";
import { RasterTileStore, TILE_SIZE, tileRangeOf, type PixelRect } from "./tile-store";
import { resolveTheme, themeToCssVars } from "./theme";

/** 缩放范围：适应窗口 ~ 32×，自由连续（方案 §5.6.1） */
const MIN_ZOOM = 0.05;
const MAX_ZOOM = 32;
/** 经纬网间隔（度） */
const GRATICULE_STEP = 30;
/** 停止绘制后自动保存的延迟（毫秒） */
const IDLE_SAVE_DELAY = 3000;
/** 单次保存最多提交的瓦片数（与后端上限一致） */
const MAX_TILES_PER_SAVE = 16;

/** 视口状态：缩放与平移偏移（世界像素） */
interface Viewport {
  zoom: number;
  offsetX: number;
  offsetY: number;
}

/** 调色板查表（模块级一次生成） */
const PALETTE_UINT32 = terrainPaletteToUint32(DEFAULT_TERRAIN_PALETTE);

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
  const offscreenRef = useRef<HTMLCanvasElement | null>(null);
  const storeRef = useRef<RasterTileStore | null>(null);
  const historyRef = useRef(new HistoryStack());
  const viewportRef = useRef<Viewport>({ zoom: 1, offsetX: 0, offsetY: 0 });
  const brushRef = useRef<BrushSettings>({ ...DEFAULT_BRUSH });
  const paintingRef = useRef(false);
  /** 当前笔画是否为擦除（右键或橡皮），移动时沿用 */
  const erasingRef = useRef(false);
  /** 上一次落点的屏幕坐标，用于在两点间补点 */
  const lastPaintRef = useRef<{ x: number; y: number } | null>(null);
  const panRef = useRef<{ x: number; y: number; offsetX: number; offsetY: number } | null>(null);
  const cursorRef = useRef<{ x: number; y: number } | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  const metaRef = useRef<MapMeta | null>(null);

  const [meta, setMeta] = useState<MapMeta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [viewport, setViewport] = useState<Viewport>({ zoom: 1, offsetX: 0, offsetY: 0 });
  const [brush, setBrush] = useState<BrushSettings>({ ...DEFAULT_BRUSH });
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [dirtyCount, setDirtyCount] = useState(0);
  const [historyTick, setHistoryTick] = useState(0);
  const [palette, setPalette] = useState<TerrainBrush[]>(DEFAULT_TERRAIN_PALETTE);
  const [panelOpen, setPanelOpen] = useState(false);

  viewportRef.current = viewport;
  brushRef.current = brush;
  metaRef.current = meta;

  /** 载入元信息与栅格图层 */
  useEffect(() => {
    let cancelled = false;
    setError(null);
    setSaveState("idle");

    void (async () => {
      try {
        const result = await adapter.loadMeta(mapId);
        if (cancelled) {
          return;
        }
        setMeta(result);
        metaRef.current = result;
        if (result.palette.length > 0) {
          setPalette(result.palette);
        }

        const rasterLayer = result.layers.find((layer) => layer.storage === "raster");
        if (rasterLayer) {
          const store = new RasterTileStore({
            adapter,
            mapId,
            layerId: rasterLayer.id,
            width: result.board.width,
            height: result.board.height,
            palette: result.palette,
          });
          await store.load();
          if (cancelled) {
            return;
          }
          storeRef.current = store;
          historyRef.current.clear();
          setDirtyCount(0);
        }

        // 底图尺寸就绪后按「适应窗口」落位
        const container = containerRef.current;
        if (container) {
          setViewport(fitViewport(result.board.width, result.board.height, container.clientWidth, container.clientHeight));
        }
        rebuildOffscreen();
        setHistoryTick((tick) => tick + 1);
      } catch (err) {
        if (!cancelled) {
          setError((err as Error).message);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapId, adapter]);

  /** 主画布尺寸跟随容器（并处理高 DPI） */
  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) {
      return;
    }
    const applySize = (): void => {
      const dpr = devicePixelRatioNow();
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
    };
    applySize();
    const observer = new ResizeObserver(applySize);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  /** 重建离屏底图（仅在栅格整体变化时调用：初次载入、撤销重做后） */
  const rebuildOffscreen = useCallback((): void => {
    const store = storeRef.current;
    const metaValue = metaRef.current;
    if (!store || !metaValue) {
      return;
    }
    let canvas = offscreenRef.current;
    if (!canvas) {
      canvas = document.createElement("canvas");
      offscreenRef.current = canvas;
    }
    canvas.width = store.width;
    canvas.height = store.height;
    const context = canvas.getContext("2d");
    if (!context) {
      return;
    }
    const imageData = buildImageData(store.indices, 0, 0, store.width, store.height, store.width);
    context.putImageData(imageData, 0, 0);
  }, []);

  /**
   * 局部更新离屏底图（一次落笔后只重画受影响的矩形）。
   * @param rect 世界像素矩形
   */
  const refreshOffscreen = useCallback((rect: PixelRect): void => {
    const store = storeRef.current;
    const canvas = offscreenRef.current;
    if (!store || !canvas) {
      return;
    }
    const context = canvas.getContext("2d");
    if (!context) {
      return;
    }
    const imageData = buildImageData(store.indices, rect.x, rect.y, rect.width, rect.height, store.width);
    context.putImageData(imageData, rect.x, rect.y);
  }, []);

  /** 主动保存（把脏瓦片提交给宿主） */
  const saveNow = useCallback(async (): Promise<void> => {
    const store = storeRef.current;
    const metaValue = metaRef.current;
    if (!store || !metaValue || readOnly) {
      return;
    }
    if (store.dirtyCount === 0) {
      setSaveState("saved");
      return;
    }
    const layerId = metaValue.layers.find((layer) => layer.storage === "raster")?.id;
    if (!layerId) {
      return;
    }

    setSaveState("saving");
    const tiles = await store.takeDirtyTiles();
    if (tiles.length === 0) {
      // 脏瓦片其实与服务器端一致（例如涂了又擦回），直接收工
      store.clearDirtyAsBaseline();
      setDirtyCount(store.dirtyCount);
      setSaveState("saved");
      return;
    }

    try {
      let revision = metaValue.revision;
      for (let i = 0; i < tiles.length; i += MAX_TILES_PER_SAVE) {
        const chunk = tiles.slice(i, i + MAX_TILES_PER_SAVE);
        let result = await adapter.saveTiles({ mapId, layerId, tiles: chunk, revision });
        if (result.conflict) {
          // 版本冲突：用服务端最新版本重试一次，避免刚画的改动白费
          result = await adapter.saveTiles({ mapId, layerId, tiles: chunk, revision: result.revision });
          if (result.conflict) {
            throw new Error("地图已在别处被修改，请重新加载后再画");
          }
        }
        revision = result.revision;
        // 只有真正保存成功才更新基线
        store.commitBaseline(chunk.map((tile) => tile.coord));
      }
      setDirtyCount(store.dirtyCount);
      setMeta((current) => (current ? { ...current, revision } : current));
      if (metaRef.current) {
        metaRef.current = { ...metaRef.current, revision };
      }
      setSaveState("saved");
      props.onSaveStateChange?.("saved");
      props.onDirtyChange?.(false);
    } catch (err) {
      // 保存失败：瓦片仍是脏的，不丢本地内容
      setDirtyCount(store.dirtyCount);
      setSaveState("error");
      props.onSaveStateChange?.("error");
      props.onError?.(err as Error);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adapter, mapId, readOnly, props]);

  /** 安排一次空闲自动保存（停止绘制 3 秒后） */
  const scheduleAutoSave = useCallback((): void => {
    if (readOnly) {
      return;
    }
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
    }
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null;
      void saveNow();
    }, IDLE_SAVE_DELAY);
  }, [readOnly, saveNow]);

  // 卸载时清掉待触发的自动保存
  useEffect(() => {
    return () => {
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
      }
    };
  }, []);

  /** 主渲染循环：只读底图 + 经纬网 + 笔刷光标 */
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    const store = storeRef.current;
    if (!canvas || !container) {
      return;
    }
    const context = canvas.getContext("2d");
    if (!context) {
      return;
    }
    const dpr = devicePixelRatioNow();
    const cssWidth = canvas.width / dpr;
    const cssHeight = canvas.height / dpr;
    const { zoom, offsetX, offsetY } = viewport;

    context.save();
    context.fillStyle = theme.background;
    context.fillRect(0, 0, cssWidth, cssHeight);

    const offscreen = offscreenRef.current;
    if (offscreen) {
      context.imageSmoothingEnabled = zoom < 1;
      context.drawImage(
        offscreen,
        -offsetX * zoom,
        -offsetY * zoom,
        offscreen.width * zoom,
        offscreen.height * zoom,
      );
    }

    if (store && zoom >= 0.3) {
      context.strokeStyle = "rgba(232, 224, 211, 0.10)";
      context.lineWidth = 1;
      context.beginPath();
      for (let lon = -180; lon <= 180; lon += GRATICULE_STEP) {
        const worldX = ((lon + 180) / 360) * store.width;
        const screenX = (worldX - offsetX) * zoom;
        if (screenX < 0 || screenX > cssWidth) {
          continue;
        }
        context.moveTo(screenX, 0);
        context.lineTo(screenX, cssHeight);
      }
      for (let lat = -90; lat <= 90; lat += GRATICULE_STEP) {
        const worldY = ((90 - lat) / 180) * store.height;
        const screenY = (worldY - offsetY) * zoom;
        if (screenY < 0 || screenY > cssHeight) {
          continue;
        }
        context.moveTo(0, screenY);
        context.lineTo(cssWidth, screenY);
      }
      context.stroke();

      // 笔刷光标：画一个方块预览（与真实落笔范围一致）
      const cursor = cursorRef.current;
      const currentBrush = brushRef.current;
      if (cursor && currentBrush.tool !== "pan") {
        const rect = brushRect(
          offsetX + cursor.x / zoom,
          offsetY + cursor.y / zoom,
          currentBrush.screenSize,
          zoom,
          store.width,
          store.height,
        );
        if (rect) {
          const size = Math.max(2, rect.width * zoom);
          context.strokeStyle = currentBrush.tool === "picker" ? "#ffffff" : theme.accent;
          context.lineWidth = 1;
          context.strokeRect((rect.x - offsetX) * zoom, (rect.y - offsetY) * zoom, size, size);
        }
      }
    }

    context.restore();
  }, [viewport, theme, meta, historyTick, saveState]);

  /** 屏幕坐标 → 世界像素 */
  const toWorld = useCallback((screenX: number, screenY: number): { x: number; y: number } => {
    const { zoom, offsetX, offsetY } = viewportRef.current;
    return { x: offsetX + screenX / zoom, y: offsetY + screenY / zoom };
  }, []);

  /**
   * 在指定屏幕坐标落笔。
   * @param screenX 屏幕 x
   * @param screenY 屏幕 y
   * @param forcedValue 强制写入的调色板下标（右键擦除传 0）；不传则按当前工具决定
   */
  const paintAt = useCallback(
    (screenX: number, screenY: number, forcedValue?: number): void => {
      const store = storeRef.current;
      if (!store || readOnly) {
        return;
      }
      const world = toWorld(screenX, screenY);
      const currentBrush = brushRef.current;
      const rect = brushRect(
        world.x,
        world.y,
        currentBrush.screenSize,
        viewportRef.current.zoom,
        store.width,
        store.height,
      );
      if (!rect) {
        return;
      }

      const value =
        forcedValue !== undefined
          ? forcedValue
          : currentBrush.tool === "eraser"
            ? 0
            : currentBrush.terrainIndex;
      const before = store.readRect(rect);
      paintRect(store.indices, store.width, rect, value);
      const after = store.readRect(rect);

      historyRef.current.record(rect, before, after);
      store.markDirty(rect);
      refreshOffscreen(outerRect(rect, store.width, store.height));
      setDirtyCount(store.dirtyCount);
      props.onDirtyChange?.(true);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [readOnly, toWorld, refreshOffscreen, props],
  );

  /** 撤销一步 */
  const undo = useCallback((): void => {
    const store = storeRef.current;
    const entry = historyRef.current.peekUndo();
    if (!store || !entry) {
      return;
    }
    store.writeRect(entry.rect, entry.before);
    historyRef.current.confirmUndo();
    rebuildOffscreen();
    setDirtyCount(store.dirtyCount);
    setHistoryTick((tick) => tick + 1);
    scheduleAutoSave();
  }, [rebuildOffscreen, scheduleAutoSave]);

  /** 重做一步 */
  const redo = useCallback((): void => {
    const store = storeRef.current;
    const entry = historyRef.current.peekRedo();
    if (!store || !entry) {
      return;
    }
    store.writeRect(entry.rect, entry.after);
    historyRef.current.confirmRedo();
    rebuildOffscreen();
    setDirtyCount(store.dirtyCount);
    setHistoryTick((tick) => tick + 1);
    scheduleAutoSave();
  }, [rebuildOffscreen, scheduleAutoSave]);

  /** 指针按下：按当前工具决定绘制 / 取色 / 平移 */
  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      const store = storeRef.current;
      if (!store) {
        return;
      }
      const rect = event.currentTarget.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      const tool = brushRef.current.tool;
      // 中键或空格由 pan 工具表示；右键一律擦除
      const isErase = event.button === 2 || tool === "eraser";

      if (tool === "pan" || event.button === 1) {
        event.currentTarget.setPointerCapture(event.pointerId);
        panRef.current = {
          x: event.clientX,
          y: event.clientY,
          offsetX: viewportRef.current.offsetX,
          offsetY: viewportRef.current.offsetY,
        };
        return;
      }
      if (readOnly) {
        // 只读模式仍允许拖拽浏览
        event.currentTarget.setPointerCapture(event.pointerId);
        panRef.current = {
          x: event.clientX,
          y: event.clientY,
          offsetX: viewportRef.current.offsetX,
          offsetY: viewportRef.current.offsetY,
        };
        return;
      }
      if (tool === "picker") {
        const world = toWorld(x, y);
        const sampled = store.sampleAt(Math.floor(world.x), Math.floor(world.y));
        if (sampled > 0) {
          setBrush((current) => ({ ...current, terrainIndex: sampled }));
        }
        return;
      }

      event.currentTarget.setPointerCapture(event.pointerId);
      paintingRef.current = true;
      erasingRef.current = isErase;
      lastPaintRef.current = null;
      historyRef.current.begin(isErase ? "橡皮" : "笔刷");
      // 右键擦除：强制写入 0，不动用当前选中的地形
      paintAt(x, y, isErase ? 0 : undefined);
      lastPaintRef.current = { x, y };
    },
    [paintAt, readOnly, toWorld],
  );

  /** 指针移动：绘制 / 平移 / 更新光标 */
  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      const rect = event.currentTarget.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      cursorRef.current = { x, y };

      const pan = panRef.current;
      if (pan) {
        const zoom = viewportRef.current.zoom;
        setViewport((current) => ({
          ...current,
          offsetX: pan.offsetX - (event.clientX - pan.x) / zoom,
          offsetY: pan.offsetY - (event.clientY - pan.y) / zoom,
        }));
        return;
      }

      // 未按下时只刷新光标预览
      if (!paintingRef.current) {
        drawCursorOnly();
        return;
      }
      // 绘制中：在上一落点与当前点之间补点，避免快速拖动出现断线
      const last = lastPaintRef.current;
      const forced = erasingRef.current ? 0 : undefined;
      if (last) {
        const step = Math.max(1, brushRef.current.screenSize / 2);
        for (const point of interpolatePointerPath(last, { x, y }, step)) {
          paintAt(point.x, point.y, forced);
        }
      } else {
        paintAt(x, y, forced);
      }
      lastPaintRef.current = { x, y };
      drawCursorOnly();
    },
    [paintAt],
  );

  /** 指针抬起：结束一步笔画 */
  const handlePointerUp = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      const hadPan = panRef.current !== null;
      panRef.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      if (paintingRef.current) {
        paintingRef.current = false;
        erasingRef.current = false;
        lastPaintRef.current = null;
        historyRef.current.commit();
        setHistoryTick((tick) => tick + 1);
        scheduleAutoSave();
      } else if (hadPan) {
        // 平移不需要保存
      }
    },
    [scheduleAutoSave],
  );

  /** 滚轮缩放（以光标为锚点） */
  const handleWheel = useCallback((event: React.WheelEvent<HTMLCanvasElement>) => {
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
      const worldX = current.offsetX + cursorX / current.zoom;
      const worldY = current.offsetY + cursorY / current.zoom;
      return {
        zoom: nextZoom,
        offsetX: worldX - cursorX / nextZoom,
        offsetY: worldY - cursorY / nextZoom,
      };
    });
  }, []);

  /** 只重绘主画布（光标移动等轻量更新） */
  const drawCursorOnly = useCallback((): void => {
    setHistoryTick((tick) => tick + 1);
  }, []);

  /** 适应窗口 */
  const handleFit = useCallback((): void => {
    const container = containerRef.current;
    const store = storeRef.current;
    if (!container || !store) {
      return;
    }
    setViewport(fitViewport(store.width, store.height, container.clientWidth, container.clientHeight));
  }, []);

  /** 快捷键：B / E / I / V、Ctrl+Z、Ctrl+Shift+Z、Ctrl+S */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) {
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) {
          redo();
        } else {
          undo();
        }
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void saveNow();
        return;
      }
      const key = event.key.toLowerCase();
      if (key === "b") {
        setBrush((current) => ({ ...current, tool: "brush" }));
      } else if (key === "e") {
        setBrush((current) => ({ ...current, tool: "eraser" }));
      } else if (key === "i") {
        setBrush((current) => ({ ...current, tool: "picker" }));
      } else if (key === "v") {
        setBrush((current) => ({ ...current, tool: "pan" }));
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [undo, redo, saveNow]);

  const zoomPercent = Math.round(viewport.zoom * 100);
  const canUndo = historyRef.current.undoCount > 0;
  const canRedo = historyRef.current.redoCount > 0;
  const saving = saveState === "saving";

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
      <div style={{ ...barStyle(theme), flexWrap: "wrap" }}>
        <ToolButton
          theme={theme}
          active={brush.tool === "brush"}
          label="笔刷 (B)"
          onClick={() => setBrush((current) => ({ ...current, tool: "brush" }))}
        />
        <ToolButton
          theme={theme}
          active={brush.tool === "eraser"}
          label="橡皮 (E)"
          onClick={() => setBrush((current) => ({ ...current, tool: "eraser" }))}
        />
        <ToolButton
          theme={theme}
          active={brush.tool === "picker"}
          label="吸管 (I)"
          onClick={() => setBrush((current) => ({ ...current, tool: "picker" }))}
        />
        <ToolButton
          theme={theme}
          active={brush.tool === "pan"}
          label="平移 (V)"
          onClick={() => setBrush((current) => ({ ...current, tool: "pan" }))}
        />
        <span style={dividerStyle(theme)} />
        <span style={{ fontSize: 12, color: theme.textDim }}>笔刷</span>
        <input
          type="range"
          min={MIN_BRUSH_SCREEN_SIZE}
          max={MAX_BRUSH_SCREEN_SIZE}
          value={brush.screenSize}
          onChange={(event) =>
            setBrush((current) => ({ ...current, screenSize: clampBrushSize(Number(event.target.value)) }))
          }
          style={{ width: 110 }}
        />
        <span style={{ fontSize: 12, color: theme.textFaint, minWidth: 32 }}>{brush.screenSize}px</span>
        <span style={dividerStyle(theme)} />
        <ToolButton theme={theme} label="撤销" disabled={!canUndo} onClick={undo} />
        <ToolButton theme={theme} label="重做" disabled={!canRedo} onClick={redo} />
        <span style={dividerStyle(theme)} />
        <ToolButton theme={theme} label="适应" onClick={handleFit} />
        <span style={{ marginLeft: "auto", fontSize: 12, color: theme.textDim }}>{zoomPercent}%</span>
        {!readOnly && (
          <ToolButton
            theme={theme}
            label={saving ? "保存中…" : "保存"}
            disabled={saving || dirtyCount === 0}
            onClick={() => void saveNow()}
          />
        )}
      </div>

      {/* 地形调色板 */}
      {!readOnly && (
        <div style={{ ...barStyle(theme), flexWrap: "wrap" }}>
          <span style={{ fontSize: 12, color: theme.textDim }}>地形</span>
          {palette.map((brushItem) => (
            <button
              key={brushItem.index}
              type="button"
              title={brushItem.name}
              onClick={() => setBrush((current) => ({ ...current, terrainIndex: brushItem.index, tool: "brush" }))}
              style={{
                width: 30,
                height: 24,
                borderRadius: theme.radius,
                background: brushItem.color,
                border:
                  brush.terrainIndex === brushItem.index && brush.tool !== "picker"
                    ? `2px solid ${theme.accent}`
                    : `1px solid ${theme.border}`,
                cursor: "pointer",
              }}
            />
          ))}
          <span style={{ fontSize: 12, color: theme.textFaint }}>
            {palette.find((item) => item.index === brush.terrainIndex)?.name ?? "—"}
          </span>
        </div>
      )}

      {/* 画布 */}
      <div
        ref={containerRef}
        style={{
          position: "relative",
          // 固定工作区高度：编辑器是全屏工作区（方案 §12.4）
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
          onPointerLeave={() => {
            cursorRef.current = null;
            drawCursorOnly();
          }}
          onContextMenu={(event) => event.preventDefault()}
          style={{
            display: "block",
            width: "100%",
            height: "100%",
            cursor: brush.tool === "pan" ? "grab" : "crosshair",
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
        <button
          type="button"
          onClick={() => setPanelOpen((open) => !open)}
          style={{ ...buttonStyle(theme), position: "absolute", top: 8, right: 8 }}
        >
          说明
        </button>
        {panelOpen && (
          <div
            style={{
              position: "absolute",
              top: 40,
              right: 8,
              maxWidth: 260,
              padding: 10,
              fontSize: 12,
              lineHeight: 1.7,
              background: theme.panel,
              border: `1px solid ${theme.border}`,
              borderRadius: theme.radius,
              color: theme.textDim,
            }}
          >
            <div>左键绘制 · 右键擦除</div>
            <div>滚轮缩放 · 平移工具拖拽画布</div>
            <div>B 笔刷 · E 橡皮 · I 吸管 · V 平移</div>
            <div>Ctrl+Z 撤销 · Ctrl+S 保存</div>
            <div>停止绘制 3 秒后自动保存</div>
          </div>
        )}
      </div>

      {/* 底部信息条 */}
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", fontSize: 12, color: theme.textFaint }}>
        <span>
          {meta ? `${meta.board.width}×${meta.board.height}` : "—"} · 缩放 {zoomPercent}%
        </span>
        <span>待保存瓦片 {dirtyCount}</span>
        <span>
          {readOnly
            ? "只读"
            : saveState === "saving"
              ? "保存中…"
              : saveState === "saved"
                ? "已保存"
                : dirtyCount > 0
                  ? "有未保存改动"
                  : "无改动"}
        </span>
      </div>
    </div>
  );
}

/**
 * 按当前视口与缩放取整，给出元件像素比（上限 2，避免高 DPI 屏吃掉帧率）。
 * @returns DPR
 */
function devicePixelRatioNow(): number {
  return Math.min(Math.max(globalThis.devicePixelRatio || 1, 1), 2);
}

/**
 * 计算「适应窗口」的视口。
 * @param boardWidth 白板宽
 * @param boardHeight 白板高
 * @param viewWidth 容器宽
 * @param viewHeight 容器高
 * @returns 视口
 */
function fitViewport(boardWidth: number, boardHeight: number, viewWidth: number, viewHeight: number): Viewport {
  if (viewWidth <= 0 || viewHeight <= 0) {
    return { zoom: 1, offsetX: 0, offsetY: 0 };
  }
  const zoom = clamp(Math.min(viewWidth / boardWidth, viewHeight / boardHeight), MIN_ZOOM, MAX_ZOOM);
  return {
    zoom,
    offsetX: boardWidth / 2 - viewWidth / 2 / zoom,
    offsetY: boardHeight / 2 - viewHeight / 2 / zoom,
  };
}

/**
 * 把矩形向外扩到瓦片边界（局部重绘时按整块瓦片更新，避免边缘缝隙）。
 * @param rect 像素矩形
 * @param boardWidth 白板宽
 * @param boardHeight 白板高
 * @returns 对齐到瓦片边界后的矩形
 */
function outerRect(rect: PixelRect, boardWidth: number, boardHeight: number): PixelRect {
  const range = tileRangeOf(boardWidth, boardHeight, rect);
  const x = range.minCol * TILE_SIZE;
  const y = range.minRow * TILE_SIZE;
  const right = Math.min(boardWidth, (range.maxCol + 1) * TILE_SIZE);
  const bottom = Math.min(boardHeight, (range.maxRow + 1) * TILE_SIZE);
  return { x, y, width: right - x, height: bottom - y };
}

/**
 * 从全幅索引栅格构建某矩形的 ImageData。
 * @param indices 全幅栅格
 * @param x 起点 x
 * @param y 起点 y
 * @param width 宽
 * @param height 高
 * @param sourceWidth 全幅宽（行距）
 * @returns ImageData
 */
function buildImageData(
  indices: Uint8Array,
  x: number,
  y: number,
  width: number,
  height: number,
  sourceWidth: number,
): ImageData {
  const rgba = new Uint8ClampedArray(new ArrayBuffer(width * height * 4));
  const view = new Uint32Array(rgba.buffer);
  for (let row = 0; row < height; row += 1) {
    const sourceStart = (y + row) * sourceWidth + x;
    const targetStart = row * width;
    for (let col = 0; col < width; col += 1) {
      const value = indices[sourceStart + col] ?? 0;
      if (value === 0) {
        view[targetStart + col] = 0;
        continue;
      }
      const packed = PALETTE_UINT32[value];
      view[targetStart + col] = packed === undefined ? 0xff000000 : packed | 0xff000000;
    }
  }
  return new ImageData(rgba, width, height);
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

/** 工具栏样式 */
function barStyle(theme: MapEditorTheme): React.CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "8px 10px",
    background: theme.panel,
    border: `1px solid ${theme.border}`,
    borderRadius: theme.radius,
    fontSize: 13,
  };
}

/** 工具栏分隔符 */
function dividerStyle(theme: MapEditorTheme): React.CSSProperties {
  return { width: 1, height: 18, background: theme.border, margin: "0 2px" };
}

/** 按钮样式 */
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

/** 画布浮层样式 */
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

/** 工具按钮 */
function ToolButton(props: {
  theme: MapEditorTheme;
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
}): React.ReactElement {
  const { theme, label, active, disabled, onClick } = props;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        ...buttonStyle(theme),
        background: active ? theme.accent : "transparent",
        color: active ? "#14120f" : theme.text,
        borderColor: active ? theme.accent : theme.border,
        opacity: disabled ? 0.45 : 1,
        cursor: disabled ? "not-allowed" : "pointer",
      }}
    >
      {label}
    </button>
  );
}
