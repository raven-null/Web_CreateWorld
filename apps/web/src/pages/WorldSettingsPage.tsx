import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ROLE_LABELS, VISIBILITY_LABELS, type MemberRole, type WorldVisibility } from "@create-world/core";
import { api } from "../lib/api";
import { formatTime } from "../lib/format";
import { showToast } from "../lib/toast";

/** 世界详情（设置页用到的字段） */
interface WorldDetail {
  id: string;
  name: string;
  intro: string;
  visibility: WorldVisibility;
  tags: string[];
  myRole: MemberRole | null;
  ownerName: string;
  categories: Array<{ id: string; name: string; sortOrder: number }>;
}

/** 成员列表项 */
interface MemberItem {
  userId: string;
  username: string;
  displayName: string;
  role: MemberRole;
  source: string;
  joinedAt: number;
}

/** 黑名单项 */
interface BanItem {
  userId: string;
  username: string;
  displayName: string;
  createdAt: number;
}

/**
 * 世界设置页：基本信息、分类管理、成员管理、邀请、黑名单、危险操作。
 * 仅世界管理员（owner / admin）可进入。
 */
export default function WorldSettingsPage() {
  const { worldId = "" } = useParams<{ worldId: string }>();
  const navigate = useNavigate();

  const [world, setWorld] = useState<WorldDetail | null>(null);
  const [members, setMembers] = useState<MemberItem[]>([]);
  const [bans, setBans] = useState<BanItem[]>([]);
  const [allTags, setAllTags] = useState<string[]>([]);
  const [error, setError] = useState("");

  // 基本信息表单
  const [name, setName] = useState("");
  const [intro, setIntro] = useState("");
  const [visibility, setVisibility] = useState<WorldVisibility>("private");
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [savingBasic, setSavingBasic] = useState(false);

  // 分类管理
  const [newCategoryName, setNewCategoryName] = useState("");

  // 时间系统
  const [eras, setEras] = useState<Array<{ id: string; name: string }>>([]);
  const [granularity, setGranularity] = useState<"year" | "month" | "day">("day");
  const [numberStyle, setNumberStyle] = useState<"arabic" | "chinese">("arabic");
  const [newEraName, setNewEraName] = useState("");

  // 邀请
  const [inviteRole, setInviteRole] = useState("editor");
  const [inviteCode, setInviteCode] = useState("");

  /** 加载世界详情、成员与黑名单 */
  const loadAll = useCallback(async () => {
    try {
      const detail = await api<WorldDetail>(`/api/worlds/${worldId}`);
      setWorld(detail);
      setName(detail.name);
      setIntro(detail.intro);
      setVisibility(detail.visibility);
      setSelectedTags(detail.tags);

      if (detail.myRole === "owner" || detail.myRole === "admin") {
        const [memberList, banList, timeline] = await Promise.all([
          api<MemberItem[]>(`/api/worlds/${worldId}/members`),
          api<BanItem[]>(`/api/worlds/${worldId}/bans`),
          api<{
            eras: Array<{ id: string; name: string }>;
            timeConfig: { granularity: "year" | "month" | "day"; numberStyle: "arabic" | "chinese" };
          }>(`/api/worlds/${worldId}/timeline`),
        ]);
        setMembers(memberList);
        setBans(banList);
        setEras(timeline.eras);
        setGranularity(timeline.timeConfig.granularity);
        setNumberStyle(timeline.timeConfig.numberStyle);
      }
      setError("");
    } catch (err) {
      setError((err as Error).message);
    }
  }, [worldId]);

  useEffect(() => {
    void loadAll();
    api<string[]>("/api/discover/tags")
      .then(setAllTags)
      .catch(() => setAllTags([]));
  }, [loadAll]);

  if (error && !world) {
    return <div className="notice error">{error}</div>;
  }
  if (!world) {
    return <div className="loading">加载中…</div>;
  }
  if (world.myRole !== "owner" && world.myRole !== "admin") {
    return <div className="notice error">需要世界管理员权限才能进入设置</div>;
  }

  const isOwner = world.myRole === "owner";

  /** 保存基本信息（名称 / 简介 / 可见性 / 标签） */
  const handleSaveBasic = async () => {
    setSavingBasic(true);
    try {
      await api(`/api/worlds/${worldId}`, {
        method: "PATCH",
        body: { name, intro, visibility, tags: selectedTags },
      });
      showToast("success", "基本信息已保存");
      await loadAll();
    } catch (err) {
      showToast("error", (err as Error).message);
    } finally {
      setSavingBasic(false);
    }
  };

  /** 点选 / 取消世界标签（最多 5 个） */
  const toggleTag = (tag: string) => {
    setSelectedTags((current) => {
      if (current.includes(tag)) {
        return current.filter((item) => item !== tag);
      }
      return current.length >= 5 ? current : [...current, tag];
    });
  };

  /** 新增分类 */
  const handleAddCategory = async () => {
    if (!newCategoryName.trim()) {
      return;
    }
    try {
      await api(`/api/worlds/${worldId}/categories`, { method: "POST", body: { name: newCategoryName.trim() } });
      setNewCategoryName("");
      await loadAll();
    } catch (err) {
      showToast("error", (err as Error).message);
    }
  };

  /** 重命名分类 */
  const handleRenameCategory = async (categoryId: string, value: string) => {
    if (!value.trim()) {
      return;
    }
    try {
      await api(`/api/categories/${categoryId}`, { method: "PATCH", body: { name: value.trim() } });
      await loadAll();
    } catch (err) {
      showToast("error", (err as Error).message);
    }
  };

  /** 删除分类 */
  const handleDeleteCategory = async (categoryId: string, categoryName: string) => {
    if (!window.confirm(`确定删除分类「${categoryName}」？`)) {
      return;
    }
    try {
      await api(`/api/categories/${categoryId}`, { method: "DELETE" });
      await loadAll();
    } catch (err) {
      showToast("error", (err as Error).message);
    }
  };

  /** 保存时间系统设置（时间粒度 / 数字风格） */
  const handleSaveTimeSettings = async () => {
    try {
      await api(`/api/worlds/${worldId}/time-settings`, {
        method: "PATCH",
        body: { granularity, numberStyle },
      });
      showToast("success", "时间设置已保存");
    } catch (err) {
      showToast("error", (err as Error).message);
    }
  };

  /** 新增纪元 */
  const handleAddEra = async () => {
    if (!newEraName.trim()) {
      return;
    }
    try {
      await api(`/api/worlds/${worldId}/eras`, { method: "POST", body: { name: newEraName.trim() } });
      setNewEraName("");
      await loadAll();
    } catch (err) {
      showToast("error", (err as Error).message);
    }
  };

  /** 重命名纪元 */
  const handleRenameEra = async (eraId: string, value: string) => {
    if (!value.trim()) {
      return;
    }
    try {
      await api(`/api/eras/${eraId}`, { method: "PATCH", body: { name: value.trim() } });
      await loadAll();
    } catch (err) {
      showToast("error", (err as Error).message);
    }
  };

  /** 删除纪元 */
  const handleDeleteEra = async (eraId: string, eraName: string) => {
    if (!window.confirm(`确定删除纪元「${eraName}」？`)) {
      return;
    }
    try {
      await api(`/api/eras/${eraId}`, { method: "DELETE" });
      await loadAll();
    } catch (err) {
      showToast("error", (err as Error).message);
    }
  };

  /** 调整成员角色 */
  const handleChangeRole = async (userId: string, role: string) => {
    try {
      await api(`/api/worlds/${worldId}/members/${userId}`, { method: "PATCH", body: { role } });
      await loadAll();
    } catch (err) {
      showToast("error", (err as Error).message);
    }
  };

  /** 移除成员（可选同时拉黑） */
  const handleRemoveMember = async (member: MemberItem, ban: boolean) => {
    const tip = ban ? `确定移除并拉黑「${member.displayName}」？` : `确定移除成员「${member.displayName}」？`;
    if (!window.confirm(tip)) {
      return;
    }
    try {
      await api(`/api/worlds/${worldId}/members/${member.userId}${ban ? "?ban=1" : ""}`, { method: "DELETE" });
      await loadAll();
    } catch (err) {
      showToast("error", (err as Error).message);
    }
  };

  /** 解除拉黑 */
  const handleUnban = async (userId: string) => {
    try {
      await api(`/api/worlds/${worldId}/bans/${userId}`, { method: "DELETE" });
      await loadAll();
    } catch (err) {
      showToast("error", (err as Error).message);
    }
  };

  /** 生成世界邀请码 */
  const handleCreateInvite = async () => {
    setInviteCode("");
    try {
      const data = await api<{ code: string }>(`/api/worlds/${worldId}/invites`, {
        method: "POST",
        body: { role: inviteRole },
      });
      setInviteCode(data.code);
    } catch (err) {
      showToast("error", (err as Error).message);
    }
  };

  /** 删除世界（仅创建者），成功后回到我的世界 */
  const handleDeleteWorld = async () => {
    if (!window.confirm(`确定删除世界「${world.name}」？所有条目与历史将不可恢复。`)) {
      return;
    }
    try {
      await api(`/api/worlds/${worldId}`, { method: "DELETE" });
      navigate("/worlds");
    } catch (err) {
      showToast("error", (err as Error).message);
    }
  };

  const registerLink = inviteCode ? `${window.location.origin}/register?code=${inviteCode}` : "";

  return (
    <>
      <h1 className="page-title">世界设置</h1>
      <p className="page-subtitle">
        <Link to={`/w/${worldId}`}>{world.name}</Link> · 创建者 {world.ownerName}
      </p>

      <div className="section">
        <h2 className="section-title">基本信息</h2>
        <div className="form">
          <div className="field">
            <label>世界名称</label>
            <input value={name} onChange={(event) => setName(event.target.value)} />
          </div>
          <div className="field">
            <label>简介</label>
            <textarea value={intro} onChange={(event) => setIntro(event.target.value)} />
          </div>
          <div className="field">
            <label>可见性</label>
            <select value={visibility} onChange={(event) => setVisibility(event.target.value as WorldVisibility)}>
              <option value="private">{VISIBILITY_LABELS.private}（仅成员可见）</option>
              <option value="public_read">{VISIBILITY_LABELS.public_read}（所有人可看）</option>
              <option value="public_edit">{VISIBILITY_LABELS.public_edit}（注册用户可参与编写）</option>
            </select>
          </div>
          <div className="field">
            <label>标签（最多 5 个）</label>
            <div className="tag-row" style={{ marginBottom: 0 }}>
              {allTags.map((tag) => (
                <button
                  key={tag}
                  type="button"
                  className={`tag-chip${selectedTags.includes(tag) ? " active" : ""}`}
                  onClick={() => toggleTag(tag)}
                >
                  {tag}
                </button>
              ))}
            </div>
          </div>
          <button type="button" className="btn" disabled={savingBasic} onClick={() => void handleSaveBasic()}>
            {savingBasic ? "保存中…" : "保存基本信息"}
          </button>
        </div>
      </div>

      <div className="section">
        <h2 className="section-title">分类管理</h2>
        <div className="create-entry-form">
          <input
            value={newCategoryName}
            onChange={(event) => setNewCategoryName(event.target.value)}
            placeholder="新分类名称"
          />
          <button type="button" className="btn small" onClick={() => void handleAddCategory()}>
            添加分类
          </button>
        </div>
        <div className="entry-list">
          {world.categories.map((category) => (
            <div key={category.id} className="entry-row">
              <input
                defaultValue={category.name}
                onBlur={(event) => void handleRenameCategory(category.id, event.target.value)}
                style={{ background: "var(--bg-soft)", border: "1px solid var(--border)", borderRadius: 4, color: "var(--text)", padding: "5px 10px", width: 200, fontFamily: "inherit" }}
              />
              <button
                type="button"
                className="btn ghost small"
                onClick={() => void handleDeleteCategory(category.id, category.name)}
              >
                删除
              </button>
            </div>
          ))}
        </div>
      </div>

      <div className="section">
        <h2 className="section-title">时间系统</h2>
        <div className="form" style={{ marginBottom: 18 }}>
          <div className="field">
            <label>时间粒度</label>
            <select value={granularity} onChange={(changeEvent) => setGranularity(changeEvent.target.value as "year" | "month" | "day")}>
              <option value="year">仅年份</option>
              <option value="month">精确到月</option>
              <option value="day">精确到日</option>
            </select>
          </div>
          <div className="field">
            <label>数字风格</label>
            <select value={numberStyle} onChange={(changeEvent) => setNumberStyle(changeEvent.target.value as "arabic" | "chinese")}>
              <option value="arabic">阿拉伯数字（402 年）</option>
              <option value="chinese">中文数字（四〇二年）</option>
            </select>
          </div>
          <button type="button" className="btn" onClick={() => void handleSaveTimeSettings()}>
            保存时间设置
          </button>
        </div>

        <h3 style={{ fontSize: 15, color: "var(--text-dim)", margin: "0 0 10px" }}>纪元列表（从早到晚）</h3>
        <div className="create-entry-form">
          <input
            value={newEraName}
            onChange={(changeEvent) => setNewEraName(changeEvent.target.value)}
            placeholder="新纪元名称，如「第三纪元」"
          />
          <button type="button" className="btn small" onClick={() => void handleAddEra()}>
            添加纪元
          </button>
        </div>
        {eras.length === 0 && <div className="empty">还没有纪元，添加后即可在时间线中编年</div>}
        <div className="entry-list">
          {eras.map((era) => (
            <div key={era.id} className="entry-row">
              <input
                defaultValue={era.name}
                onBlur={(changeEvent) => void handleRenameEra(era.id, changeEvent.target.value)}
                style={{ background: "var(--bg-soft)", border: "1px solid var(--border)", borderRadius: 4, color: "var(--text)", padding: "5px 10px", width: 200, fontFamily: "inherit" }}
              />
              <button type="button" className="btn ghost small" onClick={() => void handleDeleteEra(era.id, era.name)}>
                删除
              </button>
            </div>
          ))}
        </div>
      </div>

      <div className="section">
        <h2 className="section-title">成员管理（{members.length}）</h2>
        <table className="table">
          <thead>
            <tr>
              <th>成员</th>
              <th>角色</th>
              <th>加入方式</th>
              <th>加入时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {members.map((member) => (
              <tr key={member.userId}>
                <td>
                  {member.displayName}
                  <span style={{ color: "var(--text-faint)", marginLeft: 8, fontSize: 13 }}>@{member.username}</span>
                </td>
                <td>
                  {member.role === "owner" ? (
                    ROLE_LABELS.owner
                  ) : (
                    <select value={member.role} onChange={(event) => void handleChangeRole(member.userId, event.target.value)}>
                      <option value="editor">{ROLE_LABELS.editor}</option>
                      <option value="viewer">{ROLE_LABELS.viewer}</option>
                      {isOwner && <option value="admin">{ROLE_LABELS.admin}</option>}
                    </select>
                  )}
                </td>
                <td>{member.source === "invite" ? "邀请" : "开放参与"}</td>
                <td>{formatTime(member.joinedAt)}</td>
                <td>
                  {member.role !== "owner" && (
                    <>
                      <button type="button" className="btn ghost small" onClick={() => void handleRemoveMember(member, false)}>
                        移除
                      </button>
                      <button
                        type="button"
                        className="btn ghost small"
                        style={{ marginLeft: 6 }}
                        onClick={() => void handleRemoveMember(member, true)}
                      >
                        移除并拉黑
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="section">
        <h2 className="section-title">邀请成员</h2>
        <div className="invite-box">
          <select value={inviteRole} onChange={(event) => setInviteRole(event.target.value)}>
            <option value="editor">{ROLE_LABELS.editor}</option>
            <option value="viewer">{ROLE_LABELS.viewer}</option>
            <option value="admin">{ROLE_LABELS.admin}</option>
          </select>
          <button type="button" className="btn small" onClick={() => void handleCreateInvite()}>
            生成邀请码
          </button>
          {inviteCode && (
            <>
              <span className="code">{inviteCode}</span>
              <a href={registerLink} target="_blank" rel="noreferrer">
                注册链接
              </a>
            </>
          )}
        </div>
      </div>

      {bans.length > 0 && (
        <div className="section">
          <h2 className="section-title">黑名单（{bans.length}）</h2>
          <div className="entry-list">
            {bans.map((ban) => (
              <div key={ban.userId} className="entry-row">
                <span className="entry-row-title">
                  {ban.displayName}
                  <span style={{ color: "var(--text-faint)", marginLeft: 8, fontSize: 13 }}>@{ban.username}</span>
                </span>
                <button type="button" className="btn ghost small" onClick={() => void handleUnban(ban.userId)}>
                  解除拉黑
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {isOwner && (
        <div className="section danger-zone">
          <h2 className="section-title">危险操作</h2>
          <button type="button" className="btn danger" onClick={() => void handleDeleteWorld()}>
            删除世界
          </button>
          <p style={{ color: "var(--text-faint)", fontSize: 13 }}>删除后所有条目、历史与成员关系不可恢复。</p>
        </div>
      )}
    </>
  );
}
