import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force";
import { api } from "../lib/api";

/** 关系图接口返回结构 */
interface GraphData {
  nodes: Array<{ id: string; title: string; categoryId: string }>;
  links: Array<{ source: string; target: string }>;
}

/** 世界信息（本页只用到名称与分类） */
interface WorldInfo {
  name: string;
  categories: Array<{ id: string; name: string; color: string | null }>;
}

/** 模拟节点：d3-force 会在对象上写入 x / y / vx / vy */
interface SimNode extends SimulationNodeDatum {
  id: string;
  title: string;
  categoryId: string;
  /** 关联度（连接的边数） */
  degree: number;
}

/** 模拟边 */
interface SimLink extends SimulationLinkDatum<SimNode> {
  source: string | SimNode;
  target: string | SimNode;
}

/** 分类没有自定义颜色时的备用调色板 */
const PALETTE = ["#c9a15c", "#6fa06f", "#6a8fbf", "#b06a8f", "#8f7fbf", "#bf8f6a", "#5fa8a0", "#a8a05f"];

/**
 * 节点绘制半径：关联越多节点越大，封顶避免遮挡。
 * @param degree 关联度
 * @returns 半径（像素）
 */
function nodeRadius(degree: number): number {
  return 8 + Math.min(degree * 1.5, 12);
}

/**
 * 标题截断：超过 10 个字符显示省略号。
 * @param title 条目标题
 * @returns 展示用标题
 */
function truncateTitle(title: string): string {
  return title.length > 10 ? `${title.slice(0, 10)}…` : title;
}

/**
 * 世界关系图页：力导向布局，支持拖拽节点、悬停高亮、点击进入条目。
 */
