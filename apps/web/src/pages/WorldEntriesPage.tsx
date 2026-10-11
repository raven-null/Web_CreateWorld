import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../lib/api";
import { formatTime } from "../lib/format";
import { useCachedResource } from "../lib/page-cache";
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

  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [keyword, setKeyword] = useState("");
  const [error, setError] = useState("");

  const [showCreate, setShowCreate] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newCategoryId, setNewCategoryId] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");

  /** 搜索词防抖后的值：驱动列表请求，避免每敲一个字都发请求 */
  const [debouncedKeyword, setDebouncedKeyword] = useState("");
  const keywordFirstRun = useRef(true);
  useEffect(() => {
    if (keywordFirstRun.current) {
      keywordFirstRun.current = false;
      return;
    }
    const timer = window.setTimeout(() => setDebouncedKeyword(keyword), 300);
    return () => window.clearTimeout(timer);
  }, [keyword]);

  /**
   * 世界信息与条目列表都走「缓存先渲染 + 后台刷新」：
   * 从侧边栏切到本页时，先把上次的数据立刻显示出来，不再先闪一段加载动画。
   * 缓存键带分类，来回切分类同样能立刻出内容。
   */
  const worldResource = useCachedResource<WorldInfo>(`world-info:${worldId}`, () =>
    api<WorldInfo>(`/api/worlds/${worldId}`),
  );
  const world = worldResource.data;

  /** 条目列表：搜索时不缓存（结果随关键词变化，缓存没有意义） */
  const hasKeyword = debouncedKeyword.trim().length > 0;
  const listKey = hasKeyword ? `entries-search:${worldId}` : `entries:${worldId}:${categoryId ?? "all"}`;
  const entriesResource = useCachedResource<EntryItem[]>(listKey, () => {
    const params = new URLSearchParams();
    if (categoryId) {
      params.set("categoryId", categoryId);
    }
    if (hasKeyword) {
      params.set("q", debouncedKeyword.trim());
    }
    return api<EntryItem[]>(`/api/worlds/${worldId}/entries?${params.toString()}`);
  });
  const entries = entriesResource.data ?? [];
  const loading = entriesResource.data === null && entriesResource.error === "";

  // 列表加载完（或切换分类后）把新建条目默认分类补上
  useEffect(() => {
    if (world) {
      setNewCategoryId((current) => current || categoryId || world.categories[0]?.id || "");
    }
  }, [world, categoryId]);

  // 接口报错时展示出来
  useEffect(() => {
    const message = worldResource.error || entriesResource.error;
    if (message) {
      setError(message);
    }
  }, [worldResource.error, entriesResource.error]);

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
            onClick={() => entriesResource.reload()}
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
