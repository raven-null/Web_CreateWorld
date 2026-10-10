/**
 * 3D 地球仪视图组件。
 *
 * 与 2D 视图共用同一份数据（白板本身就是球面贴图），所以这里只做三件事：
 * 1. 把当前栅格渲染成纹理上传
 * 2. 处理旋转 / 缩放（拖拽、滚轮）
 * 3. 提供美术效果与性能档位的控制面板
 *
 * 首期 3D 是**只读**的（浏览 / 旋转 / 截图）：球面绘制涉及拾取与投影反解，
 * 风险大收益小，先把「看」做到位（方案 §3 决策 9）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MapEditorTheme, TerrainBrush } from "@worldmap/core";
import {
  createGlobeRenderer,
  effectsForQuality,
  recommendQuality,
  type GlobeCamera,
  type GlobeEffects,
  type GlobeQuality,
  type SunPosition,
} from "./renderer-3d";

/** 3D 视图属性 */
export interface GlobeViewProps {
  theme: MapEditorTheme;
  /** 当前全幅索引栅格（可能来自多个图层的合成结果） */
  indices: Uint8Array;
  width: number;
  height: number;
  palette: TerrainBrush[];
  /** 初始朝向（由 2D 视口中心换算而来，保证切换时视野连贯） */
  initialView?: { lon: number; lat: number };
  /** 关掉全部美术效果时导出「均匀光照」（截图用） */
  onError?: (error: Error) => void;
}

/**
 * 3D 地球仪视图。
 * @param props 见 `GlobeViewProps`
 * @returns 视图节点
 */
