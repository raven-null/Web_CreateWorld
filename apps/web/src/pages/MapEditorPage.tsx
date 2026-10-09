import { useMemo } from "react";
import { useParams } from "react-router-dom";
import { MapEditor } from "@worldmap/editor";
import { createHttpMapHostAdapter } from "@worldmap/editor-web";

/**
 * 地图编辑器页面（主站侧的**装配层**）。
 *
 * 这里刻意保持极薄：只做三件事——取路由参数、构造宿主适配器、把适配器注入插件。
 * 所有编辑逻辑都在 `@worldmap/editor` 里，主站不认识它内部任何实现细节
 * （方案 §16 的插件化验收要求本文件不超过 50 行）。
 */
export default function MapEditorPage() {
  const { mapId = "" } = useParams<{ mapId: string }>();

  // 适配器只依赖 mapId，因此在 mapId 不变时保持同一实例
  const adapter = useMemo(() => createHttpMapHostAdapter(), []);

  return (
    <div className="page">
      <div className="entry-view-head">
        <div>
          <h1 className="page-title" style={{ marginBottom: 4 }}>
            地图编辑器
          </h1>
          <p className="page-subtitle" style={{ marginBottom: 0 }}>
            球面白板 · 滚轮缩放 · 拖拽平移
          </p>
        </div>
        <div className="entry-view-actions">
          <button type="button" className="btn ghost small" onClick={() => window.history.back()}>
            返回
          </button>
        </div>
      </div>

      <MapEditor
        mapId={mapId}
        adapter={adapter}
        readOnly
        onError={(error) => console.error("[map-editor]", error.message)}
      />
    </div>
  );
}
