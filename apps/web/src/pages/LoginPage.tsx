import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { authClient } from "../lib/auth-client";

/**
 * 登录页：用户名 + 密码（本期邮箱流程未启用）。
 */
export default function LoginPage() {
  const navigate = useNavigate();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  /** 提交登录，成功后进入「我的世界」 */
  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    setSubmitting(true);

    const { error: signInError } = await authClient.signIn.username({
      username: username.trim().toLowerCase(),
      password,
    });

    setSubmitting(false);
    if (signInError) {
      setError(signInError.message ?? "登录失败，请检查用户名和密码");
      return;
    }
    navigate("/worlds");
  };

  return (
    <>
      <h1 className="page-title">登录</h1>
      <p className="page-subtitle">使用用户名和密码进入</p>

      <form className="form" onSubmit={handleSubmit}>
        <div className="field">
          <label htmlFor="username">用户名</label>
          <input
            id="username"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            autoComplete="username"
            required
          />
        </div>
        <div className="field">
          <label htmlFor="password">密码</label>
          <input
            id="password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            required
          />
        </div>
        {error && <div className="notice error">{error}</div>}
        <button type="submit" className="btn" disabled={submitting}>
          {submitting ? "登录中…" : "登录"}
        </button>
        <div style={{ color: "var(--text-faint)", fontSize: 13 }}>
          忘记密码请联系管理员重置 · 没有账号？<Link to="/register">用邀请码注册</Link>
        </div>
      </form>
    </>
  );
}
