/** 新账号保护期：注册后 7 天内算新账号 */
const NEW_ACCOUNT_PERIOD_MS = 7 * 24 * 60 * 60 * 1000;

/** 新账号每日写操作上限（MVP 粗粒度策略） */
const NEW_ACCOUNT_DAILY_WRITES = 30;

/**
 * 新账号写操作限流：注册不满 7 天的用户，每天最多 NEW_ACCOUNT_DAILY_WRITES 次写操作。
 * 说明：此处为 MVP 粗粒度策略，计数按「用户 + UTC 自然日」累计。
 * @param db D1 数据库
 * @param user 当前用户（需含 id 与 createdAt）
 * @returns 允许写入返回 true；超限返回 false
 */
export async function checkNewAccountQuota(
  db: D1Database,
  user: { id: string; createdAt: Date },
): Promise<boolean> {
  const ageMs = Date.now() - new Date(user.createdAt).getTime();
  if (ageMs >= NEW_ACCOUNT_PERIOD_MS) {
    return true;
  }

  const day = new Date().toISOString().slice(0, 10);
  const row = await db
    .prepare("SELECT count FROM write_counters WHERE user_id = ? AND day = ?")
    .bind(user.id, day)
    .first<{ count: number }>();
  const used = row?.count ?? 0;
  if (used >= NEW_ACCOUNT_DAILY_WRITES) {
    return false;
  }

  await db
    .prepare(
      `INSERT INTO write_counters (user_id, day, count) VALUES (?, ?, 1)
       ON CONFLICT (user_id, day) DO UPDATE SET count = count + 1`,
    )
    .bind(user.id, day)
    .run();
  return true;
}
