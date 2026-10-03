import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { VISIBILITY_LABELS, type WorldSummary } from "@create-world/core";
import { api } from "../lib/api";
import { formatTime } from "../lib/format";

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

  // 标签筛选条选项
  useEffect(() => {
    api<string[]>("/api/discover/tags")
      .then(setTags)
      .catch(() => setTags([]));
  }, []);

  // 世界列表：标签或排序变化时重新拉取
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
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, [activeTag, sort]);

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

      {error && <div className="notice error">{error}</div>}
      {loading && <div className="loading">加载中…</div>}
      {!loading && worlds.length === 0 && <div className="empty">还没有公开的世界，去创建第一个吧</div>}

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
