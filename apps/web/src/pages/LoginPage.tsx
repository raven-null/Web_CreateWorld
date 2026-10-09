import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import AnimatedCharacters from "../components/AnimatedCharacters";
import { authClient } from "../lib/auth-client";
import { translateAuthError } from "../lib/auth-errors";

/** 登录失败后角色恢复常态的延迟（与参考设计的 2.5s 一致） */
const ERROR_RESET_MS = 2500;

/**
 * 登录页：用户名 + 密码（本期邮箱流程未启用）。
 *
 * 布局与交互参考 `guohaolian/animatedlogin`：左侧四个交互动画角色，
 * 会跟随鼠标、在输入密码时礼貌转头回避、登录失败时摇头；
 * 配色与表单风格沿用本项目视觉体系（深色墨底 + 金色强调）。
 */
export default function LoginPage() {
  const navigate = useNavigate();

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [identityFocused, setIdentityFocused] = useState(false);
  const [passwordFocused, setPasswordFocused] = useState(false);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [loginFailed, setLoginFailed] = useState(false);

  /** 失败动画的重置定时器（连续失败时要清掉旧的，保证每次都能重新播放） */
  const resetTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (resetTimerRef.current !== null) {
        window.clearTimeout(resetTimerRef.current);
      }
    };
  }, []);

  /**
   * 触发登录失败：角色摇头，并在 2.5 秒后自动恢复。
   * @param message 展示给用户的错误文案
   */
  const triggerFailure = useCallback((message: string): void => {
    setError(message);
    setLoginFailed(false);
    // 先置 false 再置 true：确保连续失败时 CSS 动画能重新播放
    window.requestAnimationFrame(() => setLoginFailed(true));
    if (resetTimerRef.current !== null) {
      window.clearTimeout(resetTimerRef.current);
    }
    resetTimerRef.current = window.setTimeout(() => setLoginFailed(false), ERROR_RESET_MS);
  }, []);

  /** 提交登录，成功后进入「我的世界」 */
  const handleSubmit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setError("");

    const trimmedUsername = username.trim().toLowerCase();
    if (!trimmedUsername) {
      triggerFailure("请填写用户名");
      return;
    }
    if (password.length < 6) {
      triggerFailure("密码至少 6 位");
      return;
    }

    setSubmitting(true);
    const { error: signInError } = await authClient.signIn.username({
      username: trimmedUsername,
      password,
    });
    setSubmitting(false);

    if (signInError) {
      triggerFailure(translateAuthError(signInError.message));
      return;
    }
    navigate("/worlds");
  };

  // 密码可见时角色不再回避（与参考设计的状态优先级一致）
  const passwordHidden = passwordFocused && !showPassword;

  return (
    <div className={`wme-login${loginFailed ? " is-failed" : ""}`}>
      {/* 左侧：动画角色 */}
      <aside className="wme-login-left">
        <div className="wme-login-brand">
          <span className="wme-login-mark" aria-hidden="true" />
          <span className="wme-login-name">创世</span>
        </div>
        <AnimatedCharacters
          identityFocused={identityFocused}
          passwordHidden={passwordHidden}
          passwordVisible={passwordFocused && showPassword && password.length > 0}
          loginFailed={loginFailed}
        />
        <p className="wme-login-foot">世界观协作平台 · 档案馆与编年史</p>
      </aside>

      {/* 右侧：登录表单 */}
      <main className="wme-login-right">
        <div className="wme-login-card">
          <span className="wme-login-sparkle" aria-hidden="true">
            ✦
          </span>
          <h1 className="wme-login-title">欢迎回来</h1>
          <p className="wme-login-subtitle">输入用户名与密码，继续你的世界</p>

          <form className="wme-form" onSubmit={handleSubmit} noValidate>
            <label className={`wme-field${error && !username.trim() ? " is-error" : ""}`}>
              <span className="wme-field-label">用户名</span>
              <input
                className="wme-field-input"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                onFocus={() => setIdentityFocused(true)}
                onBlur={() => setIdentityFocused(false)}
                autoComplete="username"
                spellCheck={false}
              />
            </label>

            <label className={`wme-field${error ? " is-error" : ""}`}>
              <span className="wme-field-label">密码</span>
              <span className="wme-field-row">
                <input
                  className="wme-field-input"
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  onFocus={() => setPasswordFocused(true)}
                  onBlur={() => setPasswordFocused(false)}
                  autoComplete="current-password"
                />
                <button
                  type="button"
                  className="wme-eye-toggle"
                  onClick={() => setShowPassword((value) => !value)}
                  aria-label={showPassword ? "隐藏密码" : "显示密码"}
                  title={showPassword ? "隐藏密码" : "显示密码"}
                >
                  {showPassword ? "隐藏" : "显示"}
                </button>
              </span>
            </label>

            {error && <div className="wme-error">{error}</div>}

            <button type="submit" className="wme-submit" disabled={submitting}>
              <span className="wme-submit-text">{submitting ? "登录中…" : "登录"}</span>
              <span className="wme-submit-hover" aria-hidden="true">
                <span>{submitting ? "登录中…" : "登录"}</span>
                <span className="wme-submit-arrow">→</span>
              </span>
            </button>
          </form>

          <p className="wme-login-hint">
            忘记密码请联系管理员重置 · 没有账号？<Link to="/register">用邀请码注册</Link>
          </p>
        </div>
      </main>
    </div>
  );
}
