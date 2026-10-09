import AuthPage from "./AuthPage";

/**
 * 注册页（路由 `/register`）。
 *
 * 与登录页共用 `AuthPage`，初始显示注册标签；
 * 从邀请链接进入时 `?code=` 会被 AuthPage 自动读取并校验。
 */
export default function RegisterPage() {
  return <AuthPage mode="register" />;
}