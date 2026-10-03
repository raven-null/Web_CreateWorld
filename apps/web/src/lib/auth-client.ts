import { createAuthClient } from "better-auth/react";
import { usernameClient } from "better-auth/client/plugins";

/**
 * better-auth 前端客户端。
 * 与页面同源（开发时经 Vite 代理），默认走 /api/auth。
 */
export const authClient = createAuthClient({
  plugins: [usernameClient()],
});
