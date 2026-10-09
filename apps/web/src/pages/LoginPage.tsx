import AuthPage from "./AuthPage";

/**
 * 登录页（路由 `/login`）。
 *
 * 登录与注册已合并到 `AuthPage`：两者字段重合、视觉一致，
 * 分开会让人来回跳页并丢失输入。这里保留文件与路由，
 * 既有链接（含书签与外部引用）不受影响。
 */
export default function LoginPage() {
  return <AuthPage mode="login" />;
}