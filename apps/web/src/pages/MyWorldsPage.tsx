import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ROLE_LABELS, VISIBILITY_LABELS, type MemberRole, type WorldSummary } from "@create-world/core";
import { api } from "../lib/api";
import { authClient } from "../lib/auth-client";
import { formatTime } from "../lib/format";

/**
 * 我的世界：我创建 / 参与的世界列表。
 * 未登录时提示登录。
 */
export default function MyWorldsPage() {
  const { data: session, isPending } = authClient.useSession();
  const [worlds, setWorlds] = useState<WorldSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // 登录后加载「我的世界」
  useEffect(() => {
    if (!session) {
      setLoading(false);
      return;
    }
    api<WorldSummary[]>("/api/worlds/mine")
      .then((data) => {
        setWorlds(data);
        setError("");
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, [session]);

  if (isPending) {
    return <div className="loading">加载中…</div>;
  }
  if (!session) {
    return (
      <>
        <h1 className="page-title">我的世界</h1>
        <div className="notice">
          请先 <Link to="/login">登录</Link>，或 <Link to="/register">用邀请码注册</Link>
        </div>
      </>
    );
  }

  return (
    <>
      <h1 className="page-title">我的世界</h1>
      <p className="page-subtitle">我创建与参与的世界</p>

      <div style={{ marginBottom: 20 }}>
        <Link to="/worlds/new" className="btn">
          创建新世界
        </Link>
      </div>

      {error && <div className="notice error">{error}</div>}
      {loading && <div className="loading">加载中…</div>}
      {!loading && worlds.length === 0 && (
        <div className="empty">
          还没有世界，点击上方「创建新世界」开始
        </div>
      )}

      <div className="card-grid">
        {worlds.map((world) => (
          <Link key={world.id} to={`/w/${world.id}`} className="card">
            <h2 className="card-title">
              {world.name}
              {world.role && <span className="badge">{ROLE_LABELS[world.role as MemberRole]}</span>}
            </h2>
            <p className="card-intro">{world.intro || "（暂无简介）"}</p>
            <div className="card-meta">
              <span>{VISIBILITY_LABELS[world.visibility]}</span>
              <span>条目 {world.entryCount}</span>
              <span>成员 {world.memberCount}</span>
              <span>更新于 {formatTime(world.updatedAt)}</span>
            </div>
          </Link>
        ))}
      </div>
    </>
  );
}