export function GlobeView(props: GlobeViewProps): React.ReactElement {
  const { theme, indices, width, height, palette } = props;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<ReturnType<typeof createGlobeRenderer> | null>(null);
  const cameraRef = useRef<GlobeCamera>({ yaw: 0, pitch: 0.35, distance: 3 });
  const sunRef = useRef<SunPosition>({ lon: 0, lat: 0 });
  const effectsRef = useRef<GlobeEffects>(effectsForQuality("full"));
  const dragRef = useRef<{ x: number; y: number; yaw: number; pitch: number } | null>(null);
  const frameRef = useRef<number | null>(null);

  const [unsupported, setUnsupported] = useState(false);
  const [quality, setQuality] = useState<GlobeQuality>(() =>
    recommendQuality({
      screenWidth: typeof window === "undefined" ? 1920 : window.innerWidth,
      touchPrimary:
        typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(pointer: coarse)").matches : false,
    }),
  );
  const [effects, setEffects] = useState<GlobeEffects>(() => effectsForQuality(
    recommendQuality({
      screenWidth: typeof window === "undefined" ? 1920 : window.innerWidth,
      touchPrimary:
        typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(pointer: coarse)").matches : false,
    }),
  ));
  const [sunLon, setSunLon] = useState(0);

  /** 初始化渲染器（一次） */
  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    const renderer = createGlobeRenderer({
      indices,
      width,
      height,
      palette,
      colors: {
        sky: theme.globeSkyColor ?? "#070c14",
        atmosphere: theme.globeAtmosphereColor ?? "#5b8fa8",
        night: theme.globeNightColor ?? "#0a1420",
      },
    });
    if (!renderer) {
      setUnsupported(true);
      return;
    }
    rendererRef.current = renderer;
    container.appendChild(renderer.canvas);
    renderer.canvas.style.display = "block";
    renderer.canvas.style.width = "100%";
    renderer.canvas.style.height = "100%";
    renderer.canvas.style.touchAction = "none";
    renderer.canvas.style.cursor = "grab";

    const resize = (): void => {
      const rect = container.getBoundingClientRect();
      renderer.resize(rect.width, rect.height, Math.min(window.devicePixelRatio || 1, 2));
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(container);

    return () => {
      observer.disconnect();
      renderer.dispose();
      if (renderer.canvas.parentElement === container) {
        container.removeChild(renderer.canvas);
      }
      rendererRef.current = null;
    };
    // 只在挂载时创建；数据更新走下面的 effect
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 初始朝向：由 2D 视口中心换算而来，切换视图时视野连贯 */
  useEffect(() => {
    if (!props.initialView) {
      return;
    }
    cameraRef.current = {
      ...cameraRef.current,
      yaw: ((-props.initialView.lon * Math.PI) / 180),
      pitch: (props.initialView.lat * Math.PI) / 180,
    };
  }, [props.initialView]);

  /** 栅格或调色板变化时更新纹理 */
  useEffect(() => {
    rendererRef.current?.updateTexture({
      indices,
      width,
      height,
      palette,
      colors: {
        sky: theme.globeSkyColor ?? "#070c14",
        atmosphere: theme.globeAtmosphereColor ?? "#5b8fa8",
        night: theme.globeNightColor ?? "#0a1420",
      },
    });
  }, [indices, width, height, palette, theme]);

  /** 渲染循环：每帧重绘（旋转时才需要，但常驻更简单也更稳） */
  useEffect(() => {
    const loop = (): void => {
      const renderer = rendererRef.current;
      if (renderer) {
        renderer.render(cameraRef.current, sunRef.current, effectsRef.current);
      }
      frameRef.current = requestAnimationFrame(loop);
    };
    frameRef.current = requestAnimationFrame(loop);
    return () => {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
      }
    };
  }, []);

  effectsRef.current = effects;
  sunRef.current = { lon: sunLon, lat: 0 };

  /** 拖拽旋转 */
  const handlePointerDown = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      x: event.clientX,
      y: event.clientY,
      yaw: cameraRef.current.yaw,
      pitch: cameraRef.current.pitch,
    };
    event.currentTarget.style.cursor = "grabbing";
  }, []);

  const handlePointerMove = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (!drag) {
      return;
    }
    const deltaX = (event.clientX - drag.x) / 200;
    const deltaY = (event.clientY - drag.y) / 200;
    cameraRef.current = {
      ...cameraRef.current,
      yaw: drag.yaw - deltaX,
      pitch: Math.max(-1.4, Math.min(1.4, drag.pitch + deltaY)),
    };
  }, []);

  const handlePointerUp = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    dragRef.current = null;
    event.currentTarget.style.cursor = "grab";
  }, []);

  /** 滚轮缩放（距离球心的远近） */
  const handleWheel = useCallback((event: React.WheelEvent<HTMLCanvasElement>) => {
    const factor = event.deltaY < 0 ? 0.9 : 1.1;
    cameraRef.current = {
      ...cameraRef.current,
      distance: Math.max(1.35, Math.min(6, cameraRef.current.distance * factor)),
    };
  }, []);

  /** 切换档位时同步效果组合 */
  const applyQuality = useCallback((next: GlobeQuality) => {
    setQuality(next);
    setEffects(effectsForQuality(next));
  }, []);

  const sunLabel = useMemo(() => `${Math.round(sunLon)}°`, [sunLon]);

  if (unsupported) {
    return (
      <div
        style={{
          padding: 24,
          border: `1px solid ${theme.border}`,
          borderRadius: theme.radius,
          background: theme.panel,
          color: theme.textDim,
          fontSize: 13,
          lineHeight: 1.8,
        }}
      >
        当前设备不支持 3D 地球仪（需要 WebGL2）。
        <br />
        这不影响任何编辑功能——回到 2D 视图照样可以绘制、保存与导出。
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {/* 3D 控制条 */}
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
          fontSize: 12,
          color: theme.textDim,
        }}
      >
        <span>拖拽旋转 · 滚轮缩放</span>
        <span style={{ width: 1, height: 16, background: theme.border }} />
        <span>太阳经度 {sunLabel}</span>
        <input
          type="range"
          min={-180}
          max={180}
          value={sunLon}
          onChange={(event) => setSunLon(Number(event.target.value))}
          style={{ width: 130 }}
          title="拖动可移动黄昏线，看清想看的那一面"
        />
        <span style={{ width: 1, height: 16, background: theme.border }} />
        <span>档位</span>
        {(["full", "lite", "minimal"] as GlobeQuality[]).map((item) => (
          <button
            key={item}
            type="button"
            onClick={() => applyQuality(item)}
            style={{
              background: quality === item ? theme.accent : "transparent",
              color: quality === item ? "#14120f" : theme.text,
              border: `1px solid ${quality === item ? theme.accent : theme.border}`,
              borderRadius: theme.radius,
              padding: "2px 8px",
              fontSize: 12,
              cursor: "pointer",
            }}
          >
            {item === "full" ? "完整" : item === "lite" ? "精简" : "最简"}
          </button>
        ))}
        <span style={{ width: 1, height: 16, background: theme.border }} />
        {(
          [
            ["stars", "星空"],
            ["atmosphere", "大气"],
            ["dayNight", "昼夜"],
          ] as [keyof GlobeEffects, string][]
        ).map(([key, label]) => (
          <label key={key} style={{ display: "flex", alignItems: "center", gap: 4, cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={effects[key]}
              onChange={(event) => setEffects((current) => ({ ...current, [key]: event.target.checked }))}
            />
            {label}
          </label>
        ))}
      </div>

      <div
        ref={containerRef}
        style={{
          position: "relative",
          height: 520,
          border: `1px solid ${theme.border}`,
          borderRadius: theme.radius,
          overflow: "hidden",
          background: theme.globeSkyColor ?? "#070c14",
        }}
      >
        {/* canvas 由渲染器挂入；指针事件委托在容器上 */}
        <div
          style={{ position: "absolute", inset: 0 }}
          onPointerDown={handlePointerDown as unknown as React.PointerEventHandler<HTMLDivElement>}
          onPointerMove={handlePointerMove as unknown as React.PointerEventHandler<HTMLDivElement>}
          onPointerUp={handlePointerUp as unknown as React.PointerEventHandler<HTMLDivElement>}
          onWheel={handleWheel as unknown as React.WheelEventHandler<HTMLDivElement>}
        />
      </div>
    </div>
  );
}
