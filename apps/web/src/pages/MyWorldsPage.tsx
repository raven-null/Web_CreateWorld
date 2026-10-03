import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ROLE_LABELS, VISIBILITY_LABELS, type MemberRole, type WorldSummary } from "@create-world/core";
import { api, clearApiCache } from "../lib/api";
import { authClient } from "../lib/auth-client";
import { formatTime } from "../lib/format";
import { showToast } from "../lib/toast";

/** 导入文件预览摘要 */
interface ImportSummary {
  name: string;
  categories: number;
  entries: number;
  links: number;
  maps: number;
}

/** 导入接口返回结构 */
interface ImportResult {
  worldId: string;
  entries: number;
  categories: number;
  links: number;
  skippedMaps: number;
}

/**
 * 我的世界：我创建 / 参与的世界列表 + 导入世界（JSON 备份恢复）。
 * 未登录时提示登录。
 */
export default function MyWorldsPage() {
  const navigate = useNavigate();
  const { data: session, isPending } = authClient.useSession();
  const [worlds, setWorlds] = useState<WorldSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // 导入弹层
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importName, setImportName] = useState("");
  const [importSummary, setImportSummary] = useState<ImportSummary | null>(null);
  const [importError, setImportError] = useState("");
  const [importing, setImporting] = useState(false);

  // 登录后加载「我的世界」
  useEffect(() => {
    if (!session) {
      setLoading(false);
      return;
    }
    api<WorldSummary[]>("/api/worlds/mine")
      .then((data) => {
        setWorlds(data);
        setError("");
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, [session]);

  /** 关闭导入弹层并重置状态 */
  const closeImport = () => {
    setImportOpen(false);
    setImportFile(null);
    setImportName("");
    setImportSummary(null);
    setImportError("");
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  /** 选择文件后本地解析并生成预览（不上传） */
  const handleFileChange = async (file: File | null) => {
    setImportFile(file);
    setImportSummary(null);
    setImportError("");
    if (!file) {
      return;
    }
    try {
      const data = JSON.parse(await file.text()) as {
        format?: string;
        version?: number;
        world?: { name?: string };
        categories?: unknown[];
        entries?: unknown[];
        links?: unknown[];
        maps?: unknown[];
      };
      if (data?.format !== "create-world-export" || data?.version !== 1) {
        setImportError("格式不支持：请使用本站「世界设置 → 导出 JSON」生成的文件");
        return;
      }
      const name = String(data.world?.name ?? "导入的世界");
      setImportName(name);
      setImportSummary({
        name,
        categories: Array.isArray(data.categories) ? data.categories.length : 0,
        entries: Array.isArray(data.entries) ? data.entries.length : 0,
        links: Array.isArray(data.links) ? data.links.length : 0,
        maps: Array.isArray(data.maps) ? data.maps.length : 0,
      });
    } catch {
      setImportError("文件不是有效的 JSON");
    }
  };

  /** 确认导入：上传文件并跳转到新世界 */
  const handleImport = async () => {
    if (!importFile) {
      return;
    }
    setImporting(true);
    setImportError("");
    try {
      const form = new FormData();
      form.append("file", importFile);
      if (importName.trim()) {
        form.append("name", importName.trim());
      }
      const response = await fetch("/api/imports", { method: "POST", body: form, credentials: "include" });
      const payload = (await response.json().catch(() => null)) as
        | { ok: boolean; data?: ImportResult; error?: string }
        | null;
      if (!payload?.ok || !payload.data) {
        throw new Error(payload?.error ?? "导入失败，请重试");
      }
      clearApiCache();
      showToast("success", `导入完成：${payload.data.entries} 个条目、${payload.data.links} 条关联`);
      if (payload.data.skippedMaps > 0) {
        showToast("warning", `地图 ${payload.data.skippedMaps} 张暂未导入（不含底图，后续版本支持）`, 6000);
      }
      closeImport();
      navigate(`/w/${payload.data.worldId}`);
    } catch (err) {
      setImportError((err as Error).message);
    } finally {
      setImporting(false);
    }
  };

  if (isPending) {
    return <div className="loading">加载中…</div>;
  }
  if (!session) {
    return (
      <>
        <h1 className="page-title">我的世界</h1>
        <div className="notice">
          请先 <Link to="/login">登录</Link>，或 <Link to="/register">用邀请码注册</Link>
        </div>
      </>
    );
  }

  return (
    <>
      <h1 className="page-title">我的世界</h1>
      <p className="page-subtitle">我创建与参与的世界</p>

      <div style={{ marginBottom: 20, display: "flex", gap: 10 }}>
        <Link to="/worlds/new" className="btn">
          创建新世界
        </Link>
        <button type="button" className="btn ghost" onClick={() => setImportOpen(true)}>
          导入世界
        </button>
      </div>

      {error && <div className="notice error">{error}</div>}
      {loading && <div className="loading">加载中…</div>}
      {!loading && worlds.length === 0 && (
        <div className="empty">
          还没有世界，点击上方「创建新世界」开始，或从备份导入
        </div>
      )}

      <div className="card-grid">
        {worlds.map((world) => (
          <Link key={world.id} to={`/w/${world.id}`} className="card">
            <h2 className="card-title">
              {world.name}
              {world.role && <span className="badge">{ROLE_LABELS[world.role as MemberRole]}</span>}
            </h2>
            <p className="card-intro">{world.intro || "（暂无简介）"}</p>
            <div className="card-meta">
              <span>{VISIBILITY_LABELS[world.visibility]}</span>
              <span>条目 {world.entryCount}</span>
              <span>成员 {world.memberCount}</span>
              <span>更新于 {formatTime(world.updatedAt)}</span>
            </div>
          </Link>
        ))}
      </div>

      {importOpen && (
        <div className="modal-overlay" onClick={closeImport}>
          <div className="modal" onClick={(clickEvent) => clickEvent.stopPropagation()}>
            <h2 className="section-title">导入世界</h2>
            <p className="page-subtitle" style={{ marginBottom: 14 }}>
              支持本站「世界设置 → 导出 JSON」生成的备份文件；导入会创建一个新世界（每天最多 3 次）。
            </p>
            <div className="form" style={{ maxWidth: "none" }}>
              <div className="field">
                <label htmlFor="importFile">备份文件（.json）</label>
                <input
                  id="importFile"
                  ref={fileInputRef}
                  type="file"
                  accept="application/json,.json"
                  onChange={(event) => void handleFileChange(event.target.files?.[0] ?? null)}
                />
              </div>

              {importSummary && (
                <>
                  <div className="notice">
                    将导入「{importSummary.name}」：{importSummary.categories} 个分类 · {importSummary.entries} 个条目 ·{" "}
                    {importSummary.links} 条关联
                    {importSummary.maps > 0 && `（地图 ${importSummary.maps} 张暂不导入）`}
                  </div>
                  <div className="field">
                    <label htmlFor="importName">世界名称（可修改）</label>
                    <input
                      id="importName"
                      value={importName}
                      onChange={(event) => setImportName(event.target.value)}
                    />
                  </div>
                </>
              )}

              {importError && <div className="notice error">{importError}</div>}

              <div style={{ display: "flex", gap: 10 }}>
                <button
                  type="button"
                  className="btn"
                  disabled={!importSummary || importing}
                  onClick={() => void handleImport()}
                >
                  {importing ? "导入中…" : "确认导入"}
                </button>
                <button type="button" className="btn ghost" onClick={closeImport}>
                  取消
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
