/** Worker 环境变量与资源绑定 */
export interface Env {
  /** D1 数据库绑定 */
  DB: D1Database;
  /** 图片存储（KV）绑定 */
  IMAGES: KVNamespace;
  /**
   * 静态资源绑定（Workers Assets）。
   * 用途：让 Worker 接管首页请求以便设置缓存头——直接静态直出时 `_headers` 对 HTML 不生效，
   * 导致每次刷新都要跨境重新验证（实测 0.7~2.7s）。
   */
  ASSETS: Fetcher;
  /** better-auth 会话加密密钥 */
  BETTER_AUTH_SECRET: string;
  /** 服务基础地址（本地 http://localhost:8787） */
  BETTER_AUTH_URL: string;
  /** 初始站点管理员用户名，逗号分隔（注册时自动授予管理员） */
  ADMIN_USERNAMES?: string;
  /** 平台引导邀请码：数据库无邀请码时用它完成首次注册 */
  BOOTSTRAP_INVITE_CODE?: string;
  /** 数据库迁移接口密钥 */
  MIGRATE_SECRET?: string;
  /** AI API Key 加密密钥（用于用户密钥的加密存储） */
  AI_KEY_SECRET?: string;
}
