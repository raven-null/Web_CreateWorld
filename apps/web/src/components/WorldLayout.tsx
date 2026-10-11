import { useEffect, useState } from "react";
import { Link, NavLink, Outlet, useParams } from "react-router-dom";
import { VISIBILITY_LABELS, type MemberRole, type WorldVisibility } from "@create-world/core";
import { api } from "../lib/api";

/** 世界基本信息（侧边栏用） */
interface WorldBrief {
  id: string;
  name: string;
  visibility: WorldVisibility;
  myRole: MemberRole | null;
}

/**
 * 世界区布局：左侧导航边栏 + 内容区。
 * 覆盖世界主页、条目、关系图、时间线、地图、搜索、设置；条目编辑页独立全宽（不套此布局）。
 */
export default function WorldLayout() {
  const { worldId = "" } = useParams<{ worldId: string }>();
  const [world, setWorld] = useState<WorldBrief | null>(null);
  const [error, setError] = useState("");

  // 加载世界基本信息（名称与角色，决定侧边栏内容）
  useEffect(() => {
    api<WorldBrief>(`/api/worlds/${worldId}`)
      .then((data) => {
        setWorld(data);
        setError("");
      })
      .catch((err: Error) => setError(err.message));
  }, [worldId]);

  const isWorldAdmin = world?.myRole === "owner" || world?.myRole === "admin";

  if (error) {
    return <div className="notice error">{error}</div>;
  }

  return (
    <div className="world-layout">
      <aside className="world-sidebar">
        <Link to="/worlds" className="world-sidebar-back">
          ← 我的世界
        </Link>
        <h2 className="world-sidebar-name">{world?.name ?? "…"}</h2>
        {world && <span className="badge">{VISIBILITY_LABELS[world.visibility]}</span>}

        <nav className="world-sidebar-nav">
          <NavLink to={`/w/${worldId}/canvas`}>画布</NavLink>
          <NavLink to={`/w/${worldId}/timeline`}>时间线</NavLink>
          <NavLink to={`/w/${worldId}/maps`}>地图</NavLink>
          <NavLink to={`/w/${worldId}/search`}>全文搜索</NavLink>
          {isWorldAdmin && <NavLink to={`/w/${worldId}/settings`}>世界设置</NavLink>}
        </nav>
      </aside>
      <div className="world-content">
        <Outlet />
      </div>
    </div>
  );
}
