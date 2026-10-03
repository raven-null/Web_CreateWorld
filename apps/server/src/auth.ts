import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { username } from "better-auth/plugins";
import { env } from "cloudflare:workers";
import { PASSWORD_MIN_LENGTH, USERNAME_PATTERN } from "@create-world/core";
import type { Env } from "./types";

// Workers 运行时通过 cloudflare:workers 提供绑定；此处收窄为项目 Env 类型
const bindings = env as unknown as Env;

/**
 * better-auth 实例（模块级单例）。
 * 设计说明：
 * - 本期不接邮件服务，邮箱字段存占位值（用户名@user.invalid），仅作框架兼容
 * - 用户名登录使用 username 插件；用户名不可修改
 * - role / status 为服务端维护字段，用户不可自设
 */
export const auth = betterAuth({
  database: bindings.DB,
  baseURL: bindings.BETTER_AUTH_URL,
  secret: bindings.BETTER_AUTH_SECRET,
  emailAndPassword: {
    enabled: true,
    minPasswordLength: PASSWORD_MIN_LENGTH,
  },
  user: {
    additionalFields: {
      // 站点角色：user 普通用户 / admin 站点管理员
      role: { type: "string", required: false, defaultValue: "user", input: false },
      // 账号状态：active 正常 / disabled 禁用 / banned 封禁
      status: { type: "string", required: false, defaultValue: "active", input: false },
    },
  },
  plugins: [
    username({
      minUsernameLength: 3,
      maxUsernameLength: 24,
      // 用户名用于登录与贡献记录，一旦设置不可修改
      immutableUsername: true,
      // 只允许字母开头，后接字母 / 数字 / 下划线
      usernameValidator: (value) => USERNAME_PATTERN.test(value),
    }),
  ],
  // 本地开发时 Vite 前端地址（生产与 API 同源，无需配置）
  trustedOrigins: ["http://localhost:5173"],
  hooks: {
    before: async (ctx) => {
      // 根级 hooks 的输入上下文类型未声明 path/body，运行时存在，这里做类型收窄
      const input = ctx as unknown as { path?: string; body?: { username?: string } };
      // 登录前检查账号状态：被禁用 / 封禁的账号给出明确提示
      if (input.path === "/sign-in/username") {
        const username = (input.body?.username ?? "").trim().toLowerCase();
        if (!username) {
          return;
        }
        const row = await bindings.DB.prepare("SELECT status FROM user WHERE username = ?")
          .bind(username)
          .first<{ status: string }>();
        if (row && row.status !== "active") {
          throw new APIError("FORBIDDEN", {
            message: row.status === "banned" ? "账号已被封禁" : "账号已被禁用，请联系管理员",
          });
        }
      }
    },
  },
});

/**
 * 生成占位邮箱：本期无邮件服务，用固定保留域名 user.invalid 作占位。
 * @param username 用户名（小写归一化后）
 * @returns 占位邮箱地址
 */
export function placeholderEmail(username: string): string {
  return `${username}@user.invalid`;
}
