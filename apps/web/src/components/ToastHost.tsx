import { useEffect, useState } from "react";
import { dismissToast, subscribeToasts, type ToastItem } from "../lib/toast";

/**
 * 轻提示容器：固定在右上角展示，点击可提前关闭。
 * 挂载在全局布局中，通过 showToast() 触发。
 */
export default function ToastHost() {
  const [items, setItems] = useState<ToastItem[]>([]);

  useEffect(() => subscribeToasts(setItems), []);

  if (items.length === 0) {
    return null;
  }

  return (
    <div className="toast-host">
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          className={`toast toast-${item.type}`}
          onClick={() => dismissToast(item.id)}
        >
          {item.message}
        </button>
      ))}
    </div>
  );
}
