import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../lib/api";
import { formatTime } from "../lib/format";
import TipTapRenderer from "../components/TipTapRenderer";
import { parseDoc, type TipTapDoc } from "../lib/tiptap-json";

/** 历史版本列表项 */
interface VersionItem {
  version: number;
  note: string;
  editorName: string;
  createdAt: number;
}

/** 版本内容接口返回结构 */
interface VersionDetail {
  version: number;
  blocks: Array<{ title: string; contentJson: string; wordCount: number }>;
}

/** 条目详情（本页只用 canEdit 与标题） */
interface EntryBrief {
  title: string;
  canEdit: boolean;
}

/**
 * 历史版本页：版本列表 + 内容预览 + 一键回滚。
 */
export default function EntryVersionsPage() {
  const { worldId = "", entryId = "" } = useParams<{ worldId: string; entryId: string }>();
  const navigate = useNavigate();

  const [entry, setEntry] = useState<EntryBrief | null>(null);
  const [versions, setVersions] = useState<VersionItem[]>([]);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<number | null>(null);
  const [preview, setPreview] = useState<TipTapDoc | null>(null);
  const [rollingBack, setRollingBack] = useState(false);

  // 加载条目信息与版本列表
  useEffect(() => {
    Promise.all([
      api<EntryBrief>(`/api/entries/${entryId}`),
      api<VersionItem[]>(`/api/entries/${entryId}/versions`),
    ])
      .then(([entryData, versionData]) => {
        setEntry(entryData);
        setVersions(versionData);
      })
      .catch((err: Error) => setError(err.message));
  }, [entryId]);

  /** 预览某个历史版本的内容 */
  const handlePreview = async (version: number) => {
    setSelected(version);
    setPreview(null);
    try {
      const data = await api<VersionDetail>(`/api/entries/${entryId}/versions/${version}`);
      const firstBlock = data.blocks[0];
      setPreview(firstBlock ? parseDoc(firstBlock.contentJson) : { type: "doc", content: [] });
    } catch (err) {
      setError((err as Error).message);
    }
  };

  /** 回滚到选中的历史版本 */
  const handleRollback = async (version: number) => {
    if (!window.confirm(`确定回滚到版本 v${version}？当前内容会以新版本形式保留。`)) {
      return;
    }
    setRollingBack(true);
    try {
      await api(`/api/entries/${entryId}/versions/${version}/rollback`, { method: "POST" });
      navigate(`/w/${worldId}/entries/${entryId}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRollingBack(false);
    }
  };

  if (error) {
    return <div className="notice error">{error}</div>;
  }

  return (
    <>
      <h1 className="page-title">历史版本</h1>
      <p className="page-subtitle">{entry?.title ?? "…"}</p>

      {versions.length === 0 && <div className="empty">还没有历史版本（手动保存或离开编辑页时生成）</div>}

      <div className="version-list">
        {versions.map((item) => (
          <div key={item.version} className={`version-row${selected === item.version ? " active" : ""}`}>
            <div>
              <span className="version-number">v{item.version}</span>
              <span className="version-note">{item.note || "自动保存"}</span>
              <div className="card-meta">
                <span>{item.editorName || "未知"}</span>
                <span>{formatTime(item.createdAt)}</span>
              </div>
            </div>
            <div className="version-actions">
              <button type="button" className="btn ghost small" onClick={() => void handlePreview(item.version)}>
                预览
              </button>
              {entry?.canEdit && (
                <button
                  type="button"
                  className="btn small"
                  disabled={rollingBack}
                  onClick={() => void handleRollback(item.version)}
                >
                  回滚
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      {selected !== null && (
        <div className="section">
          <h2 className="section-title">版本 v{selected} 预览</h2>
          {preview === null && <div className="loading">加载中…</div>}
          {preview && (
            <article className="entry-body">
              <TipTapRenderer doc={preview} />
            </article>
          )}
        </div>
      )}
    </>
  );
}
