/**
 * 认证相关错误中文化。
 * better-auth 客户端返回的报错是英文，统一映射为中文提示；
 * 已经是中文的（我们服务端返回的）原样保留。
 */

/**
 * 把认证 / 网络层错误消息转换为中文提示。
 * @param message 原始错误消息（可能为空或英文）
 * @returns 面向用户的中文提示
 */
export function translateAuthError(message: string | undefined | null): string {
  if (!message) {
    return "操作失败，请重试";
  }
  // 已是中文（服务端自定义文案）直接透传
  if (/[\u4e00-\u9fff]/.test(message)) {
    return message;
  }

  const text = message.toLowerCase();
  if (
    text.includes("invalid username") ||
    text.includes("invalid email") ||
    text.includes("invalid credential") ||
    text.includes("incorrect")
  ) {
    return "用户名或密码错误";
  }
  if (text.includes("already exists") || text.includes("already taken") || text.includes("already in use")) {
    return "用户名已被占用";
  }
  if (text.includes("invalid password")) {
    return "当前密码错误";
  }
  if (text.includes("password") && (text.includes("short") || text.includes("least") || text.includes("length"))) {
    return "密码长度不足（至少 8 位）";
  }
  if (text.includes("too many") || text.includes("rate limit")) {
    return "操作过于频繁，请稍后再试";
  }
  if (text.includes("not found")) {
    return "账号不存在";
  }
  if (text.includes("unauthorized") || text.includes("forbidden")) {
    return "没有权限或登录已过期，请重新登录";
  }
  return "操作失败，请重试";
}
