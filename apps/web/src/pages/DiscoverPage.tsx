import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { VISIBILITY_LABELS, type WorldSummary } from "@create-world/core";
import { ApiError, api } from "../lib/api";
import { formatTime } from "../lib/format";
import PageLoader from "../components/PageLoader";

/**
 * 发现首页：公开世界列表，支持标签筛选与排序切换。
 */
export default function DiscoverPage() {
  const [worlds, setWorlds] = useState<WorldSummary[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [sort, setSort] = useState<"updated" | "created">("updated");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  /** 是否正在展示离线缓存（网络不通时的降级展示） */
  const [offline, setOffline] = useState(false);
  /** 递增即触发重新请求（「重试」按钮用） */
  const [reloadToken, setReloadToken] = useState(0);
  /** 加载已耗时（秒）：超过阈值就显示出来，让用户知道是「在等」而不是「卡死」 */
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  useEffect(() => {
    if (!loading) {
      setElapsedSeconds(0);
      return;
    }
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      setElapsedSeconds(Math.round((Date.now() - startedAt) / 1000));
    }, 500);
    return () => window.clearInterval(timer);
  }, [loading]);

  // 标签筛选条选项
  useEffect(() => {
    api<string[]>("/api/discover/tags")
      .then(setTags)
      .catch(() => setTags([]));
  }, []);

  // 世界列表：标签或排序变化时重新拉取；网络不通时退化为展示上次缓存并提示
  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams({ sort });
    if (activeTag) {
      params.set("tag", activeTag);
    }
    api<{ items: WorldSummary[] }>(`/api/discover?${params.toString()}`)
      .then((data) => {
        setWorlds(data.items);
        setError("");
        setOffline(false);
      })
      .catch((err: unknown) => {
        const cached = err instanceof ApiError ? (err.cachedData as { items: WorldSummary[] } | undefined) : undefined;
        if (cached?.items) {
          // 有上次成功的数据：先展示，标明是离线内容
          setWorlds(cached.items);
          setOffline(true);
          setError("");
        } else {
          setError(err instanceof Error ? err.message : "加载失败");
        }
      })
      .finally(() => setLoading(false));
  }, [activeTag, sort, reloadToken]);

  return (
    <>
      <h1 className="page-title">发现世界</h1>
      <p className="page-subtitle">浏览公开世界，寻找可以参与编写的创作现场</p>

      <div className="tag-row">
        <button
          type="button"
          className={`tag-chip${activeTag === null ? " active" : ""}`}
          onClick={() => setActiveTag(null)}
        >
          全部
        </button>
        {tags.map((tag) => (
          <button
            key={tag}
            type="button"
            className={`tag-chip${activeTag === tag ? " active" : ""}`}
            onClick={() => setActiveTag(tag)}
          >
            {tag}
          </button>
        ))}
        <span style={{ flex: 1 }} />
        <button
          type="button"
          className={`tag-chip${sort === "updated" ? " active" : ""}`}
          onClick={() => setSort("updated")}
        >
          最近更新
        </button>
        <button
          type="button"
          className={`tag-chip${sort === "created" ? " active" : ""}`}
          onClick={() => setSort("created")}
        >
          最新创建
        </button>
      </div>

      {error && (
        <div className="notice error">
          {error}
          <button type="button" className="btn ghost small" style={{ marginLeft: 10 }} onClick={() => setReloadToken((value) => value + 1)}>
            重试
          </button>
        </div>
      )}
      {offline && (
        <div className="notice">
          网络暂时连不上服务器，下面显示的是上次成功加载的内容。
          <button type="button" className="btn ghost small" style={{ marginLeft: 10 }} onClick={() => setReloadToken((value) => value + 1)}>
            重新连接
          </button>
        </div>
      )}
      {loading && (
        <PageLoader
          variant="page"
          label={
            elapsedSeconds >= 4
              ? `正在加载…已等待 ${elapsedSeconds} 秒（网络较慢或连不上，会自动重试一次）`
              : "加载中…"
          }
        />
      )}
      {!loading && !offline && worlds.length === 0 && <div className="empty">还没有公开的世界，去创建第一个吧</div>}

      <div className="card-grid">
        {worlds.map((world) => (
          <Link key={world.id} to={`/w/${world.id}`} className="card">
            <h2 className="card-title">
              {world.name}
              <span className={`badge${world.visibility === "public_edit" ? " edit" : ""}`}>
                {world.visibility === "public_edit" ? "开放编写" : VISIBILITY_LABELS[world.visibility]}
              </span>
            </h2>
            <p className="card-intro">{world.intro || "（暂无简介）"}</p>
            <div className="card-meta">
              <span>{world.ownerName}</span>
              <span>条目 {world.entryCount}</span>
              <span>成员 {world.memberCount}</span>
              <span>更新于 {formatTime(world.updatedAt)}</span>
            </div>
          </Link>
        ))}
      </div>
    </>
  );
}
