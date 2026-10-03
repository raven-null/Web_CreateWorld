import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../lib/api";
import { formatTime } from "../lib/format";

/** 搜索结果项 */
interface SearchResult {
  id: string;
  title: string;
  categoryId: string;
  updatedAt: number;
  snippet: string;
  matchedIn: "title" | "content";
}

/** 世界信息（用于分类筛选项） */
interface WorldInfo {
  name: string;
  categories: Array<{ id: string; name: string }>;
}

/**
 * 把命中词高亮为 <mark> 片段。
 * @param text 原文
 * @param keyword 关键词
 * @returns React 节点数组
 */
function highlight(text: string, keyword: string): ReactNode[] {
  if (!keyword) {
    return [text];
  }
  const lowerText = text.toLowerCase();
  const lowerKeyword = keyword.toLowerCase();
  const parts: ReactNode[] = [];
  let cursor = 0;
  let index = lowerText.indexOf(lowerKeyword);
  let key = 0;

  while (index >= 0) {
    parts.push(text.slice(cursor, index));
    parts.push(<mark key={key++}>{text.slice(index, index + keyword.length)}</mark>);
    cursor = index + keyword.length;
    index = lowerText.indexOf(lowerKeyword, cursor);
  }
  parts.push(text.slice(cursor));
  return parts;
}

/**
 * 全文搜索页：搜索条目标题与正文，支持分类筛选。
 */
export default function SearchPage() {
  const { worldId = "" } = useParams<{ worldId: string }>();
  const [keyword, setKeyword] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [world, setWorld] = useState<WorldInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // 分类筛选项
  useEffect(() => {
    api<WorldInfo>(`/api/worlds/${worldId}`)
      .then(setWorld)
      .catch(() => setWorld(null));
  }, [worldId]);

  /** 执行搜索 */
  const runSearch = async (submitEvent: FormEvent) => {
    submitEvent.preventDefault();
    const query = keyword.trim();
    if (!query) {
      return;
    }
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({ q: query });
      if (categoryId) {
        params.set("categoryId", categoryId);
      }
      setResults(await api<SearchResult[]>(`/api/worlds/${worldId}/search?${params.toString()}`));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const categoryName = (id: string): string =>
    world?.categories.find((category) => category.id === id)?.name ?? "";

  return (
    <>
      <h1 className="page-title">全文搜索</h1>
      <p className="page-subtitle">{world ? world.name : ""}</p>

      <form className="search-form" onSubmit={runSearch}>
        <input
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
          placeholder="搜索条目名称或正文内容…"
          autoFocus
        />
        <select value={categoryId} onChange={(event) => setCategoryId(event.target.value)}>
          <option value="">全部分类</option>
          {(world?.categories ?? []).map((category) => (
            <option key={category.id} value={category.id}>
              {category.name}
            </option>
          ))}
        </select>
        <button type="submit" className="btn" disabled={loading}>
          {loading ? "搜索中…" : "搜索"}
        </button>
      </form>

      {error && <div className="notice error">{error}</div>}
      {results === null && !loading && <div className="empty">输入关键词开始搜索</div>}
      {results !== null && results.length === 0 && <div className="empty">没有找到匹配的条目</div>}

      <div className="search-results">
        {(results ?? []).map((result) => (
          <Link key={result.id} to={`/w/${worldId}/entries/${result.id}`} className="search-result">
            <div className="search-result-head">
              <span className="entry-row-title">{highlight(result.title, keyword.trim())}</span>
              <span className="search-cat">{categoryName(result.categoryId)}</span>
              <span className="entry-row-meta">{formatTime(result.updatedAt)}</span>
            </div>
            <div className="search-snippet">
              {result.matchedIn === "content" ? highlight(result.snippet, keyword.trim()) : "标题命中"}
            </div>
          </Link>
        ))}
      </div>
    </>
  );
}
