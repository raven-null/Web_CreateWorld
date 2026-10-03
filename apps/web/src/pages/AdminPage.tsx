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

/** 管理后台举报项 */
interface AdminReport {
  id: string;
  reporterName: string;
  targetType: string;
  targetId: string;
  targetTitle: string;
  reason: string;
  detail: string;
  status: string;
  action: string;
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
  const [reports, setReports] = useState<AdminReport[]>([]);
  const [error, setError] = useState("");
  const [newCode, setNewCode] = useState("");

  /** 拉取用户、邀请码与待处理举报 */
  const loadData = async () => {
    try {
      const [userList, inviteList, reportList] = await Promise.all([
        api<AdminUser[]>("/api/admin/users"),
        api<AdminInvite[]>("/api/admin/invites"),
        api<AdminReport[]>("/api/admin/reports?status=pending"),
      ]);
      setUsers(userList);
      setInvites(inviteList);
      setReports(reportList);
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

  /** 处理举报：删除内容 / 封禁相关用户 / 驳回 */
  const handleReport = async (report: AdminReport, action: "delete" | "ban" | "reject") => {
    const labels: Record<string, string> = { delete: "删除内容", ban: "封禁相关用户", reject: "驳回" };
    const label = labels[action] ?? action;
    if (!window.confirm(`确定${label}？`)) {
      return;
    }
    try {
      await api(`/api/admin/reports/${report.id}/handle`, { method: "POST", body: { action } });
      showToast("success", `已${label}`);
      await loadData();
    } catch (err) {
      showToast("error", (err as Error).message);
    }
  };

  /** 修改用户状态：禁用 / 恢复 / 封禁 */
  const handleUserStatus = async (user: AdminUser, status: "active" | "disabled" | "banned") => {
    const labels: Record<string, string> = { active: "恢复正常", disabled: "禁用", banned: "封禁" };
    const label = labels[status] ?? status;
    if (!window.confirm(`确定${label}用户「${user.displayName}」？`)) {
      return;
    }
    try {
      await api(`/api/admin/users/${user.id}/status`, { method: "POST", body: { status } });
      showToast("success", `已${label}`);
      await loadData();
    } catch (err) {
      showToast("error", (err as Error).message);
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
        <h2 className="section-title">举报处理（待处理 {reports.length}）</h2>
        {reports.length === 0 && <div className="empty">没有待处理的举报</div>}
        {reports.length > 0 && (
          <table className="table">
            <thead>
              <tr>
                <th>被举报对象</th>
                <th>原因</th>
                <th>举报人</th>
                <th>时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {reports.map((report) => (
                <tr key={report.id}>
                  <td>
                    {report.targetType === "world" ? "世界" : report.targetType === "entry" ? "条目" : "用户"}：
                    {report.targetTitle}
                    {report.detail && (
                      <div style={{ color: "var(--text-faint)", fontSize: 12 }}>{report.detail}</div>
                    )}
                  </td>
                  <td>{report.reason}</td>
                  <td>{report.reporterName}</td>
                  <td>{formatTime(report.createdAt)}</td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    {report.targetType !== "user" && (
                      <button type="button" className="btn ghost small" onClick={() => void handleReport(report, "delete")}>
                        删除内容
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn ghost small"
                      style={{ marginLeft: 6 }}
                      onClick={() => void handleReport(report, "ban")}
                    >
                      封禁相关用户
                    </button>
                    <button
                      type="button"
                      className="btn ghost small"
                      style={{ marginLeft: 6 }}
                      onClick={() => void handleReport(report, "reject")}
                    >
                      驳回
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

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
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr key={user.id}>
                <td>{user.username}</td>
                <td>{user.displayName}</td>
                <td>{user.role === "admin" ? "站点管理员" : "普通用户"}</td>
                <td>
                  {user.status === "active" ? "正常" : user.status === "disabled" ? "已禁用" : user.status === "banned" ? "已封禁" : user.status}
                </td>
                <td>{formatTime(user.createdAt)}</td>
                <td style={{ whiteSpace: "nowrap" }}>
                  {user.role !== "admin" && (
                    <>
                      {user.status === "active" ? (
                        <button type="button" className="btn ghost small" onClick={() => void handleUserStatus(user, "disabled")}>
                          禁用
                        </button>
                      ) : (
                        <button type="button" className="btn ghost small" onClick={() => void handleUserStatus(user, "active")}>
                          恢复
                        </button>
                      )}
                      {user.status !== "banned" && (
                        <button
                          type="button"
                          className="btn ghost small"
                          style={{ marginLeft: 6 }}
                          onClick={() => void handleUserStatus(user, "banned")}
                        >
                          封禁
                        </button>
                      )}
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
