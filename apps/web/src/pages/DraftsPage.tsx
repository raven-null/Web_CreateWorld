import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { authClient } from "../lib/auth-client";
import { formatTime } from "../lib/format";
import { showToast } from "../lib/toast";

/** 草稿项 */
interface DraftItem {
  id: string;
  worldId: string | null;
  worldName: string | null;
  content: string;
  convertedEntryId: string | null;
  createdAt: number;
  updatedAt: number;
}

/** 我的世界（下拉用） */
interface MyWorld {
  id: string;
  name: string;
}

/** 世界分类（转换弹层用） */
interface Category {
  id: string;
  name: string;
}

/**
 * 草稿箱：碎片想法速记，可一键转为正式条目。
 */
export default function DraftsPage() {
  const navigate = useNavigate();
  const { data: session, isPending } = authClient.useSession();

  const [drafts, setDrafts] = useState<DraftItem[]>([]);
  const [worlds, setWorlds] = useState<MyWorld[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  // 新草稿
  const [newContent, setNewContent] = useState("");
  const [newWorldId, setNewWorldId] = useState("");
  const [saving, setSaving] = useState(false);

  // 转换弹层
  const [convertDraft, setConvertDraft] = useState<DraftItem | null>(null);
  const [convertWorldId, setConvertWorldId] = useState("");
  const [convertCategories, setConvertCategories] = useState<Category[]>([]);
  const [convertCategoryId, setConvertCategoryId] = useState("");
  const [convertTitle, setConvertTitle] = useState("");
  const [converting, setConverting] = useState(false);

  /** 加载草稿与我的世界 */
  const load = async () => {
    const [draftList, worldList] = await Promise.all([
      api<DraftItem[]>("/api/drafts"),
      api<MyWorld[]>("/api/worlds/mine"),
    ]);
    setDrafts(draftList);
    setWorlds(worldList);
  };

  useEffect(() => {
    if (!session) {
      setLoading(false);
      return;
    }
    load()
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  /** 新建草稿 */
  const handleCreate = async (event: FormEvent) => {
    event.preventDefault();
    if (!newContent.trim()) {
      return;
    }
    setSaving(true);
    try {
      await api("/api/drafts", { method: "POST", body: { content: newContent.trim(), worldId: newWorldId || null } });
      setNewContent("");
      showToast("success", "已存入草稿箱");
      await load();
    } catch (err) {
      showToast("error", (err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  /** 编辑草稿内容（失焦保存） */
  const handleUpdateContent = async (draft: DraftItem, content: string) => {
    if (!content.trim() || content === draft.content) {
      return;
    }
    try {
      await api(`/api/drafts/${draft.id}`, { method: "PATCH", body: { content: content.trim() } });
      await load();
    } catch (err) {
      showToast("error", (err as Error).message);
    }
  };

  /** 删除草稿 */
  const handleDelete = async (draft: DraftItem) => {
    if (!window.confirm("确定删除这条草稿？")) {
      return;
    }
    try {
      await api(`/api/drafts/${draft.id}`, { method: "DELETE" });
      await load();
    } catch (err) {
      showToast("error", (err as Error).message);
    }
  };

  /** 打开转换弹层：预填世界与标题 */
  const openConvert = async (draft: DraftItem) => {
    setConvertDraft(draft);
    const worldId = draft.worldId ?? worlds[0]?.id ?? "";
    setConvertWorldId(worldId);
    setConvertTitle(draft.content.split("\n")[0]?.slice(0, 100) ?? "");
    setConvertCategories([]);
    setConvertCategoryId("");
    if (worldId) {
      await loadCategories(worldId);
    }
  };

  /** 加载所选世界的分类 */
  const loadCategories = async (worldId: string) => {
    try {
      const detail = await api<{ categories: Category[] }>(`/api/worlds/${worldId}`);
      setConvertCategories(detail.categories);
      setConvertCategoryId(detail.categories[0]?.id ?? "");
    } catch (err) {
      showToast("error", (err as Error).message);
    }
  };

  /** 执行转换并跳转到新条目 */
  const handleConvert = async (event: FormEvent) => {
    event.preventDefault();
    if (!convertDraft) {
      return;
    }
    setConverting(true);
    try {
      const data = await api<{ entryId: string }>(`/api/drafts/${convertDraft.id}/convert`, {
        method: "POST",
        body: { worldId: convertWorldId, categoryId: convertCategoryId, title: convertTitle.trim() },
      });
      showToast("success", "已转为条目");
      setConvertDraft(null);
      navigate(`/w/${convertWorldId}/entries/${data.entryId}/edit`);
    } catch (err) {
      showToast("error", (err as Error).message);
    } finally {
      setConverting(false);
    }
  };

  if (isPending) {
    return <div className="loading">加载中…</div>;
  }
  if (!session) {
    return (
      <>
        <h1 className="page-title">草稿箱</h1>
        <div className="notice">
          请先 <Link to="/login">登录</Link>
        </div>
      </>
    );
  }

  return (
    <>
      <h1 className="page-title">草稿箱</h1>
      <p className="page-subtitle">灵感先记下来，有空再整理成正式条目</p>

      {error && <div className="notice error">{error}</div>}

      <form className="form" style={{ maxWidth: "none", marginBottom: 24 }} onSubmit={handleCreate}>
        <div className="field">
          <textarea
            value={newContent}
            onChange={(event) => setNewContent(event.target.value)}
            placeholder="随手记：一个地名、一句对白、一段设定……"
            style={{ minHeight: 90 }}
          />
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <select value={newWorldId} onChange={(event) => setNewWorldId(event.target.value)}>
            <option value="">不关联世界</option>
            {worlds.map((world) => (
              <option key={world.id} value={world.id}>
                {world.name}
              </option>
            ))}
          </select>
          <button type="submit" className="btn" disabled={saving}>
            {saving ? "保存中…" : "存入草稿箱"}
          </button>
        </div>
      </form>

      {loading && <div className="loading">加载中…</div>}
      {!loading && drafts.length === 0 && <div className="empty">草稿箱是空的</div>}

      <div className="draft-list">
        {drafts.map((draft) => (
          <div key={draft.id} className="draft-card">
            <textarea
              defaultValue={draft.content}
              onBlur={(event) => void handleUpdateContent(draft, event.target.value)}
            />
            <div className="draft-meta">
              <span>
                {draft.worldName ? `关联：${draft.worldName}` : "未关联世界"} · {formatTime(draft.updatedAt)}
              </span>
              <span className="draft-actions">
                {draft.convertedEntryId && draft.worldId && (
                  <Link to={`/w/${draft.worldId}/entries/${draft.convertedEntryId}`}>已转为条目</Link>
                )}
                <button type="button" className="btn small" onClick={() => void openConvert(draft)}>
                  转为条目
                </button>
                <button type="button" className="btn ghost small" onClick={() => void handleDelete(draft)}>
                  删除
                </button>
              </span>
            </div>
          </div>
        ))}
      </div>

      {convertDraft && (
        <div className="modal-overlay" onClick={() => setConvertDraft(null)}>
          <div className="modal" onClick={(clickEvent) => clickEvent.stopPropagation()}>
            <h2 className="section-title">转为正式条目</h2>
            <form className="form" style={{ maxWidth: "none" }} onSubmit={handleConvert}>
              <div className="field">
                <label htmlFor="convertWorld">世界</label>
                <select
                  id="convertWorld"
                  value={convertWorldId}
                  onChange={(event) => {
                    setConvertWorldId(event.target.value);
                    void loadCategories(event.target.value);
                  }}
                  required
                >
                  <option value="">请选择</option>
                  {worlds.map((world) => (
                    <option key={world.id} value={world.id}>
                      {world.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="convertCategory">分类</label>
                <select
                  id="convertCategory"
                  value={convertCategoryId}
                  onChange={(event) => setConvertCategoryId(event.target.value)}
                  required
                >
                  <option value="">请选择</option>
                  {convertCategories.map((category) => (
                    <option key={category.id} value={category.id}>
                      {category.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="convertTitle">条目标题</label>
                <input
                  id="convertTitle"
                  value={convertTitle}
                  onChange={(event) => setConvertTitle(event.target.value)}
                  required
                />
              </div>
              <div style={{ display: "flex", gap: 10 }}>
                <button type="submit" className="btn" disabled={converting}>
                  {converting ? "转换中…" : "创建条目"}
                </button>
                <button type="button" className="btn ghost" onClick={() => setConvertDraft(null)}>
                  取消
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
