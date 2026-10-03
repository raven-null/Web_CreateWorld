import { Link, NavLink, Outlet, useNavigate } from "react-router-dom";
import { authClient } from "../lib/auth-client";
import { readUserRole } from "../lib/format";

/**
 * 全站布局：顶部导航 + 页面内容。
 * 导航显示登录状态；站点管理员额外显示「管理后台」入口。
 */
export default function Layout() {
  const navigate = useNavigate();
  const { data: session } = authClient.useSession();
  const user = session?.user ?? null;
  const isAdmin = readUserRole(user) === "admin";

  /** 退出登录并回到首页 */
  const handleSignOut = async () => {
    await authClient.signOut();
    navigate("/");
  };

  return (
    <>
      <header className="site-header">
        <Link to="/" className="site-logo">
          创世
        </Link>
        <nav className="site-nav">
          <NavLink to="/" end>
            发现
          </NavLink>
          {user && <NavLink to="/worlds">我的世界</NavLink>}
          {isAdmin && <NavLink to="/admin">管理后台</NavLink>}
        </nav>
        <div className="site-user">
          {user ? (
            <>
              <span>{user.name}</span>
              <button type="button" className="btn ghost small" onClick={handleSignOut}>
                退出
              </button>
            </>
          ) : (
            <>
              <Link to="/login">登录</Link>
              <Link to="/register">注册</Link>
            </>
          )}
        </div>
      </header>
      <main className="page">
        <Outlet />
      </main>
    </>
  );
}
