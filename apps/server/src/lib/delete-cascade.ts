/**
 * 级联删除工具：世界与条目的完整清理。
 * 被世界删除接口、条目删除接口与站点管理后台共用。
 */

/**
 * 级联删除世界及其全部关联数据。
 * 包含：条目链接、内容块、条目关联、版本、条目、分类、标签关联、成员、黑名单、邀请码。
 * @param db D1 数据库
 * @param worldId 世界 id
 */
export async function deleteWorldCascade(db: D1Database, worldId: string): Promise<void> {
  await db.batch([
    db
      .prepare(
        "UPDATE entry_links SET to_entry_id = NULL WHERE to_entry_id IN (SELECT id FROM entries WHERE world_id = ?)",
      )
      .bind(worldId),
    db.prepare("DELETE FROM entry_blocks WHERE entry_id IN (SELECT id FROM entries WHERE world_id = ?)").bind(worldId),
    db.prepare("DELETE FROM entry_links WHERE from_entry_id IN (SELECT id FROM entries WHERE world_id = ?)").bind(worldId),
    db.prepare("DELETE FROM entry_versions WHERE entry_id IN (SELECT id FROM entries WHERE world_id = ?)").bind(worldId),
    db.prepare("DELETE FROM entries WHERE world_id = ?").bind(worldId),
    db.prepare("DELETE FROM categories WHERE world_id = ?").bind(worldId),
    db.prepare("DELETE FROM world_tags WHERE world_id = ?").bind(worldId),
    db.prepare("DELETE FROM world_members WHERE world_id = ?").bind(worldId),
    db.prepare("DELETE FROM world_bans WHERE world_id = ?").bind(worldId),
    db.prepare("DELETE FROM invite_codes WHERE world_id = ?").bind(worldId),
    db.prepare("DELETE FROM eras WHERE world_id = ?").bind(worldId),
    db.prepare("DELETE FROM timeline_events WHERE world_id = ?").bind(worldId),
    db.prepare("DELETE FROM worlds WHERE id = ?").bind(worldId),
  ]);
}

/**
 * 级联删除条目及其内容块、关联与历史版本。
 * @param db D1 数据库
 * @param entryId 条目 id
 */
export async function deleteEntryCascade(db: D1Database, entryId: string): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM entry_blocks WHERE entry_id = ?").bind(entryId),
    db.prepare("DELETE FROM entry_links WHERE from_entry_id = ?").bind(entryId),
    db.prepare("UPDATE entry_links SET to_entry_id = NULL WHERE to_entry_id = ?").bind(entryId),
    db.prepare("DELETE FROM entry_versions WHERE entry_id = ?").bind(entryId),
    db.prepare("DELETE FROM entries WHERE id = ?").bind(entryId),
  ]);
}
