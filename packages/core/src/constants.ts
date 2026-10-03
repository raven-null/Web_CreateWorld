import type { MemberRole, WorldVisibility } from "./types";

/** 世界可见性的中文展示文案 */
export const VISIBILITY_LABELS: Record<WorldVisibility, string> = {
  private: "私有",
  public_read: "公开只读",
  public_edit: "公开可编写",
};

/** 成员角色的中文展示文案 */
export const ROLE_LABELS: Record<MemberRole, string> = {
  owner: "创建者",
  admin: "管理员",
  editor: "编辑",
  viewer: "只读",
};

/** 角色权限等级：数字越大权限越高，用于「至少需要某角色」的判断 */
export const ROLE_LEVEL: Record<MemberRole, number> = {
  viewer: 1,
  editor: 2,
  admin: 3,
  owner: 4,
};

/**
 * 判断成员角色是否达到要求（如 editor 能否执行 admin 操作）。
 * @param role 当前用户角色
 * @param required 要求的最低角色
 * @returns 满足要求返回 true
 */
export function hasRoleLevel(role: MemberRole, required: MemberRole): boolean {
  return ROLE_LEVEL[role] >= ROLE_LEVEL[required];
}

/** 创建世界时自动生成的预设分类（新手引导） */
export const DEFAULT_CATEGORIES: ReadonlyArray<{ name: string; icon: string }> = [
  { name: "人物", icon: "user" },
  { name: "地点", icon: "map-pin" },
  { name: "势力", icon: "flag" },
  { name: "物品", icon: "package" },
  { name: "事件", icon: "calendar" },
];

/** 平台预设的世界标签库（初始值，管理员可在后台维护） */
export const DEFAULT_TAGS: readonly string[] = [
  "奇幻",
  "科幻",
  "武侠",
  "都市",
  "历史",
  "架空",
  "跑团设定",
  "小说企划",
];

/** 用户名规则：字母开头，可含字母、数字、下划线，3-24 位 */
export const USERNAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]{2,23}$/;

/** 密码最短长度 */
export const PASSWORD_MIN_LENGTH = 8;

/** 单条目正文超过该字数时，编辑页切换为「分块编辑」模式 */
export const BLOCK_EDIT_WORD_THRESHOLD = 30000;
