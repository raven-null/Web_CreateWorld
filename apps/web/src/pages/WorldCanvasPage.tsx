import { useEffect, useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { api } from "../lib/api";
import { dispatchCanvas, useCanvasState } from "../lib/weave-store";

/** 世界信息（只为取分类列表） */
interface WorldInfo {
  id: string;
  name: string;
  categories: Array<{ id: string; name: string }>;
}

/**
 * 画布页：顶部是分类导航栏（人物 / 地点 / 势力 …），每个分类一块画布。
 *
 * 画布本体（iframe 与同步逻辑）由常驻在 WorldLayout 里的 CanvasHost 承载，
 * 本页只负责分类切换与状态展示——因此切页面、切分类都不会重新加载画布。
 */
export default function WorldCanvasPage() {
  const { worldId = "" } = useParams<{ worldId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const [world, setWorld] = useState<WorldInfo | null>(null);
  const [error, setError] = useState("");
  const canvas = useCanvasState();

  // 分类列表
  useEffect(() => {
    api<WorldInfo>(`/api/worlds/${worldId}`)
      .then((data) => {
        setWorld(data);
        setError("");
      })
      .catch((err: Error) => setError(err.message));
  }, [worldId]);

  // 当前分类：URL 的 ?cat= 优先，其次第一个分类
  const activeCategoryId = useMemo(() => {
    const fromUrl = searchParams.get("cat");
    if (fromUrl && (world?.categories ?? []).some((item) => item.id === fromUrl)) {
      return fromUrl;
    }
    return world?.categories[0]?.id ?? "";
  }, [searchParams, world]);

  // 分类确定后通知常驻画布宿主加载（世界或分类变化都会触发）
  useEffect(() => {
    if (!worldId || !activeCategoryId) {
      return;
    }
    dispatchCanvas({ type: "activate", worldId, categoryId: activeCategoryId });
  }, [activeCategoryId, worldId]);

  /** 切换分类：只改 URL 参数，画布宿主按新分类取数据（已有缓存则立即上屏） */
  const switchCategory = (categoryId: string) => {
    setSearchParams({ cat: categoryId }, { replace: true });
  };

  if (error) {
    return <div className="notice error">{error}</div>;
  }
  if (!world) {
    return <div className="loading">加载中…</div>;
  }
  if (world.categories.length === 0) {
    return (
      <div className="notice">
        这个世界还没有分类，先去
        <Link to={`/w/${worldId}/settings`}> 世界设置 </Link>
        添加分类，画布会按分类分区。
      </div>
    );
  }

  /** 同步状态文案（平时不打扰，只在保存中或出错时值得注意） */
  const stateLabel =
    canvas.phase === "syncing"
      ? "保存中"
      : canvas.phase === "error"
        ? "同步异常"
        : canvas.phase === "local"
          ? "本地缓存"
          : "已同步";

  return (
    <div className="canvas-page has-tabs">
      <nav className="canvas-tabs" aria-label="分类画布切换">
        <div className="canvas-tabs-list">
          {world.categories.map((category) => (
            <button
              key={category.id}
              type="button"
              className={`canvas-tab${category.id === activeCategoryId ? " is-active" : ""}`}
              onClick={() => switchCategory(category.id)}
            >
              {category.name}
            </button>
          ))}
        </div>
        <span className={`canvas-sync canvas-sync-${canvas.phase}`} title={canvas.message}>
          {stateLabel}
        </span>
      </nav>
      {/* 画布本体由常驻的 CanvasHost 渲染在内容区，这里只占位 */}
      <div className="canvas-placeholder" />
    </div>
  );
}
