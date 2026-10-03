import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ROLE_LABELS, type MemberRole } from "@create-world/core";
import { api } from "../lib/api";
import TipTapRenderer from "../components/TipTapRenderer";
import { parseDoc, type TipTapDoc } from "../lib/tiptap-json";

/** 条目详情接口返回结构 */
interface EntryDetail {
  id: string;
  worldId: string;
  worldName: string;
  categoryName: string;
  title: string;
  protected: boolean;
  wordCount: number;
  version: number;
  lastEditorName: string;
  updatedAt: number;
  canEdit: boolean;
  myRole: MemberRole | null;
  blocks: Array<{ id: string; contentJson: string }>;
  backlinks: Array<{ id: string; title: string }>;
}

/**
 * 条目阅读页：正文渲染 + 反向链接 + 管理操作（保护 / 删除）。
 */
export default function EntryViewPage() {
  const { worldId = "", entryId = "" } = useParams<{ worldId: string; entryId: string }>();
  const navigate = useNavigate();
  const [detail, setDetail] = useState<EntryDetail | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  // 加载条目详情（从编辑页返回时重新拉取最新版本）
  useEffect(() => {
    api<EntryDetail>(`/api/entries/${entryId}`)
      .then((data) => {
        setDetail(data);
        setError("");
      })
      .catch((err: Error) => setError(err.message));
  }, [entryId]);

  /** 切换条目保护状态（世界管理员及以上） */
  const handleToggleProtect = async () => {
    if (!detail) {
      return;
    }
    try {
      const data = await api<{ protected: boolean }>(`/api/entries/${entryId}/protect`, {
        method: "POST",
        body: { protected: !detail.protected },
      });
      setDetail({ ...detail, protected: data.protected });
      setNotice(data.protected ? "已开启保护：仅管理员可编辑" : "已取消保护");
    } catch (err) {
      setNotice((err as Error).message);
    }
  };

  /** 删除条目（世界管理员及以上），删除后回到列表页 */
  const handleDelete = async () => {
    if (!window.confirm("确定删除该条目？删除后不可恢复。")) {
      return;
    }
    try {
      await api(`/api/entries/${entryId}`, { method: "DELETE" });
      navigate(`/w/${worldId}/entries`);
    } catch (err) {
      setNotice((err as Error).message);
    }
  };

  if (error) {
    return <div className="notice error">{error}</div>;
  }
  if (!detail) {
    return <div className="loading">加载中…</div>;
  }

  const isWorldAdmin = detail.myRole === "owner" || detail.myRole === "admin";
  const doc: TipTapDoc = detail.blocks[0] ? parseDoc(detail.blocks[0].contentJson) : { type: "doc", content: [] };

  return (
    <>
      <div className="entry-view-head">
        <div>
          <p className="page-subtitle" style={{ marginBottom: 6 }}>
            <Link to={`/w/${worldId}/entries`}>{detail.worldName} · 条目</Link> / {detail.categoryName}
          </p>
          <h1 className="page-title" style={{ marginBottom: 4 }}>
            {detail.title}
            {detail.protected && <span className="badge">保护</span>}
          </h1>
          <div className="card-meta">
            <span>{detail.wordCount} 字</span>
            <span>v{detail.version}</span>
            {detail.lastEditorName && <span>最后编辑：{detail.lastEditorName}</span>}
            {detail.myRole && <span>我的角色：{ROLE_LABELS[detail.myRole]}</span>}
          </div>
        </div>
        <div className="entry-view-actions">
          {detail.canEdit && (
            <Link className="btn" to={`/w/${worldId}/entries/${entryId}/edit`}>
              编辑
            </Link>
          )}
          <Link className="btn ghost" to={`/w/${worldId}/entries/${entryId}/versions`}>
            历史
          </Link>
          {isWorldAdmin && (
            <button type="button" className="btn ghost" onClick={() => void handleToggleProtect()}>
              {detail.protected ? "取消保护" : "开启保护"}
            </button>
          )}
          {isWorldAdmin && (
            <button type="button" className="btn ghost" onClick={() => void handleDelete()}>
              删除
            </button>
          )}
        </div>
      </div>

      {notice && <div className="notice">{notice}</div>}

      <article className="entry-body">
        <TipTapRenderer
          doc={doc}
          onEntryLinkClick={(targetId) => navigate(`/w/${worldId}/entries/${targetId}`)}
        />
      </article>

      <div className="section">
        <h2 className="section-title">反向链接（{detail.backlinks.length}）</h2>
        {detail.backlinks.length === 0 && <div className="empty">还没有条目引用它</div>}
        <div className="entry-list">
          {detail.backlinks.map((link) => (
            <Link key={link.id} to={`/w/${worldId}/entries/${link.id}`} className="entry-row">
              <span className="entry-row-title">{link.title}</span>
            </Link>
          ))}
        </div>
      </div>
    </>
  );
}
