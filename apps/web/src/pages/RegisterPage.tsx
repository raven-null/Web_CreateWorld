import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { authClient } from "../lib/auth-client";
import { api } from "../lib/api";

/** 邀请码校验结果 */
interface InviteInfo {
  valid: boolean;
  scope?: "platform" | "world";
  role?: string | null;
  worldName?: string | null;
}

/**
 * 注册页：邀请码 + 用户名 + 密码（可加昵称）。
 * 从邀请链接进入时自动填入邀请码，并展示将要加入的世界。
 */
export default function RegisterPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [inviteCode, setInviteCode] = useState(searchParams.get("code") ?? "");
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [inviteInfo, setInviteInfo] = useState<InviteInfo | null>(null);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  /** 校验邀请码：有效时展示来源（平台 / 世界） */
  const checkInvite = async (code: string) => {
    const trimmed = code.trim();
    if (!trimmed) {
      setInviteInfo(null);
      return;
    }
    try {
      const info = await api<InviteInfo>(`/api/invites/${encodeURIComponent(trimmed)}`);
      setInviteInfo(info);
    } catch {
      setInviteInfo({ valid: false });
    }
  };

  // 链接带入邀请码时自动校验一次
  useEffect(() => {
    if (inviteCode) {
      void checkInvite(inviteCode);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 提交注册，成功后自动登录并进入「我的世界」 */
  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    setSubmitting(true);
    const normalizedName = username.trim().toLowerCase();

    try {
      await api("/api/register", {
        method: "POST",
        body: { inviteCode: inviteCode.trim(), username: normalizedName, password, displayName: displayName.trim() },
      });
      const { error: signInError } = await authClient.signIn.username({
        username: normalizedName,
        password,
      });
      if (signInError) {
        navigate("/login");
        return;
      }
      navigate("/worlds");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <h1 className="page-title">注册</h1>
      <p className="page-subtitle">凭邀请码创建账号，无需邮箱</p>

      <form className="form" onSubmit={handleSubmit}>
        <div className="field">
          <label htmlFor="inviteCode">邀请码</label>
          <input
            id="inviteCode"
            value={inviteCode}
            onChange={(event) => setInviteCode(event.target.value)}
            onBlur={() => void checkInvite(inviteCode)}
            placeholder="如 ABCD2345"
            required
          />
        </div>

        {inviteInfo && inviteInfo.valid && inviteInfo.scope === "world" && (
          <div className="notice">你将被加入世界《{inviteInfo.worldName ?? "未知"}》</div>
        )}
        {inviteInfo && inviteInfo.valid && inviteInfo.scope === "platform" && (
          <div className="notice">邀请码有效，注册后即可创建自己的世界</div>
        )}
        {inviteInfo && !inviteInfo.valid && <div className="notice error">邀请码无效或已用完</div>}

        <div className="field">
          <label htmlFor="username">用户名（登录用，注册后不可修改）</label>
          <input
            id="username"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            placeholder="3-24 位，字母开头"
            autoComplete="username"
            required
          />
        </div>
        <div className="field">
          <label htmlFor="displayName">昵称（展示用，可留空）</label>
          <input
            id="displayName"
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            placeholder="不填则与用户名相同"
          />
        </div>
        <div className="field">
          <label htmlFor="password">密码（至少 8 位）</label>
          <input
            id="password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="new-password"
            required
          />
        </div>
        {error && <div className="notice error">{error}</div>}
        <button type="submit" className="btn" disabled={submitting}>
          {submitting ? "注册中…" : "注册并进入"}
        </button>
      </form>
    </>
  );
}
