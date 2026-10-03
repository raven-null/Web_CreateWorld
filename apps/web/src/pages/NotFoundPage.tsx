import { Link } from "react-router-dom";

/** 404 页面 */
export default function NotFoundPage() {
  return (
    <>
      <h1 className="page-title">页面不存在</h1>
      <div className="notice">
        找不到该页面，回到 <Link to="/">发现首页</Link>
      </div>
    </>
  );
}
