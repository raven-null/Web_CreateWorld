import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import AnimatedCharacters from "../components/AnimatedCharacters";
import { api } from "../lib/api";
import { authClient } from "../lib/auth-client";
import { translateAuthError } from "../lib/auth-errors";
import { showToast } from "../lib/toast";

/** 认证模式 */
type AuthMode = "login" | "register";

/** 登录失败后角色恢复常态的延迟（与参考设计一致） */
const ERROR_RESET_MS = 2500;

/** 邀请码校验结果 */
interface InviteInfo {
  valid: boolean;
  scope?: "platform" | "world";
  role?: string | null;
  worldName?: string | null;
}

/** 认证页属性 */
export interface AuthPageProps {
  /** 初始模式；切换不改变 URL（两个路由指向同一页，避免来回跳转丢输入） */
  mode?: AuthMode;
}

/**
 * 认证页：**登录与注册合并在同一页**，用顶部标签切换。
 *
 * 为什么合并：两者字段高度重合（用户名 + 密码），视觉与交互（左侧交互动画角色）
 * 完全一致；分开会让人来回跳页面、丢失已输入内容。路由仍是两条
 * （`/login`、`/register`），因此既有链接与邀请链接不受影响。
 *
 * @param props 见 `AuthPageProps`
 * @returns 认证页节点
 */
