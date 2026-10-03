import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { ROLE_LABELS, VISIBILITY_LABELS, type MemberRole, type WorldVisibility } from "@create-world/core";
import { api } from "../lib/api";
import { authClient } from "../lib/auth-client";

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
  const [inviteError, setInviteError] = useState("");

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

  /** 生成世界邀请码（需要世界管理员权限） */
  const handleCreateInvite = async () => {
    if (!worldId) {
      return;
    }
    setInviteError("");
    try {
      const data = await api<{ code: string }>(`/api/worlds/${worldId}/invites`, {
        method: "POST",
        body: { role: inviteRole },
      });
      setInviteCode(data.code);
    } catch (err) {
      setInviteError((err as Error).message);
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

      <div className="section">
        <h2 className="section-title">分类</h2>
        <div className="tag-row" style={{ marginBottom: 0 }}>
          {world.categories.map((category) => (
            <span key={category.id} className="tag-chip">
              {category.name}
            </span>
          ))}
        </div>
        <div className="notice" style={{ marginTop: 16 }}>
          条目浏览与编辑功能正在开发中，下一步上线。
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
          {inviteError && <div className="notice error">{inviteError}</div>}
        </div>
      )}
    </>
  );
}
