import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { authClient } from "../lib/auth-client";
import { formatTime, readUserRole } from "../lib/format";
import { showToast } from "../lib/toast";

/** 管理后台用户列表项 */
interface AdminUser {
  id: string;
  username: string;
  displayName: string;
  email: string;
  role: string;
  status: string;
  createdAt: number;
}

/** 管理后台邀请码列表项 */
interface AdminInvite {
  id: string;
  code: string;
  scope: string;
  worldName: string | null;
  maxUses: number;
  usedCount: number;
  status: string;
  createdAt: number;
}

/**
 * 站点管理后台：用户列表 + 邀请码管理。
 * 仅站点管理员可见（接口层同样强制校验）。
 */
export default function AdminPage() {
  const { data: session } = authClient.useSession();
  const isAdmin = readUserRole(session?.user) === "admin";
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [invites, setInvites] = useState<AdminInvite[]>([]);
  const [error, setError] = useState("");
  const [newCode, setNewCode] = useState("");

  /** 拉取用户与邀请码列表 */
  const loadData = async () => {
    try {
      const [userList, inviteList] = await Promise.all([
        api<AdminUser[]>("/api/admin/users"),
        api<AdminInvite[]>("/api/admin/invites"),
      ]);
      setUsers(userList);
      setInvites(inviteList);
      setError("");
    } catch (err) {
      setError((err as Error).message);
    }
  };

  useEffect(() => {
    if (isAdmin) {
      void loadData();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin]);

  /** 创建一个单次可用的平台邀请码 */
  const handleCreateInvite = async () => {
    setNewCode("");
    try {
      const data = await api<{ code: string }>("/api/admin/invites", {
        method: "POST",
        body: { scope: "platform", maxUses: 1 },
      });
      setNewCode(data.code);
      showToast("success", `邀请码已生成：${data.code}`);
      await loadData();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  if (!isAdmin) {
    return (
      <>
        <h1 className="page-title">管理后台</h1>
        <div className="notice error">
          仅站点管理员可访问，请 <Link to="/login">登录管理员账号</Link>
        </div>
      </>
    );
  }

  return (
    <>
      <h1 className="page-title">管理后台</h1>
      <p className="page-subtitle">平台用户与邀请码管理</p>

      {error && <div className="notice error">{error}</div>}

      <div className="section">
        <h2 className="section-title">平台邀请码</h2>
        <div className="invite-box">
          <button type="button" className="btn small" onClick={handleCreateInvite}>
            生成新邀请码
          </button>
          {newCode && <span className="code">{newCode}</span>}
        </div>
        <table className="table" style={{ marginTop: 12 }}>
          <thead>
            <tr>
              <th>邀请码</th>
              <th>范围</th>
              <th>使用</th>
              <th>状态</th>
              <th>创建时间</th>
            </tr>
          </thead>
          <tbody>
            {invites.map((invite) => (
              <tr key={invite.id}>
                <td className="code" style={{ border: "none", padding: 0 }}>
                  {invite.code}
                </td>
                <td>{invite.scope === "world" ? `世界：${invite.worldName ?? "—"}` : "平台"}</td>
                <td>
                  {invite.usedCount} / {invite.maxUses}
                </td>
                <td>{invite.status === "active" ? "可用" : "停用"}</td>
                <td>{formatTime(invite.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="section">
        <h2 className="section-title">用户（最近 200 位）</h2>
        <table className="table">
          <thead>
            <tr>
              <th>用户名</th>
              <th>昵称</th>
              <th>角色</th>
              <th>状态</th>
              <th>注册时间</th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr key={user.id}>
                <td>{user.username}</td>
                <td>{user.displayName}</td>
                <td>{user.role === "admin" ? "站点管理员" : "普通用户"}</td>
                <td>{user.status === "active" ? "正常" : user.status}</td>
                <td>{formatTime(user.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