export default function AuthPage({ mode: initialMode = "login" }: AuthPageProps) {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [mode, setMode] = useState<AuthMode>(initialMode);

  // 登录字段
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  // 注册字段
  const [inviteCode, setInviteCode] = useState(searchParams.get("code") ?? "");
  const [displayName, setDisplayName] = useState("");
  const [inviteInfo, setInviteInfo] = useState<InviteInfo | null>(null);

  const [showPassword, setShowPassword] = useState(false);
  const [identityFocused, setIdentityFocused] = useState(false);
  const [passwordFocused, setPasswordFocused] = useState(false);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [loginFailed, setLoginFailed] = useState(false);

  const resetTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (resetTimerRef.current !== null) {
        window.clearTimeout(resetTimerRef.current);
      }
    };
  }, []);

  /**
   * 触发失败反馈：角色摇头，并在 2.5 秒后自动恢复。
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

  /** 校验邀请码：有效时展示来源（平台 / 世界） */
  const checkInvite = useCallback(async (code: string): Promise<void> => {
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
  }, []);

  // 从邀请链接进入时自动校验一次
  useEffect(() => {
    if (inviteCode) {
      void checkInvite(inviteCode);
    }
  }, [checkInvite, inviteCode]);

  /** 切换模式：清掉错误与密码，避免上一个模式的状态干扰 */
  const switchMode = useCallback((next: AuthMode): void => {
    setMode(next);
    setError("");
    setPassword("");
    setShowPassword(false);
    setPasswordFocused(false);
  }, []);

  /** 提交登录 */
  const handleLogin = async (): Promise<void> => {
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

  /** 提交注册：成功后自动登录并进入「我的世界」 */
  const handleRegister = async (): Promise<void> => {
    const normalizedName = username.trim().toLowerCase();
    if (!inviteCode.trim()) {
      triggerFailure("请填写邀请码");
      return;
    }
    if (!normalizedName) {
      triggerFailure("请填写用户名");
      return;
    }
    if (password.length < 8) {
      triggerFailure("密码至少 8 位");
      return;
    }

    setSubmitting(true);
    try {
      await api("/api/register", {
        method: "POST",
        body: {
          inviteCode: inviteCode.trim(),
          username: normalizedName,
          password,
          displayName: displayName.trim(),
        },
      });
      const { error: signInError } = await authClient.signIn.username({
        username: normalizedName,
        password,
      });
      if (signInError) {
        showToast("warning", `注册成功，但自动登录失败：${translateAuthError(signInError.message)}`);
        navigate("/login");
        return;
      }
      navigate("/worlds");
    } catch (err) {
      triggerFailure((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  /** 表单提交入口 */
  const handleSubmit = (event: FormEvent): void => {
    event.preventDefault();
    void (mode === "login" ? handleLogin() : handleRegister());
  };

  const isRegister = mode === "register";
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

      {/* 右侧：表单 */}
      <main className="wme-login-right">
        <div className="wme-login-card">
          <span className="wme-login-sparkle" aria-hidden="true">
            ✦
          </span>

          {/* 模式切换 */}
          <div className="wme-auth-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={!isRegister}
              className={`wme-auth-tab${!isRegister ? " is-active" : ""}`}
              onClick={() => switchMode("login")}
            >
              登录
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={isRegister}
              className={`wme-auth-tab${isRegister ? " is-active" : ""}`}
              onClick={() => switchMode("register")}
            >
              注册
            </button>
          </div>

          <h1 className="wme-login-title">{isRegister ? "创建账号" : "欢迎回来"}</h1>
          <p className="wme-login-subtitle">
            {isRegister ? "凭邀请码注册，无需邮箱" : "输入用户名与密码，继续你的世界"}
          </p>

          <form className="wme-form" onSubmit={handleSubmit} noValidate>
            {isRegister && (
              <label className={`wme-field${inviteInfo && !inviteInfo.valid ? " is-error" : ""}`}>
                <span className="wme-field-label">邀请码</span>
                <input
                  className="wme-field-input"
                  value={inviteCode}
                  onChange={(event) => setInviteCode(event.target.value)}
                  onFocus={() => setIdentityFocused(true)}
                  onBlur={() => {
                    setIdentityFocused(false);
                    void checkInvite(inviteCode);
                  }}
                  placeholder="如 create-world"
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
            )}

            {isRegister && inviteInfo && inviteInfo.valid && (
              <div className="wme-invite-note">
                {inviteInfo.scope === "world"
                  ? `你将被加入世界《${inviteInfo.worldName ?? "未知"}》`
                  : "邀请码有效，注册后即可创建自己的世界"}
              </div>
            )}
            {isRegister && inviteInfo && !inviteInfo.valid && (
              <div className="wme-invite-note is-error">邀请码无效或已用完</div>
            )}

            <label className={`wme-field${error && !username.trim() ? " is-error" : ""}`}>
              <span className="wme-field-label">
                用户名
                {isRegister && <span className="wme-field-hint">登录用，注册后不可修改</span>}
              </span>
              <input
                className="wme-field-input"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                onFocus={() => setIdentityFocused(true)}
                onBlur={() => setIdentityFocused(false)}
                placeholder={isRegister ? "3-24 位，字母开头" : undefined}
                autoComplete="username"
                spellCheck={false}
              />
            </label>

            {isRegister && (
              <label className="wme-field">
                <span className="wme-field-label">
                  昵称<span className="wme-field-hint">展示用，可留空</span>
                </span>
                <input
                  className="wme-field-input"
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                  onFocus={() => setIdentityFocused(true)}
                  onBlur={() => setIdentityFocused(false)}
                  placeholder="不填则与用户名相同"
                />
              </label>
            )}

            <label className={`wme-field${error ? " is-error" : ""}`}>
              <span className="wme-field-label">
                密码
                {isRegister && <span className="wme-field-hint">至少 8 位</span>}
              </span>
              <span className="wme-field-row">
                <input
                  className="wme-field-input"
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  onFocus={() => setPasswordFocused(true)}
                  onBlur={() => setPasswordFocused(false)}
                  autoComplete={isRegister ? "new-password" : "current-password"}
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
              <span className="wme-submit-text">
                {submitting ? (isRegister ? "注册中…" : "登录中…") : isRegister ? "注册并进入" : "登录"}
              </span>
              <span className="wme-submit-hover" aria-hidden="true">
                <span>{submitting ? (isRegister ? "注册中…" : "登录中…") : isRegister ? "注册并进入" : "登录"}</span>
                <span className="wme-submit-arrow">→</span>
              </span>
            </button>
          </form>

          <p className="wme-login-hint">
            {isRegister ? (
              <>
                已有账号？<button type="button" className="wme-link" onClick={() => switchMode("login")}>去登录</button>
              </>
            ) : (
              <>
                忘记密码请联系管理员重置 · 没有账号？
                <button type="button" className="wme-link" onClick={() => switchMode("register")}>
                  用邀请码注册
                </button>
              </>
            )}
          </p>
        </div>
      </main>
    </div>
  );
}
