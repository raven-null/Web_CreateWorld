import { useEffect, useState, type FormEvent } from "react";
import { api } from "../lib/api";
import { authClient } from "../lib/auth-client";
import { showToast } from "../lib/toast";

/**
 * 个人设置页：修改昵称与密码。
 * 用户名不可修改（用于登录与贡献记录）。
 */
export default function SettingsPage() {
  const { data: session, refetch } = authClient.useSession();
  const [displayName, setDisplayName] = useState("");

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  // 会话加载后填入当前昵称
  useEffect(() => {
    if (session?.user) {
      setDisplayName(session.user.name);
    }
  }, [session]);

  if (!session?.user) {
    return (
      <>
        <h1 className="page-title">个人设置</h1>
        <div className="notice">请先登录</div>
      </>
    );
  }

  /** 保存昵称 */
  const handleSaveName = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await api("/api/me", { method: "PATCH", body: { displayName: displayName.trim() } });
      await refetch();
      showToast("success", "昵称已更新");
    } catch (err) {
      showToast("error", (err as Error).message);
    }
  };

  /** 修改密码（需验证当前密码） */
  const handleChangePassword = async (event: FormEvent) => {
    event.preventDefault();
    if (newPassword !== confirmPassword) {
      showToast("warning", "两次输入的新密码不一致");
      return;
    }
    const { error } = await authClient.changePassword({
      currentPassword,
      newPassword,
      revokeOtherSessions: true,
    });
    if (error) {
      showToast("error", error.message ?? "修改失败");
      return;
    }
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
    showToast("success", "密码已修改，其他设备已退出登录");
  };

  return (
    <>
      <h1 className="page-title">个人设置</h1>
      <p className="page-subtitle">
        @{session.user.username ?? ""}（用户名不可修改，用于登录）
      </p>

      <div className="section">
        <h2 className="section-title">昵称</h2>
        <form className="form" onSubmit={handleSaveName}>
          <div className="field">
            <label htmlFor="displayName">展示昵称</label>
            <input
              id="displayName"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              required
            />
          </div>
          <button type="submit" className="btn">
            保存昵称
          </button>
        </form>
      </div>

      <div className="section">
        <h2 className="section-title">修改密码</h2>
        <form className="form" onSubmit={handleChangePassword}>
          <div className="field">
            <label htmlFor="currentPassword">当前密码</label>
            <input
              id="currentPassword"
              type="password"
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
              autoComplete="current-password"
              required
            />
          </div>
          <div className="field">
            <label htmlFor="newPassword">新密码（至少 8 位）</label>
            <input
              id="newPassword"
              type="password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              autoComplete="new-password"
              required
            />
          </div>
          <div className="field">
            <label htmlFor="confirmPassword">确认新密码</label>
            <input
              id="confirmPassword"
              type="password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              autoComplete="new-password"
              required
            />
          </div>
          <button type="submit" className="btn">
            修改密码
          </button>
        </form>
      </div>
    </>
  );
}
