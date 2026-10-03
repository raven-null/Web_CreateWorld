import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ROLE_LABELS, VISIBILITY_LABELS, type MemberRole, type WorldVisibility } from "@create-world/core";
import { api } from "../lib/api";
import { authClient } from "../lib/auth-client";
import { showToast } from "../lib/toast";
import ReportDialog from "../components/ReportDialog";

/** 世界详情接口返回结构 */
interface WorldDetail {
  id: string;
  ownerId: string;
  ownerName: string;
  name: string;
  intro: string;
  cover: string | null;
  visibility: WorldVisibility;
  createdAt: number;
  updatedAt: number;
  myRole: MemberRole | null;
  banned: boolean;
  canEdit: boolean;
  categories: Array<{ id: string; name: string; icon: string | null }>;
  tags: string[];
}

/**
 * 世界主页：基础信息、分类预览、成员入口。
 * 管理员及以上可生成邀请码；条目功能下一阶段上线。
 */
export default function WorldPage() {
  const { worldId } = useParams<{ worldId: string }>();
  const { data: session } = authClient.useSession();
  const [world, setWorld] = useState<WorldDetail | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [inviteRole, setInviteRole] = useState("editor");
  const [inviteCode, setInviteCode] = useState("");
  const [reportOpen, setReportOpen] = useState(false);

  // 世界 id 或登录状态变化时刷新详情
  useEffect(() => {
    if (!worldId) {
      return;
    }
    setLoading(true);
    api<WorldDetail>(`/api/worlds/${worldId}`)
      .then((data) => {
        setWorld(data);
        setError("");
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, [worldId, session]);

  /** 加入开放编写世界：成功后刷新详情获得编辑身份 */
  const handleJoin = async () => {
    if (!worldId) {
      return;
    }
    try {
      await api(`/api/worlds/${worldId}/join`, { method: "POST" });
      const data = await api<WorldDetail>(`/api/worlds/${worldId}`);
      setWorld(data);
      showToast("success", "已加入，可以开始编写了");
    } catch (err) {
      showToast("error", (err as Error).message);
    }
  };

  /** 生成世界邀请码（需要世界管理员权限） */
  const handleCreateInvite = async () => {
    if (!worldId) {
      return;
    }
    try {
      const data = await api<{ code: string }>(`/api/worlds/${worldId}/invites`, {
        method: "POST",
        body: { role: inviteRole },
      });
      setInviteCode(data.code);
      showToast("success", "邀请码已生成");
    } catch (err) {
      showToast("error", (err as Error).message);
    }
  };

  if (loading) {
    return <div className="loading">加载中…</div>;
  }
  if (error) {
    return <div className="notice error">{error}</div>;
  }
  if (!world) {
    return <div className="empty">世界不存在</div>;
  }

  const isWorldAdmin = world.myRole === "owner" || world.myRole === "admin";
  const registerLink = inviteCode
    ? `${window.location.origin}/register?code=${inviteCode}`
    : "";

  return (
    <>
      <h1 className="page-title">
        {world.name}
        <span className={`badge${world.visibility === "public_edit" ? " edit" : ""}`}>
          {VISIBILITY_LABELS[world.visibility]}
        </span>
        {world.myRole && <span className="badge">{ROLE_LABELS[world.myRole]}</span>}
      </h1>
      <p className="page-subtitle">
        创建者 {world.ownerName}
        {world.tags.length > 0 && ` · 标签：${world.tags.join("、")}`}
      </p>

      {world.intro && <p>{world.intro}</p>}

      <div style={{ margin: "14px 0", display: "flex", gap: 10, flexWrap: "wrap" }}>
        {!world.myRole &&
          world.visibility === "public_edit" &&
          (session ? (
            <button type="button" className="btn" onClick={() => void handleJoin()}>
              参与编写
            </button>
          ) : (
            <Link className="btn" to="/login">
              登录后参与编写
            </Link>
          ))}
        {session && world.myRole === null && (
          <button type="button" className="btn ghost" onClick={() => setReportOpen(true)}>
            举报
          </button>
        )}
      </div>

      {reportOpen && (
        <ReportDialog targetType="world" targetId={world.id} targetName={world.name} onClose={() => setReportOpen(false)} />
      )}

      <div className="section">
        <h2 className="section-title">分类</h2>
        <div className="tag-row" style={{ marginBottom: 0 }}>
          {world.categories.map((category) => (
            <span key={category.id} className="tag-chip">
              {category.name}
            </span>
          ))}
        </div>
        <div style={{ marginTop: 16 }}>
          <Link to={`/w/${world.id}/entries`} className="btn">
            进入条目
          </Link>
        </div>
      </div>

      {isWorldAdmin && (
        <div className="section">
          <h2 className="section-title">邀请成员</h2>
          <div className="invite-box">
            <select value={inviteRole} onChange={(event) => setInviteRole(event.target.value)}>
              <option value="editor">编辑</option>
              <option value="viewer">只读</option>
              <option value="admin">管理员</option>
            </select>
            <button type="button" className="btn small" onClick={handleCreateInvite}>
              生成邀请码
            </button>
            {inviteCode && (
              <>
                <span className="code">{inviteCode}</span>
                <a href={registerLink} target="_blank" rel="noreferrer">
                  复制注册链接
                </a>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
