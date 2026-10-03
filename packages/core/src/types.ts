/** 用户站点角色：普通用户 / 站点管理员 */
export type SiteRole = "user" | "admin";

/** 用户账号状态 */
export type UserStatus = "active" | "disabled" | "banned";

/** 世界可见性：私有 / 公开只读 / 公开可编写 */
export type WorldVisibility = "private" | "public_read" | "public_edit";

/** 世界内成员角色 */
export type MemberRole = "owner" | "admin" | "editor" | "viewer";

/** 成员的加入方式：邀请 / 开放编写加入 */
export type JoinSource = "invite" | "open";

/** 邀请码范围：平台注册码 / 世界邀请码 */
export type InviteScope = "platform" | "world";

/** 邀请码状态 */
export type InviteStatus = "active" | "disabled";

/** 对外公开的用户信息（不含邮箱等敏感字段） */
export interface PublicUser {
  id: string;
  /** 登录用用户名（小写归一化） */
  username: string;
  /** 展示用昵称 */
  displayName: string;
  /** 头像图片地址，可为空 */
  avatar: string | null;
}

/** 世界基础信息 */
export interface World {
  id: string;
  ownerId: string;
  name: string;
  intro: string;
  cover: string | null;
  visibility: WorldVisibility;
  createdAt: number;
  updatedAt: number;
}

/** 发现页 / 列表页使用的世界摘要（附带统计与标签） */
export interface WorldSummary extends World {
  /** 创建者昵称 */
  ownerName: string;
  /** 条目数量 */
  entryCount: number;
  /** 成员数量 */
  memberCount: number;
  /** 世界标签名称列表 */
  tags: string[];
  /** 当前用户在该世界的角色（仅「我的世界」列表返回） */
  role?: MemberRole;
}

/** 世界内自定义分类 */
export interface Category {
  id: string;
  worldId: string;
  name: string;
  /** 图标标识（如预设图标名），可为空 */
  icon: string | null;
  /** 颜色值（如 #8a6d3b），可为空 */
  color: string | null;
  /** 排序值，越小越靠前 */
  sortOrder: number;
}

/** 条目元数据（正文内容存于 entry_blocks 表） */
export interface Entry {
  id: string;
  worldId: string;
  categoryId: string;
  title: string;
  cover: string | null;
  /** 标签，逗号分隔存储 */
  tags: string;
  /** 别名，逗号分隔存储 */
  aliases: string;
  /** 是否受保护：1 时仅管理员及以上可编辑 */
  protected: 0 | 1;
  /** 总字数（所有块之和） */
  wordCount: number;
  /** 版本号，用于保存时并发校验 */
  version: number;
  /** 最后编辑人 id */
  lastEditorId: string | null;
  createdAt: number;
  updatedAt: number;
}

/** 条目内容块（长文按块存储，支持懒加载与增量保存） */
export interface EntryBlock {
  id: string;
  entryId: string;
  /** 块序号，从 0 开始 */
  sortOrder: number;
  /** 块标题（一般取块内首个标题） */
  title: string;
  /** TipTap JSON 序列化后的正文 */
  contentJson: string;
  wordCount: number;
  /** 块级版本号，用于块级并发校验 */
  version: number;
  updatedAt: number;
}

/** 邀请码 */
export interface InviteCode {
  id: string;
  /** 邀请码字符串 */
  code: string;
  scope: InviteScope;
  /** 世界邀请码对应的世界 id，平台码为 null */
  worldId: string | null;
  /** 世界邀请码加入后的角色，平台码为 null */
  role: MemberRole | null;
  /** 创建人 id */
  createdBy: string | null;
  /** 最大可用次数 */
  maxUses: number;
  /** 已用次数 */
  usedCount: number;
  /** 过期时间戳（毫秒），null 表示永不过期 */
  expiresAt: number | null;
  status: InviteStatus;
  createdAt: number;
}

/** 世界成员记录 */
export interface WorldMember {
  worldId: string;
  userId: string;
  role: MemberRole;
  source: JoinSource;
  joinedAt: number;
}
