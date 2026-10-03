import type { MemberRole, WorldVisibility } from "@create-world/core";
import { hasRoleLevel } from "@create-world/core";

/** worlds 表的数据行 */
export interface WorldRow {
  id: string;
  owner_id: string;
  name: string;
  intro: string;
  cover: string | null;
  visibility: WorldVisibility;
  created_at: number;
  updated_at: number;
}

/** 世界权限解析结果 */
export interface WorldAccess {
  world: WorldRow;
  /** 当前用户在该世界的角色；非成员为 null */
  role: MemberRole | null;
  /** 当前用户是否被该世界拉黑 */
  banned: boolean;
}

/**
 * 加载世界并解析当前用户（可为空）的访问权限。
 * @param db D1 数据库
 * @param worldId 世界 id
 * @param userId 当前用户 id，未登录传 null
 * @returns 世界与权限信息；世界不存在返回 null
 */
export async function loadWorldAccess(
  db: D1Database,
  worldId: string,
  userId: string | null,
): Promise<WorldAccess | null> {
  const world = await db
    .prepare("SELECT * FROM worlds WHERE id = ?")
    .bind(worldId)
    .first<WorldRow>();
  if (!world) {
    return null;
  }

  let role: MemberRole | null = null;
  let banned = false;
  if (userId) {
    const member = await db
      .prepare("SELECT role FROM world_members WHERE world_id = ? AND user_id = ?")
      .bind(worldId, userId)
      .first<{ role: MemberRole }>();
    role = member?.role ?? null;

    const ban = await db
      .prepare("SELECT user_id FROM world_bans WHERE world_id = ? AND user_id = ?")
      .bind(worldId, userId)
      .first();
    banned = ban !== null;
  }

  return { world, role, banned };
}

/**
 * 判断能否查看世界：成员或公开世界可看。
 * 注意：被拉黑只禁止编辑，不影响查看公开内容。
 * @param access 权限解析结果
 * @returns 可查看返回 true
 */
export function canRead(access: WorldAccess): boolean {
  if (access.world.visibility !== "private") {
    return true;
  }
  return access.role !== null;
}

/**
 * 判断能否编辑世界内容（条目等）。
 * 规则：成员角色 ≥ editor；或公开可编写世界 + 已登录 + 未被拉黑。
 * @param access 权限解析结果
 * @param userId 当前用户 id，未登录传 null
 * @returns 可编辑返回 true
 */
export function canEdit(access: WorldAccess, userId: string | null): boolean {
  if (access.role && hasRoleLevel(access.role, "editor")) {
    return true;
  }
  if (access.world.visibility === "public_edit" && userId && !access.banned) {
    return true;
  }
  return false;
}
