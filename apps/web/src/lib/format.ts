/**
 * 把毫秒时间戳格式化为本地日期时间。
 * @param timestamp 毫秒时间戳
 * @returns 如 2026/10/3 14:30
 */
export function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * 从会话用户对象中读取站点角色。
 * 客户端类型未声明 additionalFields，这里用运行时判断安全取值。
 * @param user 会话用户对象（类型未知）
 * @returns 角色字符串，默认 user
 */
export function readUserRole(user: unknown): string {
  if (
    user !== null &&
    typeof user === "object" &&
    "role" in user &&
    typeof (user as { role: unknown }).role === "string"
  ) {
    return (user as { role: string }).role;
  }
  return "user";
}
