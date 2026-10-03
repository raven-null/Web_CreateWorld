import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { ApiError, api } from "../lib/api";
import { EntryLinkMark } from "../lib/entry-link-mark";
import { showToast } from "../lib/toast";
import { countDocWords, extractEntryLinks, parseDoc, type TipTapDoc } from "../lib/tiptap-json";

/** 条目详情接口返回结构 */
interface EntryDetail {
  id: string;
  worldId: string;
  worldName: string;
  categoryName: string;
  title: string;
  version: number;
  wordCount: number;
  canEdit: boolean;
  protected: boolean;
  updatedAt: number;
  blocks: Array<{ id: string; contentJson: string }>;
}

/** 保存状态 */
type SaveStatus = "saved" | "dirty" | "saving" | "conflict" | "error";

/** 保存状态对应的中文文案 */
const STATUS_TEXT: Record<SaveStatus, string> = {
  saved: "已保存",
  dirty: "未保存",
  saving: "保存中…",
  conflict: "存在编辑冲突",
  error: "保存失败，将自动重试",
};

/** 自动保存防抖时间（停止输入后触发） */
const AUTOSAVE_DEBOUNCE_MS = 3000;

/** 自动保存兜底间隔（持续输入时最长 30 秒保存一次） */
const AUTOSAVE_MAX_INTERVAL_MS = 30_000;

/** 本地草稿写入节流时间 */
const DRAFT_WRITE_DEBOUNCE_MS = 800;

/** 空文档 */
const EMPTY_DOC: TipTapDoc = { type: "doc", content: [] };

