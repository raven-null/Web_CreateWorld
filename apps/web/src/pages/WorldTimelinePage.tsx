import { useEffect, useState, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import type { TimeGranularity, TimeNumberStyle } from "@create-world/core";
import { api } from "../lib/api";
import { formatEventTime } from "../lib/format";
import { showToast } from "../lib/toast";

/** 纪元 */
interface EraItem {
  id: string;
  name: string;
  sortOrder: number;
}

/** 事件 */
interface EventItem {
  id: string;
  title: string;
  description: string;
  eraId: string | null;
  year: number | null;
  month: number | null;
  day: number | null;
  season: string;
  timeUndetermined: boolean;
  entryId: string | null;
  createdAt: number;
}

/** 时间线接口返回结构 */
interface TimelineData {
  eras: EraItem[];
  events: EventItem[];
  timeConfig: { granularity: TimeGranularity; numberStyle: TimeNumberStyle };
  canEdit: boolean;
}

/** 条目下拉选项 */
interface EntryOption {
  id: string;
  title: string;
}

/** 事件表单状态 */
interface EventForm {
  title: string;
  eraId: string;
  year: string;
  month: string;
  day: string;
  season: string;
  timeUndetermined: boolean;
  description: string;
  entryId: string;
}

/** 空表单 */
const EMPTY_FORM: EventForm = {
  title: "",
  eraId: "",
  year: "",
  month: "",
  day: "",
  season: "",
  timeUndetermined: false,
  description: "",
  entryId: "",
};

/**
 * 事件排序：年 → 月 → 日升序，同时间按创建时间稳定排序。
 */
function compareEvents(a: EventItem, b: EventItem): number {
  return (
    (a.year ?? 0) - (b.year ?? 0) ||
    (a.month ?? 0) - (b.month ?? 0) ||
    (a.day ?? 0) - (b.day ?? 0) ||
    a.createdAt - b.createdAt
  );
}

/**
 * 时间线页：按纪元分段展示事件，支持新建 / 编辑 / 删除与条目关联。
 */
export default function WorldTimelinePage() {
  const { worldId = "" } = useParams<{ worldId: string }>();
  const [data, setData] = useState<TimelineData | null>(null);
  const [entries, setEntries] = useState<EntryOption[]>([]);
  const [error, setError] = useState("");

  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<EventForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  /** 加载时间线数据 */
  const load = async () => {
    const timeline = await api<TimelineData>(`/api/worlds/${worldId}/timeline`);
    setData(timeline);
  };

  useEffect(() => {
    load().catch((err: Error) => setError(err.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [worldId]);

  /** 确保条目选项已加载（事件可关联条目） */
  const ensureEntries = async () => {
    if (entries.length > 0) {
      return;
    }
    try {
      setEntries(await api<EntryOption[]>(`/api/worlds/${worldId}/entries`));
    } catch {
      setEntries([]);
    }
  };

  /** 打开新建事件弹层 */
  const openCreate = async () => {
    await ensureEntries();
    setEditingId(null);
    setForm({ ...EMPTY_FORM, eraId: data?.eras[0]?.id ?? "" });
    setModalOpen(true);
  };

  /** 打开编辑事件弹层 */
  const openEdit = async (event: EventItem) => {
    await ensureEntries();
    setEditingId(event.id);
    setForm({
      title: event.title,
      eraId: event.eraId ?? "",
      year: event.year === null ? "" : String(event.year),
      month: event.month === null ? "" : String(event.month),
      day: event.day === null ? "" : String(event.day),
      season: event.season,
      timeUndetermined: event.timeUndetermined,
      description: event.description,
      entryId: event.entryId ?? "",
    });
    setModalOpen(true);
  };

  /** 提交事件表单（按编辑状态走更新或创建） */
  const handleSubmit = async (submitEvent: FormEvent) => {
    submitEvent.preventDefault();
    setSaving(true);
    try {
      const payload = {
        title: form.title.trim(),
        description: form.description,
        eraId: form.timeUndetermined ? null : form.eraId,
        year: form.year ? Number(form.year) : null,
        month: form.month ? Number(form.month) : null,
        day: form.day ? Number(form.day) : null,
        season: form.season,
        timeUndetermined: form.timeUndetermined,
        entryId: form.entryId || null,
      };
      if (editingId) {
        await api(`/api/events/${editingId}`, { method: "PATCH", body: payload });
      } else {
        await api(`/api/worlds/${worldId}/events`, { method: "POST", body: payload });
      }
      showToast("success", editingId ? "事件已更新" : "事件已创建");
      setModalOpen(false);
      await load();
    } catch (err) {
      showToast("error", (err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  /** 删除事件 */
  const handleDelete = async (event: EventItem) => {
    if (!window.confirm(`确定删除事件「${event.title}」？`)) {
      return;
    }
    try {
      await api(`/api/events/${event.id}`, { method: "DELETE" });
      showToast("success", "事件已删除");
      await load();
    } catch (err) {
      showToast("error", (err as Error).message);
    }
  };

  /** 条目 id → 标题 */
  const entryTitle = (entryId: string): string =>
    entries.find((entry) => entry.id === entryId)?.title ?? "关联条目";

  if (error) {
    return <div className="notice error">{error}</div>;
  }
  if (!data) {
    return <div className="loading">加载中…</div>;
  }

  const undetermined = data.events.filter((event) => event.timeUndetermined);
  const granularity = data.timeConfig.granularity;
  const numberStyle = data.timeConfig.numberStyle;

  /** 渲染单个事件卡片 */
  const renderEventCard = (event: EventItem, eraName: string | null) => (
    <div className="timeline-card" key={event.id}>
      <div className="timeline-card-time">
        {formatEventTime({
          eraName,
          year: event.year,
          month: event.month,
          day: event.day,
          season: event.season,
          timeUndetermined: event.timeUndetermined,
          granularity,
          numberStyle,
        })}
      </div>
      <div className="timeline-card-title">{event.title}</div>
      {event.description && <p className="timeline-card-desc">{event.description}</p>}
      <div className="timeline-card-meta">
        {event.entryId && (
          <Link to={`/w/${worldId}/entries/${event.entryId}`}>关联条目：{entryTitle(event.entryId)}</Link>
        )}
        {data.canEdit && (
          <span className="timeline-card-actions">
            <button type="button" className="btn ghost small" onClick={() => void openEdit(event)}>
              编辑
            </button>
            <button type="button" className="btn ghost small" onClick={() => void handleDelete(event)}>
              删除
            </button>
          </span>
        )}
      </div>
    </div>
  );

  return (
    <>
      <div className="entry-view-head">
        <div>
          <h1 className="page-title" style={{ marginBottom: 4 }}>
            时间线
          </h1>
          <p className="page-subtitle" style={{ marginBottom: 0 }}>
            {data.eras.length === 0
              ? "还没有纪元，请先在世界设置里添加"
              : `共 ${data.events.length} 个事件`}
          </p>
        </div>
        {data.canEdit && (
          <button type="button" className="btn" onClick={() => void openCreate()}>
            新建事件
          </button>
        )}
      </div>

      {data.eras.length === 0 && (
        <div className="notice">
          时间线需要先定义纪元。前往 <Link to={`/w/${worldId}/settings`}>世界设置 → 时间系统</Link> 添加。
        </div>
      )}

      {data.eras.map((era) => {
        const eraEvents = data.events
          .filter((event) => !event.timeUndetermined && event.eraId === era.id)
          .sort(compareEvents);
        return (
          <section className="timeline-era" key={era.id}>
            <h2 className="timeline-era-title">{era.name}</h2>
            <div className="timeline-track">
              {eraEvents.length === 0 && <div className="timeline-empty">暂无事件</div>}
              {eraEvents.map((event) => renderEventCard(event, era.name))}
            </div>
          </section>
        );
      })}

      {undetermined.length > 0 && (
        <section className="timeline-era">
          <h2 className="timeline-era-title">时间未定</h2>
          <div className="timeline-track">
            {undetermined.map((event) => renderEventCard(event, null))}
          </div>
        </section>
      )}

      {modalOpen && (
        <div className="modal-overlay" onClick={() => setModalOpen(false)}>
          <div className="modal" onClick={(clickEvent) => clickEvent.stopPropagation()}>
            <h2 className="section-title">{editingId ? "编辑事件" : "新建事件"}</h2>
            <form className="form" style={{ maxWidth: "none" }} onSubmit={handleSubmit}>
              <div className="field">
                <label htmlFor="eventTitle">标题</label>
                <input
                  id="eventTitle"
                  value={form.title}
                  onChange={(changeEvent) => setForm({ ...form, title: changeEvent.target.value })}
                  required
                />
              </div>

              <label className="graph-toggle" style={{ marginBottom: 4 }}>
                <input
                  type="checkbox"
                  checked={form.timeUndetermined}
                  onChange={(changeEvent) => setForm({ ...form, timeUndetermined: changeEvent.target.checked })}
                />
                时间未定
              </label>

              {!form.timeUndetermined && (
                <>
                  <div className="field">
                    <label htmlFor="eventEra">纪元</label>
                    <select
                      id="eventEra"
                      value={form.eraId}
                      onChange={(changeEvent) => setForm({ ...form, eraId: changeEvent.target.value })}
                      required
                    >
                      <option value="">请选择</option>
                      {data.eras.map((era) => (
                        <option key={era.id} value={era.id}>
                          {era.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="form-row">
                    <div className="field">
                      <label htmlFor="eventYear">年份</label>
                      <input
                        id="eventYear"
                        type="number"
                        value={form.year}
                        onChange={(changeEvent) => setForm({ ...form, year: changeEvent.target.value })}
                        required
                      />
                    </div>
                    {granularity !== "year" && (
                      <div className="field">
                        <label htmlFor="eventMonth">月份</label>
                        <input
                          id="eventMonth"
                          type="number"
                          min={1}
                          max={12}
                          value={form.month}
                          onChange={(changeEvent) => setForm({ ...form, month: changeEvent.target.value })}
                        />
                      </div>
                    )}
                    {granularity === "day" && (
                      <div className="field">
                        <label htmlFor="eventDay">日期</label>
                        <input
                          id="eventDay"
                          type="number"
                          min={1}
                          max={31}
                          value={form.day}
                          onChange={(changeEvent) => setForm({ ...form, day: changeEvent.target.value })}
                        />
                      </div>
                    )}
                  </div>
                  <div className="field">
                    <label htmlFor="eventSeason">季节 / 季度（可选）</label>
                    <input
                      id="eventSeason"
                      value={form.season}
                      onChange={(changeEvent) => setForm({ ...form, season: changeEvent.target.value })}
                      placeholder="如：春、盛夏、秋收季"
                    />
                  </div>
                </>
              )}

              <div className="field">
                <label htmlFor="eventDescription">描述（可选）</label>
                <textarea
                  id="eventDescription"
                  value={form.description}
                  onChange={(changeEvent) => setForm({ ...form, description: changeEvent.target.value })}
                />
              </div>

              <div className="field">
                <label htmlFor="eventEntry">关联条目（可选）</label>
                <select
                  id="eventEntry"
                  value={form.entryId}
                  onChange={(changeEvent) => setForm({ ...form, entryId: changeEvent.target.value })}
                >
                  <option value="">不关联</option>
                  {entries.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.title}
                    </option>
                  ))}
                </select>
              </div>

              <div style={{ display: "flex", gap: 10 }}>
                <button type="submit" className="btn" disabled={saving}>
                  {saving ? "保存中…" : "保存"}
                </button>
                <button type="button" className="btn ghost" onClick={() => setModalOpen(false)}>
                  取消
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {data.events.length === 0 && data.eras.length > 0 && (
        <div className="empty">还没有事件，点右上角「新建事件」开始编年</div>
      )}
    </>
  );
}
