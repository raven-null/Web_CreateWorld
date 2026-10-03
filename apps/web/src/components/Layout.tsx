import { useState } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { authClient } from "../lib/auth-client";
import { readUserRole } from "../lib/format";
import ToastHost from "./ToastHost";

/**
 * 全站布局：顶部导航 + 页面内容。
 * 桌面显示横向导航；移动端收纳为汉堡菜单。
 * 世界区（/w/*）使用宽版容器（侧边栏贴边），其余页面居中限宽。
 */
export default function Layout() {
  const navigate = useNavigate();
  const location = useLocation();
  const { data: session } = authClient.useSession();
  const user = session?.user ?? null;
  const isAdmin = readUserRole(user) === "admin";
  const [menuOpen, setMenuOpen] = useState(false);

  // 世界区页面去掉居中限宽，让侧边栏贴住屏幕左缘
  const isWorldRoute = location.pathname.startsWith("/w/");

  /** 关闭移动端菜单（点击任意导航项后） */
  const closeMenu = () => setMenuOpen(false);

  /** 退出登录并回到首页 */
  const handleSignOut = async () => {
    closeMenu();
    await authClient.signOut();
    navigate("/");
  };

  return (
    <>
      <header className="site-header">
        <Link to="/" className="site-logo" onClick={closeMenu}>
          创世
        </Link>
        <nav className={`site-nav${menuOpen ? " open" : ""}`}>
          <NavLink to="/" end onClick={closeMenu}>
            发现
          </NavLink>
          {user && (
            <NavLink to="/worlds" onClick={closeMenu}>
              我的世界
            </NavLink>
          )}
          {user && (
            <NavLink to="/drafts" onClick={closeMenu}>
              草稿箱
            </NavLink>
          )}
          {isAdmin && (
            <NavLink to="/admin" onClick={closeMenu}>
              管理后台
            </NavLink>
          )}
        </nav>
        <div className="site-user">
          {user ? (
            <>
              <span>{user.name}</span>
              <Link to="/settings" onClick={closeMenu}>
                设置
              </Link>
              <button type="button" className="btn ghost small" onClick={handleSignOut}>
                退出
              </button>
            </>
          ) : (
            <>
              <Link to="/login" onClick={closeMenu}>
                登录
              </Link>
              <Link to="/register" onClick={closeMenu}>
                注册
              </Link>
            </>
          )}
        </div>
        <button
          type="button"
          className="nav-toggle"
          aria-label="菜单"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((value) => !value)}
        >
          {menuOpen ? "✕" : "☰"}
        </button>
      </header>
      <main className={`page${isWorldRoute ? " page-wide" : ""}`}>
        <Outlet />
      </main>
      <ToastHost />
    </>
  );
}