/** 条目编辑页：TipTap 编辑器 + 自动保存 + 本地草稿 + 条目关联 + 冲突处理 */
export default function EntryEditPage() {
  const { worldId = "", entryId = "" } = useParams<{ worldId: string; entryId: string }>();
  const navigate = useNavigate();

  const [detail, setDetail] = useState<EntryDetail | null>(null);
  const [loadError, setLoadError] = useState("");
  const [title, setTitle] = useState("");
  const [status, setStatus] = useState<SaveStatus>("saved");
  const [wordCount, setWordCount] = useState(0);
  const [conflictVersion, setConflictVersion] = useState<number | null>(null);
  const [linkPanelOpen, setLinkPanelOpen] = useState(false);
  const [linkKeyword, setLinkKeyword] = useState("");
  const [linkCandidates, setLinkCandidates] = useState<Array<{ id: string; title: string }>>([]);

  // 用 ref 保存即时值，避免闭包拿到旧状态
  const versionRef = useRef(1);
  const titleRef = useRef("");
  const dirtyRef = useRef(false);
  const savingRef = useRef(false);
  const conflictRef = useRef(false);
  const saveTimerRef = useRef<number | null>(null);
  const draftTimerRef = useRef<number | null>(null);

  const draftKey = `entry-draft:${entryId}`;

  const editor = useEditor({
    extensions: [StarterKit.configure({ heading: { levels: [2, 3, 4] } }), EntryLinkMark],
    content: EMPTY_DOC,
  });

  /** 写入本地草稿（防抖；崩溃 / 误关时可恢复） */
  const scheduleDraftWrite = useCallback(() => {
    if (!editor) {
      return;
    }
    if (draftTimerRef.current !== null) {
      window.clearTimeout(draftTimerRef.current);
    }
    draftTimerRef.current = window.setTimeout(() => {
      const doc = editor.getJSON() as TipTapDoc;
      window.localStorage.setItem(
        draftKey,
        JSON.stringify({ savedAt: Date.now(), title: titleRef.current, contentJson: JSON.stringify(doc) }),
      );
    }, DRAFT_WRITE_DEBOUNCE_MS);
  }, [editor, draftKey]);

  /** 服务端保存：自动保存与手动保存共用 */
  const saveNow = useCallback(
    async (options: { createVersion?: boolean; note?: string } = {}) => {
      if (!editor || savingRef.current) {
        return;
      }
      savingRef.current = true;
      setStatus("saving");

      const doc = editor.getJSON() as TipTapDoc;
      try {
        const data = await api<{ version: number }>(`/api/entries/${entryId}/blocks`, {
          method: "PUT",
          body: {
            baseVersion: versionRef.current,
            title: titleRef.current,
            blocks: [{ contentJson: JSON.stringify(doc), wordCount: countDocWords(doc), title: "" }],
            links: extractEntryLinks(doc),
            createVersion: options.createVersion === true,
            note: options.note ?? "",
          },
        });
        versionRef.current = data.version;
        dirtyRef.current = false;
        conflictRef.current = false;
        setConflictVersion(null);
        setStatus("saved");
        window.localStorage.removeItem(draftKey);
        if (options.createVersion) {
          showToast("success", "已保存新版本");
        }
      } catch (error) {
        if (error instanceof ApiError && error.status === 409) {
          const latest = (error.data as { latestVersion?: number } | undefined)?.latestVersion ?? null;
          conflictRef.current = true;
          setConflictVersion(latest);
          setStatus("conflict");
        } else {
          setStatus("error");
          if (options.createVersion) {
            showToast("error", "保存失败，将自动重试");
          }
        }
      } finally {
        savingRef.current = false;
      }
    },
    [editor, entryId, draftKey],
  );

  /** 安排自动保存（停止输入 3 秒后触发） */
  const scheduleSave = useCallback(() => {
    if (conflictRef.current) {
      return;
    }
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
    }
    saveTimerRef.current = window.setTimeout(() => void saveNow(), AUTOSAVE_DEBOUNCE_MS);
  }, [saveNow]);

  /** 内容发生变更：更新状态并安排自动保存与本地草稿 */
  const markDirty = useCallback(() => {
    dirtyRef.current = true;
    setStatus((current) => (current === "conflict" ? current : "dirty"));
    scheduleDraftWrite();
    scheduleSave();
  }, [scheduleDraftWrite, scheduleSave]);

  // 订阅编辑器更新事件（同时刷新实时字数）
  useEffect(() => {
    if (!editor) {
      return;
    }
    const handler = () => {
      setWordCount(countDocWords(editor.getJSON() as TipTapDoc));
      markDirty();
    };
    editor.on("update", handler);
    return () => {
      editor.off("update", handler);
    };
  }, [editor, markDirty]);

  // 加载条目；如有更新的本地草稿则询问是否恢复
  useEffect(() => {
    if (!editor) {
      return;
    }
    let cancelled = false;
    api<EntryDetail>(`/api/entries/${entryId}`)
      .then((data) => {
        if (cancelled) {
          return;
        }
        setDetail(data);
        setTitle(data.title);
        titleRef.current = data.title;
        versionRef.current = data.version;
        setWordCount(data.wordCount);
        setLoadError("");

        const firstBlock = data.blocks[0];
        const serverDoc = firstBlock ? parseDoc(firstBlock.contentJson) : EMPTY_DOC;

        // 本地草稿比服务端新时，询问恢复
        const rawDraft = window.localStorage.getItem(`entry-draft:${entryId}`);
        if (rawDraft) {
          try {
            const draft = JSON.parse(rawDraft) as { savedAt: number; title: string; contentJson: string };
            if (draft.savedAt > data.updatedAt && window.confirm("检测到未保存的本地内容，是否恢复？")) {
              editor.commands.setContent(parseDoc(draft.contentJson));
              setTitle(draft.title);
              titleRef.current = draft.title;
              return;
            }
          } catch {
            window.localStorage.removeItem(`entry-draft:${entryId}`);
          }
        }
        editor.commands.setContent(serverDoc);
      })
      .catch((err: Error) => setLoadError(err.message));
    return () => {
      cancelled = true;
    };
  }, [entryId, editor]);

  // 持续编辑时的兜底保存：每 30 秒检查一次
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (dirtyRef.current && !savingRef.current && !conflictRef.current) {
        void saveNow();
      }
    }, AUTOSAVE_MAX_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [saveNow]);

  // 离开页面前提醒未保存内容
  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => {
      if (dirtyRef.current) {
        event.preventDefault();
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, []);

  /** 标题输入：同步 ref 并触发自动保存 */
  const handleTitleChange = (value: string) => {
    setTitle(value);
    titleRef.current = value;
    markDirty();
  };

  /** 打开关联条目面板并加载候选条目 */
  const openLinkPanel = async () => {
    if (!detail) {
      return;
    }
    if (editor?.state.selection.empty) {
      showToast("warning", "请先选中要关联的文字");
      return;
    }
    setLinkPanelOpen(true);
    try {
      const list = await api<Array<{ id: string; title: string }>>(`/api/worlds/${detail.worldId}/entries`);
      setLinkCandidates(list.filter((item) => item.id !== entryId));
    } catch {
      setLinkCandidates([]);
    }
  };

  /** 把当前选区关联到选中条目 */
  const applyEntryLink = (targetId: string) => {
    editor?.chain().focus().setEntryLink(targetId).run();
    setLinkPanelOpen(false);
    setLinkKeyword("");
  };

  /** 冲突处理：以本地修改为准，用最新版本号重试保存 */
  const handleKeepMine = async () => {
    if (conflictVersion !== null) {
      versionRef.current = conflictVersion;
    }
    conflictRef.current = false;
    await saveNow();
  };

  /** 冲突处理：放弃本地修改，加载服务器最新内容 */
  const handleTakeTheirs = async () => {
    const data = await api<EntryDetail>(`/api/entries/${entryId}`);
    setDetail(data);
    setTitle(data.title);
    titleRef.current = data.title;
    versionRef.current = data.version;
    const firstBlock = data.blocks[0];
    editor?.commands.setContent(firstBlock ? parseDoc(firstBlock.contentJson) : EMPTY_DOC);
    dirtyRef.current = false;
    conflictRef.current = false;
    setConflictVersion(null);
    setStatus("saved");
    window.localStorage.removeItem(draftKey);
    showToast("info", "已加载最新版本");
  };

  if (loadError) {
    return <div className="notice error">{loadError}</div>;
  }
  if (!detail) {
    return <div className="loading">加载中…</div>;
  }
  if (!detail.canEdit) {
    return <div className="notice error">你没有该条目的编辑权限（受保护条目仅管理员可编辑）</div>;
  }

  const filteredCandidates = linkCandidates.filter((item) =>
    item.title.toLowerCase().includes(linkKeyword.trim().toLowerCase()),
  );

  return (
    <div className="editor-page">
      <div className="editor-topbar">
        <input
          className="editor-title"
          value={title}
          onChange={(event) => handleTitleChange(event.target.value)}
          placeholder="条目标题"
        />
        <span className={`status-pill status-${status}`}>{STATUS_TEXT[status]}</span>
        <button
          type="button"
          className="btn small"
          onClick={() => void saveNow({ createVersion: true, note: "手动保存" })}
        >
          保存版本
        </button>
        <button type="button" className="btn ghost small" onClick={() => navigate(`/w/${worldId}/entries/${entryId}`)}>
          完成
        </button>
      </div>

      {status === "conflict" && (
        <div className="notice error">
          该条目已被他人修改。你可以保留自己的修改覆盖，或加载对方的最新版本。
          <button type="button" className="btn small" style={{ marginLeft: 12 }} onClick={() => void handleKeepMine()}>
            保留我的修改
          </button>
          <button
            type="button"
            className="btn ghost small"
            style={{ marginLeft: 8 }}
            onClick={() => void handleTakeTheirs()}
          >
            加载最新版本
          </button>
        </div>
      )}

      <div className="editor-toolbar">
        <button
          type="button"
          className={editor?.isActive("bold") ? "active" : ""}
          onClick={() => editor?.chain().focus().toggleBold().run()}
        >
          B
        </button>
        <button
          type="button"
          className={editor?.isActive("italic") ? "active" : ""}
          onClick={() => editor?.chain().focus().toggleItalic().run()}
          style={{ fontStyle: "italic" }}
        >
          I
        </button>
        <button
          type="button"
          className={editor?.isActive("heading", { level: 2 }) ? "active" : ""}
          onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()}
        >
          H2
        </button>
        <button
          type="button"
          className={editor?.isActive("heading", { level: 3 }) ? "active" : ""}
          onClick={() => editor?.chain().focus().toggleHeading({ level: 3 }).run()}
        >
          H3
        </button>
        <button
          type="button"
          className={editor?.isActive("bulletList") ? "active" : ""}
          onClick={() => editor?.chain().focus().toggleBulletList().run()}
        >
          • 列表
        </button>
        <button
          type="button"
          className={editor?.isActive("orderedList") ? "active" : ""}
          onClick={() => editor?.chain().focus().toggleOrderedList().run()}
        >
          1. 列表
        </button>
        <button
          type="button"
          className={editor?.isActive("blockquote") ? "active" : ""}
          onClick={() => editor?.chain().focus().toggleBlockquote().run()}
        >
          引用
        </button>
        <span className="toolbar-divider" />
        <button type="button" onClick={() => void openLinkPanel()}>
          关联条目
        </button>
        <button type="button" onClick={() => editor?.chain().focus().unsetEntryLink().run()}>
          取消关联
        </button>
        <span className="toolbar-divider" />
        <button type="button" onClick={() => editor?.chain().focus().undo().run()}>
          撤销
        </button>
        <button type="button" onClick={() => editor?.chain().focus().redo().run()}>
          重做
        </button>
      </div>

      {linkPanelOpen && (
        <div className="link-panel">
          <div className="link-panel-head">
            <input
              value={linkKeyword}
              onChange={(event) => setLinkKeyword(event.target.value)}
              placeholder="搜索要关联的条目…"
              autoFocus
            />
            <button type="button" className="btn ghost small" onClick={() => setLinkPanelOpen(false)}>
              关闭
            </button>
          </div>
          <div className="link-panel-list">
            {filteredCandidates.length === 0 && <div className="empty">没有匹配的条目</div>}
            {filteredCandidates.slice(0, 20).map((item) => (
              <button key={item.id} type="button" className="link-panel-item" onClick={() => applyEntryLink(item.id)}>
                {item.title}
              </button>
            ))}
          </div>
        </div>
      )}

      <EditorContent editor={editor} className="editor-content" />

      <div className="editor-footer">
        <span>
          字数 {wordCount} · 当前版本 v{versionRef.current}
        </span>
        <Link to={`/w/${worldId}/entries/${entryId}/versions`}>历史版本</Link>
      </div>
    </div>
  );
}
