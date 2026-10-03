import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { VISIBILITY_LABELS, type WorldVisibility } from "@create-world/core";
import { api } from "../lib/api";

/**
 * 创建新世界：名称 / 简介 / 可见性 / 标签（最多 5 个）。
 * 创建成功后跳转到世界主页。
 */
export default function NewWorldPage() {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [intro, setIntro] = useState("");
  const [visibility, setVisibility] = useState<WorldVisibility>("private");
  const [tags, setTags] = useState<string[]>([]);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // 可选标签来自平台标签库
  useEffect(() => {
    api<string[]>("/api/discover/tags")
      .then(setTags)
      .catch(() => setTags([]));
  }, []);

  /** 点选 / 取消标签，最多选 5 个 */
  const toggleTag = (tag: string) => {
    setSelectedTags((current) => {
      if (current.includes(tag)) {
        return current.filter((item) => item !== tag);
      }
      return current.length >= 5 ? current : [...current, tag];
    });
  };

  /** 提交创建，成功后进入新世界主页 */
  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      const data = await api<{ id: string }>("/api/worlds", {
        method: "POST",
        body: { name: name.trim(), intro: intro.trim(), visibility, tags: selectedTags },
      });
      navigate(`/w/${data.id}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <h1 className="page-title">创建新世界</h1>
      <p className="page-subtitle">系统会自动生成人物 / 地点 / 势力 / 物品 / 事件分类</p>

      <form className="form" onSubmit={handleSubmit}>
        <div className="field">
          <label htmlFor="name">世界名称</label>
          <input id="name" value={name} onChange={(event) => setName(event.target.value)} required />
        </div>
        <div className="field">
          <label htmlFor="intro">简介</label>
          <textarea id="intro" value={intro} onChange={(event) => setIntro(event.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="visibility">可见性</label>
          <select
            id="visibility"
            value={visibility}
            onChange={(event) => setVisibility(event.target.value as WorldVisibility)}
          >
            <option value="private">{VISIBILITY_LABELS.private}（仅成员可见）</option>
            <option value="public_read">{VISIBILITY_LABELS.public_read}（所有人可看）</option>
            <option value="public_edit">{VISIBILITY_LABELS.public_edit}（注册用户可参与编写）</option>
          </select>
        </div>
        <div className="field">
          <label>标签（最多 5 个，用于发现页筛选）</label>
          <div className="tag-row" style={{ marginBottom: 0 }}>
            {tags.map((tag) => (
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
        {error && <div className="notice error">{error}</div>}
        <button type="submit" className="btn" disabled={submitting}>
          {submitting ? "创建中…" : "创建世界"}
        </button>
      </form>
    </>
  );
}
