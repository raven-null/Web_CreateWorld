import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../lib/api";
import { formatTime } from "../lib/format";
import PageLoader from "../components/PageLoader";

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

  /** 按当前分类与搜索词拉取条目列表 */
  const fetchEntries = async () => {
    setLoading(true);
    const params = new URLSearchParams();
    if (categoryId) {
      params.set("categoryId", categoryId);
    }
    if (keyword.trim()) {
      params.set("q", keyword.trim());
    }
    try {
      setEntries(await api<EntryItem[]>(`/api/worlds/${worldId}/entries?${params.toString()}`));
      setError("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  // 分类 / 世界变化：立即加载（不等防抖，切页更快）
  useEffect(() => {
    void fetchEntries();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [worldId, categoryId]);

  // 搜索词变化：防抖 300ms（跳过首次，避免与上面的加载重复）
  const keywordFirstRun = useRef(true);
  useEffect(() => {
    if (keywordFirstRun.current) {
      keywordFirstRun.current = false;
      return;
    }
    const timer = window.setTimeout(() => void fetchEntries(), 300);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyword]);

  /**
   * 创建条目后直接去画布看它。
   *
   * 节点与条目是同一份数据（一个节点 = 一个条目），所以新建完最有用的反馈
   * 就是「在画布上看到它」——跳过去并把它居中高亮，避免用户以为要两边各建一次。
   */
  const handleCreate = async (event: FormEvent) => {
    event.preventDefault();
    setCreateError("");
    setCreating(true);
    try {
      const data = await api<{ id: string }>(`/api/worlds/${worldId}/entries`, {
        method: "POST",
        body: { title: newTitle.trim(), categoryId: newCategoryId },
      });
      // 去画布定位这个新节点；带 ?edit=1 让它顺带打开条目页写正文
      navigate(`/w/${worldId}/canvas?cat=${newCategoryId}&focus=${data.id}&edit=1`);
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
          <button
            type="button"
            className="btn ghost"
            onClick={() => void fetchEntries()}
            title="重新加载最新数据"
          >
            刷新
          </button>
          <Link to={`/w/${worldId}/search`} className="btn ghost">
            全文搜索
          </Link>
        </div>

        {/* 与画布的一致性提示：节点即条目，两边是同一份数据 */}
        <p className="entries-hint">
          共 <strong>{entries.length}</strong> 条
          {categoryId ? "（当前分类）" : ""}　·　条目与画布的节点一一对应：
          在画布上新增一个节点，这里就会多出一条条目
        </p>

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

        {loading && <PageLoader variant="block" label="加载中…" />}
        {!loading && entries.length === 0 && <div className="empty">还没有条目</div>}

        <div className="entry-list">
          {entries.map((entry) => (
            <div key={entry.id} className="entry-row-wrap">
              <Link to={`/w/${worldId}/entries/${entry.id}`} className="entry-row">
                <span className="entry-row-title">
                  {entry.title}
                  {entry.protected && <span className="badge">保护</span>}
                </span>
                <span className="entry-row-meta">
                  {entry.lastEditorName && `${entry.lastEditorName} · `}
                  {entry.wordCount} 字 · {formatTime(entry.updatedAt)}
                </span>
              </Link>
              {/* 回到画布并把该条目居中高亮：条目与节点是同一份数据，两个视图之间互通 */}
              <Link
                to={`/w/${worldId}/canvas?cat=${entry.categoryId}&focus=${entry.id}`}
                className="entry-row-locate"
                title="在画布中定位这个条目"
              >
                画布
              </Link>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
