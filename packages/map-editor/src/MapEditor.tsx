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
  deformFactor,
  encodeTile,
  formatArea,
  formatDistance,
  kilometersPerPixelLon,
  pixelToLonLat,
  scaleBar,
  type BoardSpec,
  type GeoPoint,
  type MapEditorProps,
  type MapEditorTheme,
  type MapMeta,
  type MapLayer,
  type SaveState,
  type TerrainBrush,
  type Tile,
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
import { exportBoardImage, downloadBlob } from "./export-image";
import { MapLayerStore } from "./layer-store";
import { LayerPanel } from "./panels/LayerPanel";
import { MarkerStore, type CanvasMarker } from "./marker-store";
import { computeRasterStats, measurePolyline, type MeasureResult, type RasterStats } from "./measure";
import { describeResize, normalizeBoardWidth, resampleNearest } from "./resize";
import { bakeHandDrawnLayer, createPaperTexture, PAPER_BASE, type RenderStyleMode } from "./terrain-render";
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

/** 标记的命中半径（屏幕像素）：比绘制半径大一些，便于点选 */
const MARKER_HIT_RADIUS_PX = 12;

/** 视口状态：缩放与平移偏移（世界像素） */
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
  /** 图层门面：管理全部栅格图层（每层一份栅格 + 脏瓦片 + 离屏位图） */
  const layerStoreRef = useRef<MapLayerStore | null>(null);
  /** 图层面板所需的 React 状态（图层列表与当前图层） */
  const [layerList, setLayerList] = useState<MapLayer[]>([]);
  const [activeLayerId, setActiveLayerId] = useState<string | null>(null);
  /** 当前图层的 ref 镜像（绘制 / 撤销等回调里读，避免闭包过期） */
  const activeLayerIdStateRef = useRef<string | null>(null);
  const markerStoreRef = useRef<MarkerStore | null>(null);
  const historyRef = useRef(new HistoryStack());
  const viewportRef = useRef<Viewport>({ zoom: 1, offsetX: 0, offsetY: 0 });
  const brushRef = useRef<BrushSettings>({ ...DEFAULT_BRUSH });
  const paintingRef = useRef(false);
  /** 当前笔画是否为擦除（右键或橡皮），移动时沿用 */
  const erasingRef = useRef(false);
  /** 上一次落点的屏幕坐标，用于在两点间补点 */
  const lastPaintRef = useRef<{ x: number; y: number } | null>(null);
  /** 正在拖动的标记（标记整合） */
  const draggingMarkerRef = useRef<{ id: string; grabDx: number; grabDy: number } | null>(null);
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
  /** 图层面板开关 */
  const [layerPanelOpen, setLayerPanelOpen] = useState(false);
  const [markerMode, setMarkerMode] = useState(false);
  const [pendingMarker, setPendingMarker] = useState<{ x: number; y: number } | null>(null);
  const [markerLabel, setMarkerLabel] = useState("");
  const [markerTick, setMarkerTick] = useState(0);
  const [markerCount, setMarkerCount] = useState(0);
  /** 当前选中的标记 id（用 ref 给渲染循环读，避免每帧重渲染） */
  const selectedMarkerIdRef = useRef<string | null>(null);
  /** 本地草稿：发现比服务端更新的草稿时，提示用户是否恢复 */
  const [draftPrompt, setDraftPrompt] = useState<{ savedAt: number } | null>(null);
  const [draftState, setDraftState] = useState<"none" | "pending" | "saved">("none");
  /** 草稿定时器，以及「取当前草稿瓦片」的实现（由 effect 按依赖重建） */
  const draftTimerRef = useRef<number | null>(null);
  const draftCaptureRef = useRef<(() => Promise<void>) | null>(null);
  /**
   * 保存互斥锁：防止并发保存。
   *
   * 曾经踩到的坑：连点撤销 / 重做会各触发一次自动保存，两个请求读同一个
   * revision 一起提交，后到的那个必然 409。加锁后同一时刻只允许一次保存。
   */
  const savingRef = useRef(false);
  /** 天体半径（km）：决定比例尺、面积与统计，改它不改已画内容 */
  const [radiusKm, setRadiusKm] = useState(6371);
  /** 测量：折点（世界像素）与结果 */
  const [measurePoints, setMeasurePoints] = useState<{ x: number; y: number }[]>([]);
  const [measureResult, setMeasureResult] = useState<MeasureResult | null>(null);
  const [measurePending, setMeasurePending] = useState<{ x: number; y: number } | null>(null);
  /** 面积统计（点击「统计」时全图扫一遍） */
  const [stats, setStats] = useState<RasterStats | null>(null);
  const [statsOpen, setStatsOpen] = useState(false);
  const [radiusOpen, setRadiusOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  /** 全屏工作区：让画布铺满页面（编辑器越长，能看到的画布越大） */
  const [fullscreen, setFullscreen] = useState(false);
  /** 渲染风格：简约色块 / 手绘图案（方案 §8 的观感取向） */
  const [renderStyle, setRenderStyle] = useState<RenderStyleMode>("handdrawn");
  /** 白板改尺寸面板与输入 */
  const [resizeOpen, setResizeOpen] = useState(false);
  const [resizeWidth, setResizeWidth] = useState(2048);
  const [resizing, setResizing] = useState(false);
  /** 光标处的尺度读数 */
  const [readout, setReadout] = useState<{
    lat: number;
    lon: number;
    kmPerPixel: number;
    deform: number;
  } | null>(null);
  const readoutRef = useRef<{ lat: number; lon: number; kmPerPixel: number; deform: number } | null>(null);
  /** 半径的最新值（给不随半径重建的回调读） */
  const radiusKmRef = useRef(6371);
  /** 渲染风格的最新值（给不随它重建的回调读） */
  const renderStyleRef = useRef<RenderStyleMode>("handdrawn");
  /**
   * 当前正在绘制的栅格图层 id（由图层面板切换）。
   * 绘制、撤销、吸管都以它为准；`MapLayerStore` 负责多图层的实际读写。
   */
  const activeLayerIdRef = useRef<string | null>(null);
  /** 当前图层的数据仓库（单图层读写的快捷入口，随当前图层变化） */
  const storeRef = useRef<RasterTileStore | null>(null);

  viewportRef.current = viewport;
  brushRef.current = brush;
  metaRef.current = meta;
  radiusKmRef.current = radiusKm;
  renderStyleRef.current = renderStyle;

  /**
   * 更新光标处的尺度读数（经纬度、每像素实距、横向变形倍率）。
   *
   * 读数放在 ref 里、只在数值真的变化时触发一次重渲染：
   * 指针移动每秒可能几十次，若每次都 setState 会让绘制掉帧。
   * 定义在顶部是为了让后面定义的指针处理器都能直接引用。
   *
   * @param worldX 世界像素 x
   * @param worldY 世界像素 y
   */
  const updateReadout = useCallback((worldX: number, worldY: number): void => {
    const store = storeRef.current;
    if (!store || !metaRef.current) {
      return;
    }
    const board = boardOf(store, radiusKmRef.current);
    const geo = pixelToLonLat(worldX, worldY, board);
    const next = {
      lat: geo.lat,
      lon: geo.lon,
      kmPerPixel: kilometersPerPixelLon(board, geo.lat),
      deform: deformFactor(geo.lat),
    };
    const previous = readoutRef.current;
    // 经纬度取一位小数比较：低于显示精度的变化不值得重渲染
    if (
      previous &&
      previous.lat.toFixed(1) === next.lat.toFixed(1) &&
      previous.lon.toFixed(1) === next.lon.toFixed(1) &&
      previous.kmPerPixel.toFixed(2) === next.kmPerPixel.toFixed(2)
    ) {
      return;
    }
    readoutRef.current = next;
    setReadout(next);
  }, []);

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
        setRadiusKm(result.board.radiusKm);
        setResizeWidth(result.board.width);

        const rasterLayer = result.layers.find((layer) => layer.storage === "raster");
        if (rasterLayer) {
          const layerStore = new MapLayerStore({
            adapter,
            mapId,
            width: result.board.width,
            height: result.board.height,
            layers: result.layers,
            revision: result.revision,
            palette: result.palette,
          });
          await layerStore.load();
          if (cancelled) {
            return;
          }
          layerStoreRef.current = layerStore;
          layerStore.setStyleMode(renderStyleRef.current);
          layerStore.redrawAllRenderBitmaps();
          const firstLayer = layerStore.rasterLayers()[0] ?? null;
          activeLayerIdRef.current = firstLayer?.id ?? null;
          activeLayerIdStateRef.current = firstLayer?.id ?? null;
          setLayerList(layerStore.layers);
          setActiveLayerId(firstLayer?.id ?? null);
          storeRef.current = firstLayer ? layerStore.storeOf(firstLayer.id) : null;
          historyRef.current.clear();
          setDirtyCount(0);
        }

        // 底图尺寸就绪后按「适应窗口」落位
        const container = containerRef.current;
        if (container) {
          setViewport(fitViewport(result.board.width, result.board.height, container.clientWidth, container.clientHeight));
        }
        rebuildOffscreen();

        // 标记：走宿主既有接口。**加载失败不能中断后续初始化**——
        // 否则绘制 / 撤销这些核心能力会一起失效（这里踩过一次）
        const markerStore = new MarkerStore({
          adapter,
          mapId,
          boardWidth: result.board.width,
          boardHeight: result.board.height,
          revision: result.revision,
        });
        markerStoreRef.current = markerStore;
        try {
          const markerTotal = await markerStore.load();
          if (!cancelled) {
            setMarkerCount(markerTotal);
            setMarkerTick((tick) => tick + 1);
          }
        } catch (err) {
          // 标记列表读不到不影响画地图：提示一次即可
          markerStoreRef.current = null;
          if (!cancelled) {
            setMarkerCount(0);
            props.onError?.(new Error(`标记列表加载失败：${(err as Error).message}`));
          }
        }

        // 本地草稿：若存在且比服务端更新，提示恢复（不静默覆盖，也不静默丢弃）
        const drafts = props.drafts;
        const rasterLayerId = result.layers.find((layer) => layer.storage === "raster")?.id;
        if (drafts && rasterLayerId) {
          try {
            const draft = await drafts.load(mapId);
            const serverUpdatedAt = result.updatedAt ?? 0;
            if (draft && draft.tiles.length > 0 && draft.savedAt > serverUpdatedAt) {
              if (!cancelled) {
                setDraftPrompt({ savedAt: draft.savedAt });
                props.onDraftAvailable?.(draft.savedAt);
              }
            } else if (draft) {
              // 服务端更新或草稿已失效：清掉，避免每次打开都触发
              await drafts.clear(mapId);
            }
          } catch {
            // 草稿读取失败不能影响编辑
          }
        }

        setHistoryTick((tick) => tick + 1);
      } catch (err) {
        if (!cancelled) {
          setError((err as Error).message);
          // 加载失败要明确告知，而不是让界面一直停在「正在加载」
          props.onError?.(err as Error);
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

  /**
   * 整体重画所有图层的离屏位图（初次载入、撤销重做、图层显隐变化后调用）。
   * 多图层下不再有「唯一底图」，每个栅格图层各有一块位图。
   */
  const rebuildOffscreen = useCallback((): void => {
    layerStoreRef.current?.redrawAllRenderBitmaps();
  }, []);

  /**
   * 局部更新当前图层的离屏位图（一次落笔后只重画受影响的矩形）。
   * @param rect 世界像素矩形
   */
  const refreshOffscreen = useCallback((rect: PixelRect): void => {
    const layerStore = layerStoreRef.current;
    const layerId = activeLayerIdRef.current;
    if (!layerStore || !layerId) {
      return;
    }
    layerStore.refreshRenderBitmap(layerId, rect);
  }, []);

  /** 切换渲染风格（简约色块 ↔ 手绘图案），并清掉对应缓存 */
  const handleToggleRenderStyle = useCallback((): void => {
    const layerStore = layerStoreRef.current;
    const next: RenderStyleMode = renderStyleRef.current === "handdrawn" ? "flat" : "handdrawn";
    renderStyleRef.current = next;
    setRenderStyle(next);
    layerStore?.setStyleMode(next);
    layerStore?.redrawAllRenderBitmaps();
    setHistoryTick((tick) => tick + 1);
  }, []);

  /** 主动保存（把各图层的脏瓦片按层分批提交给宿主） */
  const saveNow = useCallback(async (): Promise<void> => {
    const layerStore = layerStoreRef.current;
    const metaValue = metaRef.current;
    if (!layerStore || !metaValue || readOnly) {
      return;
    }
    // 已有保存在进行中就跳过：并发的两个请求会用同一个 revision，后到的必然冲突
    if (savingRef.current) {
      return;
    }
    if (layerStore.totalDirtyCount() === 0) {
      setSaveState("saved");
      return;
    }

    savingRef.current = true;
    setSaveState("saving");
    const groups = await layerStore.takeAllDirtyTiles();
    const totalTiles = groups.reduce((sum, group) => sum + group.tiles.length, 0);
    if (totalTiles === 0) {
      // 脏瓦片其实与服务器端一致（例如涂了又擦回），直接收工
      for (const layerId of layerStore.rasterLayers().map((layer) => layer.id)) {
        layerStore.storeOf(layerId)?.clearDirtyAsBaseline();
      }
      setDirtyCount(0);
      setSaveState("saved");
      savingRef.current = false;
      return;
    }

    try {
      let revision = metaValue.revision;
      for (const group of groups) {
        for (let i = 0; i < group.tiles.length; i += MAX_TILES_PER_SAVE) {
          const chunk = group.tiles.slice(i, i + MAX_TILES_PER_SAVE);
          let result = await adapter.saveTiles({
            mapId,
            layerId: group.layerId,
            tiles: chunk,
            revision,
          });
          if (result.conflict) {
            // 版本冲突：用服务端最新版本重试一次，避免刚画的改动白费
            result = await adapter.saveTiles({
              mapId,
              layerId: group.layerId,
              tiles: chunk,
              revision: result.revision,
            });
            if (result.conflict) {
              throw new Error("地图已在别处被修改，请重新加载后再画");
            }
          }
          revision = result.revision;
          // 只有真正保存成功才更新基线
          layerStore.storeOf(group.layerId)?.commitBaseline(chunk.map((tile) => tile.coord));
        }
      }
      setDirtyCount(layerStore.totalDirtyCount());
      setMeta((current) => (current ? { ...current, revision } : current));
      if (metaRef.current) {
        metaRef.current = { ...metaRef.current, revision };
      }
      // 已成功落到服务端：本地草稿不再需要
      if (props.drafts) {
        try {
          await props.drafts.clear(mapId);
          setDraftState("none");
        } catch {
          // 清理失败不影响保存结果
        }
      }
      setSaveState("saved");
      props.onSaveStateChange?.("saved");
      props.onDirtyChange?.(false);
    } catch (err) {
      // 保存失败：瓦片仍是脏的，不丢本地内容
      setDirtyCount(layerStore.totalDirtyCount());
      setSaveState("error");
      props.onSaveStateChange?.("error");
      props.onError?.(err as Error);
    } finally {
      // 无论成功失败都要释放锁，否则后续保存会被永久跳过
      savingRef.current = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adapter, mapId, readOnly, props]);

  /** 安排空闲自动保存 */
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

  /**
   * 安排一次本地草稿写入（防抖 1 秒）。
   *
   * 触发点放在**笔画结束时**而不是每个落点：一次笔画可能几百个采样点，
   * 逐点写 IndexedDB 既无意义也拖慢绘制。
   */
  const scheduleDraftSave = useCallback((): void => {
    const capture = draftCaptureRef.current;
    if (!capture || readOnly) {
      return;
    }
    if (draftTimerRef.current !== null) {
      window.clearTimeout(draftTimerRef.current);
    }
    draftTimerRef.current = window.setTimeout(() => {
      draftTimerRef.current = null;
      void capture();
    }, 1000);
  }, [readOnly]);

  /** 每次依赖变化时重建「取草稿瓦片」的实现（逐图层收集） */
  useEffect(() => {
    const drafts = props.drafts;
    const layerStore = layerStoreRef.current;
    if (!drafts || !layerStore || !meta) {
      draftCaptureRef.current = null;
      return;
    }
    draftCaptureRef.current = async (): Promise<void> => {
      const tiles = [];
      for (const layer of layerStore.rasterLayers()) {
        const store = layerStore.storeOf(layer.id);
        if (!store || store.dirtyCount === 0) {
          continue;
        }
        tiles.push(...(await store.takeDirtyTiles()));
      }
      if (tiles.length === 0) {
        return;
      }
      // 只暂存变化瓦片（通常几个到几十 KB），不是整幅栅格
      await drafts.save({ mapId, savedAt: Date.now(), tiles });
      setDraftState("pending");
    };
  }, [props.drafts, meta, mapId, historyTick]);

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
    // 底色：手绘模式下露出的应是纸张色（否则深色底会把手绘画面割裂开）
    context.fillStyle =
      renderStyleRef.current === "handdrawn" && layerStoreRef.current
        ? PAPER_BASE
        : theme.background;
    context.fillRect(0, 0, cssWidth, cssHeight);

    // 多图层合成：按 zIndex 从下到上绘制各可见图层（每层有自己的不透明度）
    const layerStore = layerStoreRef.current;
    if (layerStore) {
      layerStore.renderTo(context, offsetX, offsetY, zoom, dpr);
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

    // 标记：画在底图之上、经纬网之后；未选中的只画点，选中的加光晕与名称
    const markerStore = markerStoreRef.current;
    if (markerStore) {
      for (const marker of markerStore.markers) {
        const screenX = (marker.x - offsetX) * zoom;
        const screenY = (marker.y - offsetY) * zoom;
        if (screenX < -20 || screenY < -20 || screenX > cssWidth + 20 || screenY > cssHeight + 20) {
          continue;
        }
        const selected = marker.id === selectedMarkerIdRef.current;
        context.beginPath();
        context.arc(screenX, screenY, selected ? 8 : 6, 0, Math.PI * 2);
        context.fillStyle = "#c9a15c";
        context.globalAlpha = 0.75;
        context.fill();
        context.globalAlpha = 1;
        context.lineWidth = 2;
        context.strokeStyle = selected ? "#ffffff" : "#14120f";
        context.stroke();

        if (selected || zoom >= 1) {
          context.font = '12px "Source Han Sans SC", "Noto Sans SC", sans-serif';
          context.textBaseline = "bottom";
          context.fillStyle = "#14120f";
          const textWidth = context.measureText(marker.label || "标记").width;
          context.fillRect(screenX + 8, screenY - 20, textWidth + 6, 15);
          context.fillStyle = theme.text;
          context.fillText(marker.label || "标记", screenX + 11, screenY - 7);
        }
      }
    }

    // 测量折线与读数：按世界坐标换算屏幕位置
    if (measurePoints.length > 0 || measurePending) {
      const screenOf = (point: { x: number; y: number }): { x: number; y: number } => ({
        x: (point.x - offsetX) * zoom,
        y: (point.y - offsetY) * zoom,
      });

      context.strokeStyle = theme.accent;
      context.lineWidth = 1.5;
      context.beginPath();
      measurePoints.forEach((point, index) => {
        const screen = screenOf(point);
        if (index === 0) {
          context.moveTo(screen.x, screen.y);
        } else {
          context.lineTo(screen.x, screen.y);
        }
      });
      const pendingScreen = measurePending ? screenOf(measurePending) : null;
      if (pendingScreen && measurePoints.length > 0) {
        context.lineTo(pendingScreen.x, pendingScreen.y);
      }
      context.stroke();

      for (const point of measurePoints) {
        const screen = screenOf(point);
        context.beginPath();
        context.arc(screen.x, screen.y, 3, 0, Math.PI * 2);
        context.fillStyle = theme.accent;
        context.fill();
      }

      // 读数标签：画在起点附近
      const first = measurePoints[0];
      if (first && measureResult) {
        const screen = screenOf(first);
        const label =
          measureResult.points.length >= 2
            ? `${formatDistance(measureResult.polylineKm)} · 方位 ${Math.round(measureResult.directBearing)}°`
            : "";
        if (label) {
          context.font = '12px "Source Han Sans SC", "Noto Sans SC", sans-serif';
          const textWidth = context.measureText(label).width;
          // 背景用纸张色、文字用亮色：浅底浅字会看不清（踩过这个坑）
          context.fillStyle = `${PAPER_BASE}e6`;
          context.fillRect(screen.x + 8, screen.y + 8, textWidth + 10, 18);
          context.fillStyle = theme.text;
          context.fillText(label, screen.x + 13, screen.y + 21);
        }
      }
    }

    // 比例尺条：按光标纬度实时换算（等距圆柱下比例尺随纬度变化）
    if (store) {
      const cursor = cursorRef.current;
      const lat = cursor
        ? pixelToLonLat(offsetX + cursor.x / zoom, offsetY + cursor.y / zoom, boardOf(store, radiusKm)).lat
        : 0;
      const board = boardOf(store, radiusKm);
      const bar = scaleBar(board, lat, zoom, 120);
      if (bar.pixels > 8) {
        const barHeight = 6;
        const x0 = 12;
        const y0 = cssHeight - 16;
        // 比例尺条同样用纸张色底 + 亮色文字，保证在暗纸上可读
        context.fillStyle = `${PAPER_BASE}e6`;
        context.fillRect(x0 - 4, y0 - barHeight - 10, Math.max(bar.pixels, 40) + 8, barHeight + 10);
        context.fillStyle = theme.accent;
        context.fillRect(x0, y0 - barHeight, bar.pixels, barHeight);
        context.font = '11px "Source Han Sans SC", "Noto Sans SC", sans-serif';
        context.fillStyle = theme.text;
        context.fillText(formatDistance(bar.kilometers), x0, y0 - barHeight - 2);
      }
    }

    context.restore();
  }, [viewport, theme, meta, historyTick, saveState, markerTick, measurePoints, measurePending, measureResult, radiusKm]);

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

      historyRef.current.record(activeLayerIdRef.current ?? "", rect, before, after);
      store.markDirty(rect);
      refreshOffscreen(outerRect(rect, store.width, store.height));
      // 多图层：统计所有图层的待保存量，而不是只看当前层
      setDirtyCount(layerStoreRef.current?.totalDirtyCount() ?? store.dirtyCount);
      props.onDirtyChange?.(true);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [readOnly, toWorld, refreshOffscreen, props],
  );

  /** 撤销一步（多图层：回到该步所属图层） */
  const undo = useCallback((): void => {
    const layerStore = layerStoreRef.current;
    const entry = historyRef.current.peekUndo();
    if (!layerStore || !entry) {
      return;
    }
    // 切到该步所在的图层：否则用户会看到「撤销了但画面没变」
    if (entry.layerId && entry.layerId !== activeLayerIdRef.current) {
      activeLayerIdRef.current = entry.layerId;
      activeLayerIdStateRef.current = entry.layerId;
      setActiveLayerId(entry.layerId);
      storeRef.current = layerStore.storeOf(entry.layerId);
    }
    layerStore.writeRect(entry.layerId, entry.rect, entry.before);
    historyRef.current.confirmUndo();
    layerStore.redrawAllRenderBitmaps();
    setLayerList([...layerStore.layers]);
    setDirtyCount(layerStore.totalDirtyCount());
    setHistoryTick((tick) => tick + 1);
    scheduleAutoSave();
    scheduleDraftSave();
  }, [scheduleAutoSave, scheduleDraftSave]);

  /** 重做一步（多图层：同样回到该步所属图层） */
  const redo = useCallback((): void => {
    const layerStore = layerStoreRef.current;
    const entry = historyRef.current.peekRedo();
    if (!layerStore || !entry) {
      return;
    }
    if (entry.layerId && entry.layerId !== activeLayerIdRef.current) {
      activeLayerIdRef.current = entry.layerId;
      activeLayerIdStateRef.current = entry.layerId;
      setActiveLayerId(entry.layerId);
      storeRef.current = layerStore.storeOf(entry.layerId);
    }
    layerStore.writeRect(entry.layerId, entry.rect, entry.after);
    historyRef.current.confirmRedo();
    layerStore.redrawAllRenderBitmaps();
    setLayerList([...layerStore.layers]);
    setDirtyCount(layerStore.totalDirtyCount());
    setHistoryTick((tick) => tick + 1);
    scheduleAutoSave();
    scheduleDraftSave();
  }, [scheduleAutoSave, scheduleDraftSave]);

  /** 恢复本地草稿（用户确认后） */
  const handleRestoreDraft = useCallback(async (): Promise<void> => {
    const drafts = props.drafts;
    const store = storeRef.current;
    if (!drafts || !store) {
      setDraftPrompt(null);
      return;
    }
    try {
      const draft = await drafts.load(mapId);
      if (!draft || draft.tiles.length === 0) {
        setDraftPrompt(null);
        return;
      }
      await store.applyTiles(draft.tiles);
      rebuildOffscreen();
      setDirtyCount(store.dirtyCount);
      setHistoryTick((tick) => tick + 1);
      setDraftPrompt(null);
      setDraftState("pending");
      props.onDirtyChange?.(true);
    } catch (err) {
      props.onError?.(err as Error);
      setDraftPrompt(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.drafts, mapId, rebuildOffscreen, props]);

  /** 放弃本地草稿 */
  const handleDiscardDraft = useCallback(async (): Promise<void> => {
    const drafts = props.drafts;
    setDraftPrompt(null);
    if (!drafts) {
      return;
    }
    try {
      await drafts.clear(mapId);
      setDraftState("none");
    } catch {
      // 清理失败不影响继续编辑
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.drafts, mapId]);

  /** 清理测量（工具切换或用户取消时调用） */
  const clearMeasure = useCallback((): void => {
    setMeasurePoints([]);
    setMeasureResult(null);
    setMeasurePending(null);
  }, []);

  /**
   * 追加一个测量点并重算读数。
   * @param world 世界像素坐标
   */
  const addMeasurePoint = useCallback(
    (world: { x: number; y: number }): void => {
      const store = storeRef.current;
      if (!store) {
        return;
      }
      setMeasurePoints((previous) => {
        const next = [...previous, world];
        const geoPoints: GeoPoint[] = next.map((point) => pixelToLonLat(point.x, point.y, boardOf(store, radiusKm)));
        setMeasureResult(measurePolyline(geoPoints, radiusKm));
        return next;
      });
    },
    [radiusKm],
  );

  /** 点击「统计」：全图扫一遍算各地形面积（2048 白板约两百多万像素，毫秒级） */
  const handleComputeStats = useCallback((): void => {
    const store = storeRef.current;
    if (!store) {
      return;
    }
    const board = boardOf(store, radiusKm);
    setStats(computeRasterStats(store.indices, store.width, store.height, store.palette, board));
    setStatsOpen(true);
  }, [radiusKm]);

  /** 导出为图片（PNG 优先，超限自动降 WebP） */
  const handleExport = useCallback(async (): Promise<void> => {
    const store = storeRef.current;
    if (!store) {
      return;
    }
    setExporting(true);
    try {
      const result = await exportBoardImage({
        width: store.width,
        height: store.height,
        indices: store.indices,
        palette: store.palette,
        includeGraticule: true,
        includeScaleBar: true,
        radiusKm,
        styleMode: renderStyleRef.current,
        paper: createPaperTexture(),
      });
      const extension = result.mimeType === "image/png" ? "png" : "webp";
      const blob = result.blob;
      // 宿主可通过 onExport 接管下载（例如桌面端用系统保存对话框）
      if (props.onExport) {
        await props.onExport(blob, `map-${mapId}.${extension}`);
      } else {
        downloadBlob(blob, `map-${mapId}.${extension}`);
      }
    } catch (err) {
      props.onError?.(err as Error);
    } finally {
      setExporting(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapId, radiusKm, props.onExport, props.onError]);

  /** 设定天体半径：只影响读数，不改已画内容 */
  const handleSetRadius = useCallback((value: number): void => {
    if (!Number.isFinite(value) || value <= 0) {
      return;
    }
    setRadiusKm(value);
    // 半径变了，之前算的面积不再有效
    setStats(null);
  }, []);

  /**
   * 改白板尺寸：最近邻重采样后分批提交。
   *
   * 流程：读当前全幅栅格 → 最近邻重采样到新尺寸 → 逐瓦片编码 → 交给宿主分批提交
   * → 成功后在本机更新白板尺寸与栅格（不重新从服务端拉，省一次往返）。
   *
   * @param targetWidth 目标宽度（会被规整到 128 的倍数）
   */
  const handleResize = useCallback(
    async (targetWidth: number): Promise<void> => {
      const store = storeRef.current;
      const metaValue = metaRef.current;
      if (!store || !metaValue || readOnly) {
        return;
      }
      if (!adapter.resizeBoard) {
        props.onError?.(new Error("当前宿主未提供改尺寸能力"));
        return;
      }
      const width = normalizeBoardWidth(targetWidth);
      if (width === store.width) {
        setResizeOpen(false);
        return;
      }

      setResizing(true);
      try {
        const height = width / 2;
        const nextIndices = resampleNearest(store.indices, store.width, store.height, width, height);
        const layerId = metaValue.layers.find((layer) => layer.storage === "raster")?.id;
        if (!layerId) {
          throw new Error("找不到可编辑的栅格图层");
        }

        // 逐瓦片编码（边缘瓦片按实际尺寸），全部交给宿主分批提交
        const tiles: Tile[] = [];
        const cols = Math.ceil(width / TILE_SIZE);
        const rows = Math.ceil(height / TILE_SIZE);
        for (let row = 0; row < rows; row += 1) {
          for (let col = 0; col < cols; col += 1) {
            const tileWidth = Math.min(TILE_SIZE, width - col * TILE_SIZE);
            const tileHeight = Math.min(TILE_SIZE, height - row * TILE_SIZE);
            const slice = new Uint8Array(tileWidth * tileHeight);
            for (let y = 0; y < tileHeight; y += 1) {
              const sourceStart = (row * TILE_SIZE + y) * width + col * TILE_SIZE;
              slice.set(nextIndices.subarray(sourceStart, sourceStart + tileWidth), y * tileWidth);
            }
            tiles.push({ coord: { col, row }, format: "cwt1", data: await encodeTile({ indices: slice, width: tileWidth, height: tileHeight }) });
          }
        }

        const result = await adapter.resizeBoard({
          mapId,
          width,
          revision: metaValue.revision,
          first: true,
          tiles: [{ layerId, tiles }],
        });
        const nextRevision = result?.revision ?? metaValue.revision + 1;

        // 本机同步新尺寸：重建仓库，内容用刚算出的栅格
        const rebuilt = new RasterTileStore({
          adapter,
          mapId,
          layerId,
          width,
          height,
          palette: store.palette,
        });
        rebuilt.indices.set(nextIndices);
        storeRef.current = rebuilt;
        historyRef.current.clear();
        rebuildOffscreen();
        setMeta((current) => (current ? { ...current, revision: nextRevision, board: { ...current.board, width, height } } : current));
        if (metaRef.current) {
          metaRef.current = { ...metaRef.current, revision: nextRevision, board: { ...metaRef.current.board, width, height } };
        }
        setResizeWidth(width);
        setResizeOpen(false);
        setDirtyCount(0);
        setStats(null);
        setHistoryTick((tick) => tick + 1);
        props.onSaveStateChange?.("saved");
      } catch (err) {
        props.onError?.(err as Error);
      } finally {
        setResizing(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [adapter, mapId, readOnly, rebuildOffscreen, props],
  );

  /**
   * 切换当前图层：绘制、撤销、吸管都以它为准。
   *
   * 新图层若是栅格，会立刻为它建好数据仓库（空白层），保证「选中即可画」。
   *
   * @param layerId 目标图层 id
   */
  const selectLayer = useCallback(
    async (layerId: string): Promise<void> => {
      const layerStore = layerStoreRef.current;
      if (!layerStore) {
        return;
      }
      const layer = layerStore.layers.find((item) => item.id === layerId);
      if (!layer) {
        return;
      }
      if (layer.storage === "raster" && !layerStore.storeOf(layerId)) {
        // 按需载入（新增图层、或从别处改过图层配置时）
        await layerStore.load();
        layerStore.redrawAllRenderBitmaps();
      }
      const store = layerStore.storeOf(layerId);
      if (!store) {
        props.onError?.(new Error("该图层暂不支持绘制（矢量图层待实现）"));
        return;
      }
      activeLayerIdRef.current = layerId;
      activeLayerIdStateRef.current = layerId;
      setActiveLayerId(layerId);
      storeRef.current = store;
      setLayerList([...layerStore.layers]);
      setHistoryTick((tick) => tick + 1);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [props],
  );

  /** 图层面板动作的统一收尾：刷新列表与画布 */
  const afterLayerChange = useCallback((): void => {
    const layerStore = layerStoreRef.current;
    if (!layerStore) {
      return;
    }
    layerStore.redrawAllRenderBitmaps();
    setLayerList([...layerStore.layers]);
    setHistoryTick((tick) => tick + 1);
  }, []);

  /** 切换图层显隐 */
  const handleToggleLayerVisible = useCallback(
    async (layerId: string, visible: boolean): Promise<void> => {
      const layerStore = layerStoreRef.current;
      if (!layerStore) {
        return;
      }
      await layerStore.updateLayer(layerId, { visible });
      afterLayerChange();
    },
    [afterLayerChange],
  );

  /** 重命名图层 */
  const handleRenameLayer = useCallback(
    async (layerId: string, name: string): Promise<void> => {
      const layerStore = layerStoreRef.current;
      if (!layerStore) {
        return;
      }
      await layerStore.updateLayer(layerId, { name });
      afterLayerChange();
    },
    [afterLayerChange],
  );

  /** 调整图层透明度 */
  const handleLayerOpacity = useCallback(
    async (layerId: string, opacity: number): Promise<void> => {
      const layerStore = layerStoreRef.current;
      if (!layerStore) {
        return;
      }
      await layerStore.updateLayer(layerId, { opacity });
      afterLayerChange();
    },
    [afterLayerChange],
  );

  /** 上移 / 下移图层（本质是交换相邻的 zIndex） */
  const handleMoveLayer = useCallback(
    async (layerId: string, direction: "up" | "down"): Promise<void> => {
      const layerStore = layerStoreRef.current;
      if (!layerStore) {
        return;
      }
      const ordered = [...layerStore.layers].sort((a, b) => a.zIndex - b.zIndex);
      const index = ordered.findIndex((layer) => layer.id === layerId);
      const targetIndex = direction === "up" ? index + 1 : index - 1;
      if (index < 0 || targetIndex < 0 || targetIndex >= ordered.length) {
        return;
      }
      const current = ordered[index];
      const target = ordered[targetIndex];
      if (!current || !target) {
        return;
      }
      const swap = current.zIndex;
      current.zIndex = target.zIndex;
      target.zIndex = swap;
      await layerStore.reorder(ordered.map((layer) => layer.id));
      afterLayerChange();
    },
    [afterLayerChange],
  );

  /** 新增图层 */
  const handleAddLayer = useCallback(
    async (name: string, type: MapLayer["type"]): Promise<void> => {
      const layerStore = layerStoreRef.current;
      if (!layerStore) {
        return;
      }
      try {
        const layer = await layerStore.addLayer({ name, type });
        afterLayerChange();
        if (layer.storage === "raster") {
          await selectLayer(layer.id);
        }
      } catch (err) {
        props.onError?.(err as Error);
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [afterLayerChange, selectLayer, props],
  );

  /** 删除图层（最后一层不允许删） */
  const handleRemoveLayer = useCallback(
    async (layerId: string): Promise<void> => {
      const layerStore = layerStoreRef.current;
      if (!layerStore) {
        return;
      }
      if (layerStore.layers.length <= 1) {
        props.onError?.(new Error("至少要保留一个图层"));
        return;
      }
      const layer = layerStore.layers.find((item) => item.id === layerId);
      const confirmed = globalThis.confirm(`确定删除图层「${layer?.name ?? ""}」？该图层上的内容将一并移除。`);
      if (!confirmed) {
        return;
      }
      try {
        await layerStore.removeLayer(layerId);
        if (activeLayerIdRef.current === layerId) {
          const fallback = layerStore.rasterLayers()[0] ?? null;
          if (fallback) {
            await selectLayer(fallback.id);
          } else {
            activeLayerIdRef.current = null;
            storeRef.current = null;
            setActiveLayerId(null);
          }
        }
        afterLayerChange();
      } catch (err) {
        props.onError?.(err as Error);
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [afterLayerChange, selectLayer, props],
  );

  /** 指针按下：按当前工具决定绘制 / 取色 / 平移 / 测量 */
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

      // ① 标记优先：点在标记上就进入拖动（无论当前是什么工具）
      const markerStore = markerStoreRef.current;
      if (markerStore && !isErase && event.button === 0) {
        const grab = toWorld(x, y);
        const hit = markerStore.hitTest(grab.x, grab.y, MARKER_HIT_RADIUS_PX / viewportRef.current.zoom);
        if (hit) {
          event.currentTarget.setPointerCapture(event.pointerId);
          draggingMarkerRef.current = { id: hit.id, grabDx: hit.x - grab.x, grabDy: hit.y - grab.y };
          selectedMarkerIdRef.current = hit.id;
          setMarkerTick((tick) => tick + 1);
          return;
        }
        // 点在空白处：清除选中
        if (selectedMarkerIdRef.current) {
          selectedMarkerIdRef.current = null;
          setMarkerTick((tick) => tick + 1);
        }
      }

      // ② 新增标记模式：点击空白处弹出命名表单
      if (markerMode && event.button === 0 && !readOnly) {
        const target = toWorld(x, y);
        setPendingMarker({ x: target.x, y: target.y });
        return;
      }

      // ③ 测量工具：点击落点，读数实时更新（只读视图也能用）
      if (tool === "measure" && event.button === 0) {
        addMeasurePoint(toWorld(x, y));
        return;
      }

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

      // 拖动标记：即时更新（松手才写回宿主）
      const dragging = draggingMarkerRef.current;
      if (dragging) {
        const store = markerStoreRef.current;
        const world = toWorld(x, y);
        if (store) {
          store.moveTo(dragging.id, world.x + dragging.grabDx, world.y + dragging.grabDy);
          setMarkerTick((tick) => tick + 1);
        }
        return;
      }

      // 未按下时只刷新光标预览（测量模式下同时更新待定点与尺度读数）
      if (!paintingRef.current) {
        const world = toWorld(x, y);
        updateReadout(world.x, world.y);
        if (brushRef.current.tool === "measure") {
          setMeasurePending(world);
        }
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
      const paintingWorld = toWorld(x, y);
      updateReadout(paintingWorld.x, paintingWorld.y);
      drawCursorOnly();
    },
    [paintAt, toWorld, updateReadout],
  );

  /** 指针抬起：结束一步笔画 */
  const handlePointerUp = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      const hadPan = panRef.current !== null;
      panRef.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      // 拖动标记结束：写回宿主（归一化坐标）
      const dragging = draggingMarkerRef.current;
      draggingMarkerRef.current = null;
      if (dragging) {
        void (async () => {
          try {
            await markerStoreRef.current?.persistPosition(dragging.id);
          } catch (err) {
            props.onError?.(err as Error);
          }
        })();
        return;
      }
      if (paintingRef.current) {
        paintingRef.current = false;
        erasingRef.current = false;
        lastPaintRef.current = null;
        historyRef.current.commit();
        setHistoryTick((tick) => tick + 1);
        scheduleAutoSave();
        // 笔画结束才写本地草稿：一次笔画几百个采样点，逐点写没有意义
        scheduleDraftSave();
      } else if (hadPan) {
        // 平移不需要保存
      }
    },
    [scheduleAutoSave],
  );

  /**
   * 滚轮缩放（以光标为锚点）。
   *
   * 实现要点：**必须用原生 addEventListener + { passive: false }**。
   * React 的 `onWheel` 是 passive 监听，`preventDefault()` 会被忽略，
   * 结果是「缩放的同时页面也在滚动」——这是之前踩到的真实问题。
   */
  const handleWheelCore = useCallback((clientX: number, clientY: number, deltaY: number): void => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const cursorX = clientX - rect.left;
    const cursorY = clientY - rect.top;
    setViewport((current) => {
      const factor = deltaY < 0 ? 1.15 : 1 / 1.15;
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

  // 让最新实现可被原生监听器读到（避免每次重渲染重新绑定）
  const handleWheelRef = useRef(handleWheelCore);
  handleWheelRef.current = handleWheelCore;

  /** 绑定非 passive 的滚轮监听：阻止页面跟着一起滚 */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      handleWheelRef.current(event.clientX, event.clientY, event.deltaY);
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, []);

  /** 只重绘主画布（光标移动等轻量更新） */
  const drawCursorOnly = useCallback((): void => {
    setHistoryTick((tick) => tick + 1);
  }, []);

  /** 适应窗口 */
  const handleFit = useCallback((): void => {
    const store = storeRef.current;
    const apply = (): void => {
      const container = containerRef.current;
      const current = storeRef.current;
      if (!container || !current) {
        return;
      }
      const width = container.clientWidth;
      const height = container.clientHeight;
      if (width <= 0 || height <= 0) {
        return;
      }
      setViewport(fitViewport(current.width, current.height, width, height));
    };
    apply();
    // 布局刚变化（切全屏、容器高度改变）时尺寸可能还没稳定，下一帧再算一次
    window.requestAnimationFrame(apply);
    void store;
  }, []);

  /** 确认新增标记 */
  const handleCreateMarker = useCallback(async (): Promise<void> => {
    const store = markerStoreRef.current;
    const pending = pendingMarker;
    if (!store || !pending) {
      return;
    }
    try {
      const created = await store.create(pending.x, pending.y, markerLabel.trim() || "未命名标记", null);
      if (!created) {
        props.onError?.(new Error("当前宿主未提供标记能力"));
        return;
      }
      setMarkerCount(store.markers.length);
      setMarkerTick((tick) => tick + 1);
      selectedMarkerIdRef.current = created.id;
      setPendingMarker(null);
      setMarkerLabel("");
    } catch (err) {
      props.onError?.(err as Error);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingMarker, markerLabel, props]);

  /** 删除标记（二次确认） */
  const handleDeleteMarker = useCallback(
    async (marker: CanvasMarker): Promise<void> => {
      const store = markerStoreRef.current;
      if (!store) {
        return;
      }
      const confirmed = globalThis.confirm(`确定删除标记「${marker.label || "未命名"}」？`);
      if (!confirmed) {
        return;
      }
      try {
        await store.remove(marker.id);
        if (selectedMarkerIdRef.current === marker.id) {
          selectedMarkerIdRef.current = null;
        }
        setMarkerCount(store.markers.length);
        setMarkerTick((tick) => tick + 1);
      } catch (err) {
        props.onError?.(err as Error);
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [props],
  );

  /** 全屏时锁定页面滚动，退出时恢复（否则滚轮会把背后的页面滚走） */
  useEffect(() => {
    if (!fullscreen) {
      return;
    }
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [fullscreen]);

  /** 快捷键：B / E / I / V、Ctrl+Z、Ctrl+Shift+Z、Ctrl+S、Esc 退出全屏 */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        setFullscreen(false);
        return;
      }
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
        // 全屏时铺满整页（含背景，避免露出宿主页面）
        ...(fullscreen
          ? {
              position: "fixed" as const,
              inset: 0,
              zIndex: 60,
              padding: 10,
              background: theme.background,
              overflow: "hidden",
            }
          : {}),
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
        <ToolButton
          theme={theme}
          active={brush.tool === "measure"}
          label="测量"
          onClick={() => {
            setBrush((current) => ({ ...current, tool: "measure" }));
            clearMeasure();
          }}
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
        <ToolButton
          theme={theme}
          active={fullscreen}
          label={fullscreen ? "退出全屏" : "全屏"}
          onClick={() => setFullscreen((value) => !value)}
        />
        <ToolButton
          theme={theme}
          active={renderStyle === "handdrawn"}
          label={renderStyle === "handdrawn" ? "手绘图案" : "简约色块"}
          onClick={handleToggleRenderStyle}
        />
        {!readOnly && (
          <ToolButton
            theme={theme}
            active={markerMode}
            label={markerMode ? "点地图放标记…" : "标记"}
            onClick={() => {
              setMarkerMode((value) => !value);
              setPendingMarker(null);
            }}
          />
        )}
        <span style={{ marginLeft: "auto", fontSize: 12, color: theme.textDim }}>{zoomPercent}%</span>
        <ToolButton
          theme={theme}
          active={statsOpen}
          label="统计"
          onClick={() => (statsOpen ? setStatsOpen(false) : handleComputeStats())}
        />
        <ToolButton theme={theme} active={radiusOpen} label="半径" onClick={() => setRadiusOpen((open) => !open)} />
        <ToolButton
          theme={theme}
          active={resizeOpen}
          label="改尺寸"
          onClick={() => setResizeOpen((open) => !open)}
        />
        {!readOnly && (
          <ToolButton
            theme={theme}
            label={exporting ? "导出中…" : "导出"}
            disabled={exporting}
            onClick={() => void handleExport()}
          />
        )}
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
          // 全屏时铺满剩余空间；页面内时也尽量高（编辑器越长看到的画布越大）
          ...(fullscreen
            ? { flex: 1, minHeight: 0 }
            : { height: "calc(100vh - 320px)", minHeight: 420 }),
          border: `1px solid ${theme.border}`,
          borderRadius: theme.radius,
          overflow: "hidden",
          background: theme.background,
          // 阻止滚轮缩放被浏览器当成页面滚动（与 canvas 上的非 passive 监听配合）
          overscrollBehavior: "contain",
        }}
      >
        <canvas
          ref={canvasRef}
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
        {/* 图层面板（右上下拉，避免挡住画布中央） */}
        {layerPanelOpen && (
          <div style={{ position: "absolute", top: 44, right: 8, zIndex: 2 }}>
            <LayerPanel
              theme={theme}
              layers={layerList}
              activeLayerId={activeLayerId}
              readOnly={readOnly}
              onSelect={(layerId) => void selectLayer(layerId)}
              onToggleVisible={(layerId, visible) => void handleToggleLayerVisible(layerId, visible)}
              onRename={(layerId, name) => void handleRenameLayer(layerId, name)}
              onOpacity={(layerId, opacity) => void handleLayerOpacity(layerId, opacity)}
              onMove={(layerId, direction) => void handleMoveLayer(layerId, direction)}
              onAdd={(name, type) => void handleAddLayer(name, type)}
              onRemove={(layerId) => void handleRemoveLayer(layerId)}
            />
          </div>
        )}

        <button
          type="button"
          onClick={() => setLayerPanelOpen((open) => !open)}
          style={{ ...buttonStyle(theme), position: "absolute", top: 8, right: 8, zIndex: 3 }}
        >
          图层 {layerList.length}
        </button>
        <button
          type="button"
          onClick={() => setPanelOpen((open) => !open)}
          style={{ ...buttonStyle(theme), position: "absolute", top: 8, right: 84, zIndex: 3 }}
        >
          说明
        </button>
        {panelOpen && (
          <div
            style={{
              position: "absolute",
              top: 40,
              right: 84,
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
            <div>点标记可拖动 · 标记可删除</div>
            <div>停止绘制 3 秒后自动保存</div>
          </div>
        )}

        {/* 白板改尺寸 */}
        {resizeOpen && meta && (
          <div
            style={{
              position: "absolute",
              right: 12,
              top: 48,
              width: 280,
              padding: 10,
              fontSize: 12,
              lineHeight: 1.8,
              background: `${theme.panel}f2`,
              border: `1px solid ${theme.border}`,
              borderRadius: theme.radius,
              color: theme.textDim,
            }}
          >
            <div style={{ color: theme.text, marginBottom: 4 }}>白板尺寸</div>
            <div>
              当前 {meta.board.width}×{meta.board.height}
            </div>
            <div style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 6 }}>
              <input
                type="number"
                min={512}
                max={16384}
                step={128}
                value={resizeWidth}
                onChange={(event) => setResizeWidth(Number(event.target.value))}
                style={{
                  width: 90,
                  background: theme.background,
                  color: theme.text,
                  border: `1px solid ${theme.border}`,
                  borderRadius: theme.radius,
                  padding: "3px 6px",
                  fontSize: 12,
                }}
              />
              <span>宽（高自动一半）</span>
            </div>
            {(() => {
              const info = describeResize(meta.board, resizeWidth);
              return (
                <div style={{ marginTop: 6, color: info.level === "warn" ? "#c25e5e" : theme.textDim }}>
                  将变为 {info.normalizedWidth}×{info.normalizedWidth / 2}
                  <br />
                  {info.message.replace(/\*\*/g, "")}
                </div>
              );
            })()}
            <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
              <ToolButton
                theme={theme}
                label={resizing ? "处理中…" : "确认改尺寸"}
                disabled={resizing || resizeWidth === meta.board.width}
                onClick={() => void handleResize(resizeWidth)}
              />
              <ToolButton theme={theme} label="取消" onClick={() => setResizeOpen(false)} />
            </div>
          </div>
        )}

        {/* 面积统计面板 */}
        {statsOpen && (
          <div
            style={{
              position: "absolute",
              right: 12,
              bottom: 12,
              width: 240,
              padding: 10,
              fontSize: 12,
              background: `${theme.panel}f2`,
              border: `1px solid ${theme.border}`,
              borderRadius: theme.radius,
              color: theme.textDim,
            }}
          >
            <div style={{ color: theme.text, marginBottom: 6 }}>
              面积统计（半径 {Math.round(radiusKm)} km）
            </div>
            {!stats && <div>点击工具栏「统计」计算</div>}
            {stats && (
              <>
                <div style={{ marginBottom: 6 }}>
                  已画 {formatArea(stats.paintedKm2)}（占天体表面 {stats.paintedPercent.toFixed(1)}%）
                </div>
                {stats.terrains.slice(0, 8).map((terrain) => (
                  <div key={terrain.name} style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <span
                      style={{
                        width: 10,
                        height: 10,
                        borderRadius: 2,
                        background: terrain.color,
                        flex: "0 0 auto",
                      }}
                    />
                    <span style={{ flex: 1 }}>{terrain.name}</span>
                    <span style={{ color: theme.text }}>{formatArea(terrain.areaKm2)}</span>
                  </div>
                ))}
                {stats.terrains.length > 8 && <div>…还有 {stats.terrains.length - 8} 项</div>}
              </>
            )}
          </div>
        )}

        {/* 天体半径设定：只影响读数，不改已画内容 */}
        {radiusOpen && (
          <div
            style={{
              position: "absolute",
              right: 12,
              top: 48,
              width: 250,
              padding: 10,
              fontSize: 12,
              lineHeight: 1.8,
              background: `${theme.panel}f2`,
              border: `1px solid ${theme.border}`,
              borderRadius: theme.radius,
              color: theme.textDim,
            }}
          >
            <div style={{ color: theme.text, marginBottom: 4 }}>天体半径</div>
            <div>比例尺与面积都按它换算；改半径不动已画内容。</div>
            <div style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 6 }}>
              <input
                type="number"
                min={100}
                max={1000000}
                value={Math.round(radiusKm)}
                onChange={(event) => handleSetRadius(Number(event.target.value))}
                style={{
                  width: 90,
                  background: theme.background,
                  color: theme.text,
                  border: `1px solid ${theme.border}`,
                  borderRadius: theme.radius,
                  padding: "3px 6px",
                  fontSize: 12,
                }}
              />
              <span>km</span>
            </div>
            <div style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
              {[
                { name: "地球", km: 6371 },
                { name: "火星", km: 3390 },
                { name: "月球", km: 1737 },
              ].map((preset) => (
                <button
                  key={preset.name}
                  type="button"
                  onClick={() => handleSetRadius(preset.km)}
                  style={{ ...buttonStyle(theme), padding: "3px 8px" }}
                >
                  {preset.name} {preset.km}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* 本地草稿恢复提示：不静默覆盖，也不静默丢弃 */}
        {draftPrompt && (
          <div
            style={{
              position: "absolute",
              left: 12,
              right: 12,
              top: 12,
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "8px 10px",
              background: theme.panel,
              border: `1px solid ${theme.accent}`,
              borderRadius: theme.radius,
              fontSize: 13,
            }}
          >
            <span style={{ flex: 1 }}>
              发现未保存的本地内容（{formatTime(draftPrompt.savedAt)}），是否恢复？
            </span>
            <ToolButton theme={theme} label="恢复" onClick={() => void handleRestoreDraft()} />
            <ToolButton theme={theme} label="放弃" onClick={() => void handleDiscardDraft()} />
          </div>
        )}

        {/* 新增标记的命名表单（就地输入，不弹独立窗口） */}
        {pendingMarker && (
          <div
            style={{
              position: "absolute",
              left: 12,
              bottom: 12,
              display: "flex",
              gap: 8,
              alignItems: "center",
              padding: "8px 10px",
              background: theme.panel,
              border: `1px solid ${theme.accent}`,
              borderRadius: theme.radius,
              fontSize: 13,
            }}
          >
            <span style={{ color: theme.textDim }}>标记名称</span>
            <input
              autoFocus
              value={markerLabel}
              onChange={(event) => setMarkerLabel(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  void handleCreateMarker();
                } else if (event.key === "Escape") {
                  setPendingMarker(null);
                }
              }}
              placeholder="如：银月城"
              style={{
                background: theme.background,
                color: theme.text,
                border: `1px solid ${theme.border}`,
                borderRadius: theme.radius,
                padding: "4px 8px",
                fontSize: 13,
                width: 150,
              }}
            />
            <ToolButton theme={theme} label="创建" onClick={() => void handleCreateMarker()} />
            <ToolButton theme={theme} label="取消" onClick={() => setPendingMarker(null)} />
          </div>
        )}

        {/* 标记列表 */}
        {markerCount > 0 && (
          <div
            style={{
              position: "absolute",
              left: 12,
              top: 12,
              width: 190,
              maxHeight: 260,
              overflowY: "auto",
              padding: 8,
              fontSize: 12,
              background: `${theme.panel}e6`,
              border: `1px solid ${theme.border}`,
              borderRadius: theme.radius,
              color: theme.textDim,
            }}
          >
            <div style={{ marginBottom: 6, color: theme.text }}>标记 {markerCount}</div>
            {markerStoreRef.current?.markers.map((marker) => (
              <div
                key={marker.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "3px 0",
                  borderTop: `1px solid ${theme.border}`,
                }}
              >
                <button
                  type="button"
                  onClick={() => {
                    // 点击列表项：聚焦到该标记（把标记移到视口中心）
                    const container = containerRef.current;
                    if (!container) {
                      return;
                    }
                    const zoom = viewportRef.current.zoom;
                    setViewport({
                      zoom,
                      offsetX: marker.x - container.clientWidth / 2 / zoom,
                      offsetY: marker.y - container.clientHeight / 2 / zoom,
                    });
                    selectedMarkerIdRef.current = marker.id;
                    setMarkerTick((tick) => tick + 1);
                  }}
                  style={{
                    flex: 1,
                    textAlign: "left",
                    background: "transparent",
                    border: "none",
                    color:
                      selectedMarkerIdRef.current === marker.id ? theme.accent : theme.textDim,
                    cursor: "pointer",
                    fontSize: 12,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {marker.label || "未命名"}
                </button>
                {!readOnly && (
                  <button
                    type="button"
                    title="删除标记"
                    onClick={() => void handleDeleteMarker(marker)}
                    style={{
                      background: "transparent",
                      border: "none",
                      color: theme.textFaint,
                      cursor: "pointer",
                      fontSize: 12,
                    }}
                  >
                    ×
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 底部信息条：文字色跟随渲染风格（手绘模式画布是暗纸，仍用亮字保持可读） */}
      <div
        style={{
          display: "flex",
          gap: 12,
          flexWrap: "wrap",
          fontSize: 12,
          color: theme.textFaint,
        }}
      >
        <span>
          {meta ? `${meta.board.width}×${meta.board.height}` : "—"} · 缩放 {zoomPercent}%
        </span>
        {readout && (
          <span>
            {readout.lon.toFixed(1)}°, {readout.lat.toFixed(1)}° · 每像素{" "}
            {formatDistance(readout.kmPerPixel)} · 变形 ×{readout.deform.toFixed(2)}
          </span>
        )}
        {measureResult && measureResult.points.length >= 2 && (
          <span style={{ color: theme.accent }}>
            测量 {formatDistance(measureResult.polylineKm)} · 直线{" "}
            {formatDistance(measureResult.directKm)} · 方位 {Math.round(measureResult.directBearing)}°
          </span>
        )}
        <span>待保存瓦片 {dirtyCount}</span>
        {/* 历史步数：既给用户反馈，也方便一眼看出「画了但没进历史栈」这类问题 */}
        <span>历史 {historyRef.current.undoCount} 步</span>
        {markerCount > 0 && <span>标记 {markerCount}</span>}
        {draftState !== "none" && (
          <span>{draftState === "saved" ? "本地草稿已保存" : "本地草稿：有未同步内容"}</span>
        )}
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
 * 由瓦片仓库与当前半径构造白板规格（比例尺与面积都依赖它）。
 * @param store 瓦片仓库
 * @param radiusKm 天体半径
 * @returns 白板规格
 */
function boardOf(store: { width: number; height: number }, radiusKm: number): BoardSpec {
  return { width: store.width, height: store.height, projection: "equirect", radiusKm };
}

/**
 * 把时间戳格式化成「刚刚 / N 分钟前 / 具体时间」，用于草稿提示。
 * @param timestamp 时间戳
 * @returns 可读文案
 */
function formatTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  if (diff < 60_000) {
    return "刚刚";
  }
  if (diff < 3_600_000) {
    return `${Math.floor(diff / 60_000)} 分钟前`;
  }
  const date = new Date(timestamp);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
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
