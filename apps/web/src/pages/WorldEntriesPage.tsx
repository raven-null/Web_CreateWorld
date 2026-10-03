import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../lib/api";
import { formatTime } from "../lib/format";

/** 世界详情（本页只用到部分字段） */
interface WorldInfo {
  id: string;
  name: string;
  canEdit: boolean;
  categories: Array<{ id: string; name: string }>;
}

/** 条目列表项 */
interface EntryItem {
  id: string;
  title: string;
  categoryId: string;
  wordCount: number;
  protected: boolean;
  updatedAt: number;
  lastEditorName: string;
}

/**
 * 条目列表页：左侧分类导航，右侧条目列表与搜索，支持新建条目。
 */
export default function WorldEntriesPage() {
  const { worldId = "" } = useParams<{ worldId: string }>();
  const navigate = useNavigate();

  const [world, setWorld] = useState<WorldInfo | null>(null);
  const [entries, setEntries] = useState<EntryItem[]>([]);
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [keyword, setKeyword] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [showCreate, setShowCreate] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newCategoryId, setNewCategoryId] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");

  // 加载世界信息（分类与权限）
  useEffect(() => {
    api<WorldInfo>(`/api/worlds/${worldId}`)
      .then((data) => {
        setWorld(data);
        setNewCategoryId((current) => current || data.categories[0]?.id || "");
      })
      .catch((err: Error) => setError(err.message));
  }, [worldId]);

  // 加载条目列表：分类或搜索词变化时重新拉取（搜索防抖 300ms）
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setLoading(true);
      const params = new URLSearchParams();
      if (categoryId) {
        params.set("categoryId", categoryId);
      }
      if (keyword.trim()) {
        params.set("q", keyword.trim());
      }
      api<EntryItem[]>(`/api/worlds/${worldId}/entries?${params.toString()}`)
        .then((data) => {
          setEntries(data);
          setError("");
        })
        .catch((err: Error) => setError(err.message))
        .finally(() => setLoading(false));
    }, 300);
    return () => window.clearTimeout(timer);
  }, [worldId, categoryId, keyword]);

  /** 创建条目并进入编辑页 */
  const handleCreate = async (event: FormEvent) => {
    event.preventDefault();
    setCreateError("");
    setCreating(true);
    try {
      const data = await api<{ id: string }>(`/api/worlds/${worldId}/entries`, {
        method: "POST",
        body: { title: newTitle.trim(), categoryId: newCategoryId },
      });
      navigate(`/w/${worldId}/entries/${data.id}/edit`);
    } catch (err) {
      setCreateError((err as Error).message);
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="entries-layout">
      <aside className="entries-sidebar">
        <div className="section-title" style={{ marginBottom: 10 }}>
          {world ? world.name : "…"}
        </div>
        <button
          type="button"
          className={`entry-cat${categoryId === null ? " active" : ""}`}
          onClick={() => setCategoryId(null)}
        >
          全部条目
        </button>
        {(world?.categories ?? []).map((category) => (
          <button
            key={category.id}
            type="button"
            className={`entry-cat${categoryId === category.id ? " active" : ""}`}
            onClick={() => setCategoryId(category.id)}
          >
            {category.name}
          </button>
        ))}
      </aside>

      <section className="entries-main">
        <div className="entries-toolbar">
          <input
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            placeholder="搜索条目标题…"
          />
          {world?.canEdit && (
            <button type="button" className="btn" onClick={() => setShowCreate((value) => !value)}>
              新建条目
            </button>
          )}
          <Link to={`/w/${worldId}/search`} className="btn ghost">
            全文搜索
          </Link>
        </div>

        {error && <div className="notice error">{error}</div>}

        {showCreate && world?.canEdit && (
          <form className="create-entry-form" onSubmit={handleCreate}>
            <input
              value={newTitle}
              onChange={(event) => setNewTitle(event.target.value)}
              placeholder="条目标题（如：银月城）"
              autoFocus
              required
            />
            <select value={newCategoryId} onChange={(event) => setNewCategoryId(event.target.value)}>
              {world.categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </select>
            <button type="submit" className="btn small" disabled={creating}>
              {creating ? "创建中…" : "创建并编辑"}
            </button>
            {createError && <div className="notice error">{createError}</div>}
          </form>
        )}

        {loading && <div className="loading">加载中…</div>}
        {!loading && entries.length === 0 && <div className="empty">还没有条目</div>}

        <div className="entry-list">
          {entries.map((entry) => (
            <Link key={entry.id} to={`/w/${worldId}/entries/${entry.id}`} className="entry-row">
              <span className="entry-row-title">
                {entry.title}
                {entry.protected && <span className="badge">保护</span>}
              </span>
              <span className="entry-row-meta">
                {entry.lastEditorName && `${entry.lastEditorName} · `}
                {entry.wordCount} 字 · {formatTime(entry.updatedAt)}
              </span>
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}