export default function WorldGraphPage() {
  const { worldId = "" } = useParams<{ worldId: string }>();
  const navigate = useNavigate();

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const simRef = useRef<Simulation<SimNode, SimLink> | null>(null);
  const simNodesRef = useRef<SimNode[]>([]);
  const hoverIdRef = useRef<string | null>(null);
  const dragRef = useRef<{ node: SimNode | null; moved: boolean; startX: number; startY: number }>({
    node: null,
    moved: false,
    startX: 0,
    startY: 0,
  });

  const [world, setWorld] = useState<WorldInfo | null>(null);
  const [nodes, setNodes] = useState<SimNode[]>([]);
  const [links, setLinks] = useState<SimLink[]>([]);
  const [hideIsolated, setHideIsolated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // 加载世界信息与图数据，并统计每个节点的关联度
  useEffect(() => {
    setLoading(true);
    Promise.all([api<WorldInfo>(`/api/worlds/${worldId}`), api<GraphData>(`/api/worlds/${worldId}/graph`)])
      .then(([worldData, graph]) => {
        const degree = new Map<string, number>();
        for (const link of graph.links) {
          degree.set(link.source, (degree.get(link.source) ?? 0) + 1);
          degree.set(link.target, (degree.get(link.target) ?? 0) + 1);
        }
        setWorld(worldData);
        setNodes(graph.nodes.map((node) => ({ ...node, degree: degree.get(node.id) ?? 0 })));
        setLinks(graph.links.map((link) => ({ source: link.source, target: link.target })));
        setError("");
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, [worldId]);

  /** 分类 → 颜色：优先分类自定义色，否则按调色板轮换 */
  const colorOf = useMemo(() => {
    const map = new Map<string, string>();
    (world?.categories ?? []).forEach((category, index) => {
      map.set(category.id, category.color || PALETTE[index % PALETTE.length] || "#8a8378");
    });
    return (categoryId: string): string => map.get(categoryId) ?? "#8a8378";
  }, [world]);

  /** 分类 → 展示颜色（图例用） */
  const legendColor = (index: number, custom: string | null): string =>
    custom || PALETTE[index % PALETTE.length] || "#8a8378";

  // 构建力导向模拟并持续绘制（每帧重绘，便于悬停高亮与拖拽反馈）
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || nodes.length === 0) {
      return;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return;
    }

    // 复制数据：d3-force 会直接修改节点与边的对象
    const visibleNodes = (hideIsolated ? nodes.filter((node) => node.degree > 0) : nodes).map((node) => ({ ...node }));
    const visibleIds = new Set(visibleNodes.map((node) => node.id));
    const visibleLinks: SimLink[] = links
      .filter((link) => visibleIds.has(String(link.source)) && visibleIds.has(String(link.target)))
      .map((link) => ({ source: String(link.source), target: String(link.target) }));

    const simulation = forceSimulation<SimNode>(visibleNodes)
      .force(
        "link",
        forceLink<SimNode, SimLink>(visibleLinks)
          .id((node) => node.id)
          .distance(90)
          .strength(0.7),
      )
      .force("charge", forceManyBody().strength(-220))
      .force("center", forceCenter(0, 0))
      .force("collide", forceCollide<SimNode>().radius((node) => nodeRadius(node.degree) + 6));
    simRef.current = simulation;
    simNodesRef.current = visibleNodes;

    let rafId = 0;

    /** 每一帧：适配画布尺寸，绘制连线、节点与标题 */
    const draw = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(height * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);

      const centerX = width / 2;
      const centerY = height / 2;
      const hoverId = hoverIdRef.current;

      // 连线：悬停节点相连的边高亮
      for (const link of visibleLinks) {
        const source = link.source as SimNode;
        const target = link.target as SimNode;
        if (typeof source !== "object" || typeof target !== "object") {
          continue;
        }
        const active = hoverId !== null && (source.id === hoverId || target.id === hoverId);
        ctx.strokeStyle = active ? "rgba(201, 161, 92, 0.9)" : "rgba(180, 165, 135, 0.22)";
        ctx.lineWidth = active ? 1.6 : 1;
        ctx.beginPath();
        ctx.moveTo(centerX + (source.x ?? 0), centerY + (source.y ?? 0));
        ctx.lineTo(centerX + (target.x ?? 0), centerY + (target.y ?? 0));
        ctx.stroke();
      }

      // 节点与标题
      ctx.font = "11px sans-serif";
      ctx.textAlign = "center";
      for (const node of visibleNodes) {
        const x = centerX + (node.x ?? 0);
        const y = centerY + (node.y ?? 0);
        const radius = nodeRadius(node.degree);
        const active = node.id === hoverId;
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.fillStyle = colorOf(node.categoryId);
        ctx.globalAlpha = active ? 1 : 0.85;
        ctx.fill();
        ctx.globalAlpha = 1;
        if (active) {
          ctx.strokeStyle = "#e8e0d3";
          ctx.lineWidth = 2;
          ctx.stroke();
        }
        ctx.fillStyle = active ? "#e8e0d3" : "#a89c88";
        ctx.fillText(truncateTitle(node.title), x, y + radius + 14);
      }

      rafId = requestAnimationFrame(draw);
    };
    rafId = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(rafId);
      simulation.stop();
      simRef.current = null;
    };
  }, [nodes, links, hideIsolated, colorOf]);

  /** 指针坐标转画布坐标（CSS 像素） */
  const toCanvasPoint = (event: PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  /** 命中测试：找出指针附近的节点 */
  const findNodeAt = (x: number, y: number): SimNode | null => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return null;
    }
    const centerX = canvas.clientWidth / 2;
    const centerY = canvas.clientHeight / 2;
    let found: SimNode | null = null;
    let bestDistanceSq = 18 * 18;
    for (const node of simNodesRef.current) {
      const dx = centerX + (node.x ?? 0) - x;
      const dy = centerY + (node.y ?? 0) - y;
      const distanceSq = dx * dx + dy * dy;
      if (distanceSq < bestDistanceSq) {
        bestDistanceSq = distanceSq;
        found = node;
      }
    }
    return found;
  };

  /** 按下：命中节点则开始拖拽 */
  const handlePointerDown = (event: PointerEvent<HTMLCanvasElement>) => {
    const point = toCanvasPoint(event);
    const node = findNodeAt(point.x, point.y);
    dragRef.current = { node, moved: false, startX: point.x, startY: point.y };
    if (node) {
      node.fx = node.x;
      node.fy = node.y;
      simRef.current?.alphaTarget(0.25).restart();
    }
  };

  /** 移动：拖拽节点或更新悬停高亮 */
  const handlePointerMove = (event: PointerEvent<HTMLCanvasElement>) => {
    const point = toCanvasPoint(event);
    const drag = dragRef.current;
    const canvas = event.currentTarget;

    if (drag.node) {
      if (Math.abs(point.x - drag.startX) + Math.abs(point.y - drag.startY) > 4) {
        drag.moved = true;
      }
      drag.node.fx = point.x - canvas.clientWidth / 2;
      drag.node.fy = point.y - canvas.clientHeight / 2;
      return;
    }

    const node = findNodeAt(point.x, point.y);
    hoverIdRef.current = node?.id ?? null;
    canvas.style.cursor = node ? "pointer" : "default";
  };

  /** 抬起：未移动视为点击，跳转条目 */
  const handlePointerUp = (event: PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (drag.node) {
      simRef.current?.alphaTarget(0);
      if (!drag.moved) {
        navigate(`/w/${worldId}/entries/${drag.node.id}`);
      } else {
        drag.node.fx = null;
        drag.node.fy = null;
      }
    }
    dragRef.current = { node: null, moved: false, startX: event.clientX, startY: event.clientY };
  };

  /** 指针离开画布：清理悬停与拖拽状态 */
  const handlePointerLeave = () => {
    hoverIdRef.current = null;
    const drag = dragRef.current;
    if (drag.node) {
      drag.node.fx = null;
      drag.node.fy = null;
      simRef.current?.alphaTarget(0);
      dragRef.current = { node: null, moved: false, startX: 0, startY: 0 };
    }
  };

  if (error) {
    return <div className="notice error">{error}</div>;
  }
  if (loading || !world) {
    return <div className="loading">加载中…</div>;
  }

  return (
    <>
      <h1 className="page-title">{world.name} · 关系图</h1>
      <p className="page-subtitle">点击节点进入条目，拖拽可调整位置，悬停查看关联</p>

      <div className="graph-toolbar">
        <div className="graph-legend">
          {world.categories.map((category, index) => (
            <span key={category.id}>
              <span className="legend-dot" style={{ background: legendColor(index, category.color) }} />
              {category.name}
            </span>
          ))}
        </div>
        <label className="graph-toggle">
          <input
            type="checkbox"
            checked={hideIsolated}
            onChange={(event) => setHideIsolated(event.target.checked)}
          />
          隐藏无关联条目
        </label>
      </div>

      {nodes.length === 0 && <div className="empty">还没有条目，先去编写几个吧</div>}
      {nodes.length > 0 && links.length === 0 && (
        <div className="notice">还没有条目互相关联。在编辑器中选中文字并「关联条目」，这里就会产生连线。</div>
      )}

      {nodes.length > 0 && (
        <div className="graph-wrap">
          <canvas
            ref={canvasRef}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerLeave={handlePointerLeave}
          />
        </div>
      )}

      <div style={{ marginTop: 12 }}>
        <Link to={`/w/${worldId}/entries`} className="btn ghost small">
          返回条目列表
        </Link>
      </div>
    </>
  );
}
