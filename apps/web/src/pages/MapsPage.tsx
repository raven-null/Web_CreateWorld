import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { MapEditor } from "@worldmap/editor";
import { createHttpMapHostAdapter, createIndexedDbDraftStore } from "@worldmap/editor-web";
import parchmentUrl from "../../../../packages/map-editor/assets/terrain/paper/parchment.jpg";
import { api } from "../lib/api";
import { uploadImage } from "../lib/image-upload";
import { showToast } from "../lib/toast";

/** 地图列表项 */
interface MapListItem {
  id: string;
  name: string;
  /** image = 图片底图（旧数据，暂用简化查看器）；canvas = 球面白板（编辑器） */
  kind: string;
  imageUrl: string;
  markerCount: number;
  createdAt: number;
}

/** 世界信息（页面标题用） */
interface WorldInfo {
  name: string;
}

/** 白板宽度的合法范围与规整粒度（与服务端 canvas 接口一致） */
const BOARD_MIN_WIDTH = 512;
const BOARD_MAX_WIDTH = 16384;
const BOARD_WIDTH_STEP = 128;
/** 白板默认宽度（方案 §5.1 已定案：2048×1024） */
const DEFAULT_BOARD_WIDTH = 2048;

/**
 * 把用户输入的宽度规整为合法值：向上取整到 128 的倍数并夹在允许范围内。
 * 服务端也会做一次同样的规整，这里提前对齐，避免用户看到数字跳变。
 * @param raw 用户输入
 * @returns 规整后的宽度
 */
function normalizeBoardWidth(raw: number): number {
  const stepped = Math.ceil((Number.isFinite(raw) ? raw : DEFAULT_BOARD_WIDTH) / BOARD_WIDTH_STEP) * BOARD_WIDTH_STEP;
  return Math.min(Math.max(stepped, BOARD_MIN_WIDTH), BOARD_MAX_WIDTH);
}

/**
 * 地图页 = 地图编辑器。
 *
 * 页面结构：地图标签（切换 / 新建）→ 编辑器本体。
 * - 画布型地图（`kind = canvas`）：完整编辑器（笔刷绘制、图层、测量、标记、导出）
 * - 图片型地图（`kind = image`，旧数据）：暂用简化查看器展示原图与标记，绘制能力只对画布型开放
 *
 * 页面保持"薄"：真正的编辑逻辑全在 `@worldmap/editor` 里，这里只做
 * 「取数据 → 构造宿主适配器 → 注入插件」以及新建地图的表单。
 */
export default function MapsPage() {
  const { worldId = "" } = useParams<{ worldId: string }>();

  const [world, setWorld] = useState<WorldInfo | null>(null);
  const [maps, setMaps] = useState<MapListItem[]>([]);
  const [activeMapId, setActiveMapId] = useState<string | null>(null);
  const [error, setError] = useState("");

  // 新建地图
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  /** 底图方式：空白画布（推荐）或上传图片 */
  const [newKind, setNewKind] = useState<"canvas" | "image">("canvas");
  const [newBoardWidth, setNewBoardWidth] = useState(DEFAULT_BOARD_WIDTH);
  const [newFile, setNewFile] = useState<File | null>(null);
  const [creating, setCreating] = useState(false);

  /** 编辑器实例：切换地图时重建（避免残留上一张图的状态） */
  const editorKeyRef = useRef(0);

  /** 拉取地图列表 */
  const loadLists = useCallback(async () => {
    const list = await api<MapListItem[]>(`/api/worlds/${worldId}/maps`);
    setMaps(list);
    setActiveMapId((current) => {
      if (current && list.some((item) => item.id === current)) {
        return current;
      }
      return list[0]?.id ?? null;
    });
  }, [worldId]);

  // 初始加载
  useEffect(() => {
    api<WorldInfo>(`/api/worlds/${worldId}`)
      .then(setWorld)
      .catch(() => setWorld(null));
    loadLists().catch((err: Error) => setError(err.message));
  }, [worldId, loadLists]);

  const activeMap = maps.find((item) => item.id === activeMapId) ?? null;
  const isCanvas = activeMap?.kind === "canvas";

  // 适配器与草稿存储：切图时重建，保证不会把上一张图的缓存带过来
  const adapter = useMemo(() => createHttpMapHostAdapter(), [activeMapId]);
  const drafts = useMemo(() => createIndexedDbDraftStore(), []);

  /**
   * 创建地图：按底图方式分流。
   * @param event 表单提交事件
   */
  const handleCreateMap = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!newName.trim()) {
      showToast("warning", "请填写地图名称");
      return;
    }
    if (newKind === "image" && !newFile) {
      showToast("warning", "请选择地图图片");
      return;
    }
    setCreating(true);
    try {
      if (newKind === "canvas") {
        // 空白画布：宽度由服务端规整为 128 的倍数，高度自动取一半（2:1）
        const created = await api<{ id: string }>(`/api/worlds/${worldId}/maps/canvas`, {
          method: "POST",
          body: { name: newName.trim(), width: normalizeBoardWidth(newBoardWidth) },
        });
        showToast("success", "画布已创建");
        setShowCreate(false);
        setNewName("");
        editorKeyRef.current += 1;
        await loadLists();
        setActiveMapId(created.id);
        return;
      }

      const uploaded = await uploadImage(newFile as File, 4096);
      const data = await api<{ id: string }>(`/api/worlds/${worldId}/maps`, {
        method: "POST",
        body: { name: newName.trim(), imageKey: uploaded.key },
      });
      showToast("success", "地图已创建");
      setShowCreate(false);
      setNewName("");
      setNewFile(null);
      editorKeyRef.current += 1;
      await loadLists();
      setActiveMapId(data.id);
    } catch (err) {
      showToast("error", (err as Error).message);
    } finally {
      setCreating(false);
    }
  };

  /** 切换到某张地图 */
  const selectMap = (mapId: string): void => {
    if (mapId === activeMapId) {
      return;
    }
    editorKeyRef.current += 1;
    setActiveMapId(mapId);
  };

  if (error) {
    return <div className="notice error">{error}</div>;
  }

  return (
    <>
      <div className="entry-view-head">
        <div>
          <h1 className="page-title" style={{ marginBottom: 4 }}>
            地图
          </h1>
          <p className="page-subtitle" style={{ marginBottom: 0 }}>
            {world?.name ?? ""} · 球面白板编辑器
          </p>
        </div>
        <div className="entry-view-actions">
          <button type="button" className="btn small" onClick={() => setShowCreate(true)}>
            + 新建地图
          </button>
        </div>
      </div>

      {/* 地图标签：切换地图 */}
      {maps.length > 0 && (
        <div className="map-tabs">
          {maps.map((map) => (
            <button
              key={map.id}
              type="button"
              className={`tag-chip${activeMapId === map.id ? " active" : ""}`}
              onClick={() => selectMap(map.id)}
            >
              {map.name}
              {map.kind === "canvas" ? " · 画布" : ""}（{map.markerCount}）
            </button>
          ))}
        </div>
      )}

      {activeMap && isCanvas && (
        <MapEditor
          key={`${activeMapId}-${editorKeyRef.current}`}
          mapId={activeMap.id}
          adapter={adapter}
          drafts={drafts}
          // 纸张素材由宿主打包并给地址：插件本体不允许自己去取素材（边界规则第 3 条）
          paperTextureUrl={parchmentUrl}
          onError={(err) => showToast("error", err.message)}
        />
      )}

      {activeMap && !isCanvas && <ImageMapViewer map={activeMap} />}

      {maps.length === 0 && !showCreate && (
        <div className="empty">还没有地图，点「+ 新建地图」开始</div>
      )}

      {showCreate && (
        <div className="modal-overlay" onClick={() => setShowCreate(false)}>
          <div className="modal" onClick={(clickEvent) => clickEvent.stopPropagation()}>
            <h2 className="section-title">新建地图</h2>
            <form className="form" style={{ maxWidth: "none" }} onSubmit={handleCreateMap}>
              <div className="field">
                <label htmlFor="mapName">地图名称</label>
                <input
                  id="mapName"
                  value={newName}
                  onChange={(event) => setNewName(event.target.value)}
                  placeholder="如：大陆全图"
                  required
                />
              </div>

              <div className="field">
                <span style={{ display: "block", marginBottom: 6 }}>底图方式</span>
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    type="button"
                    className={newKind === "canvas" ? "btn small" : "btn ghost small"}
                    onClick={() => setNewKind("canvas")}
                  >
                    空白画布（绘制地形）
                  </button>
                  <button
                    type="button"
                    className={newKind === "image" ? "btn small" : "btn ghost small"}
                    onClick={() => setNewKind("image")}
                  >
                    上传图片底图
                  </button>
                </div>
              </div>

              {newKind === "canvas" ? (
                <div className="field">
                  <label htmlFor="boardWidth">白板宽度（高度自动为一半）</label>
                  <input
                    id="boardWidth"
                    type="number"
                    min={BOARD_MIN_WIDTH}
                    max={BOARD_MAX_WIDTH}
                    step={BOARD_WIDTH_STEP}
                    value={newBoardWidth}
                    onChange={(event) => setNewBoardWidth(Number(event.target.value))}
                  />
                  <p style={{ marginTop: 4, fontSize: 12, color: "#a89c88", lineHeight: 1.6 }}>
                    将创建 {normalizeBoardWidth(newBoardWidth)}×{normalizeBoardWidth(newBoardWidth) / 2} 的球面白板：
                    用笔刷绘制地形、放标记关联条目，可测量距离与面积、导出图片。宽度越大越精细，数据量也越大。
                  </p>
                </div>
              ) : (
                <div className="field">
                  <label htmlFor="mapFile">地图图片（自动压缩转 WebP，建议 4096px 以内）</label>
                  <input
                    id="mapFile"
                    type="file"
                    accept="image/*"
                    onChange={(event) => setNewFile(event.target.files?.[0] ?? null)}
                  />
                  <p style={{ marginTop: 4, fontSize: 12, color: "#a89c88", lineHeight: 1.6 }}>
                    图片底图只能查看与放标记（旧版地图的形态）；要在图上绘制地形，请选「空白画布」。
                  </p>
                </div>
              )}

              <div style={{ display: "flex", gap: 10 }}>
                <button type="submit" className="btn" disabled={creating}>
                  {creating ? "处理中…" : "创建"}
                </button>
                <button
                  type="button"
                  className="btn ghost"
                  onClick={() => setShowCreate(false)}
                  disabled={maps.length === 0}
                >
                  {maps.length === 0 ? "请先创建一张地图" : "取消"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}

/**
 * 图片型地图的简化查看器（旧数据用）。
 *
 * 保留原图预览与标记计数：旧地图仍可查看，但绘制类能力只对画布型开放。
 * @param props.map 地图项
 * @returns 查看器节点
 */
function ImageMapViewer(props: { map: MapListItem }): React.ReactElement {
  const { map } = props;
  return (
    <div>
      <div className="notice" style={{ marginBottom: 10 }}>
        这是旧版「图片底图」地图：可查看原图与标记位置；要绘制地形请新建「空白画布」地图。
      </div>
      <div
        style={{
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          overflow: "hidden",
          background: "var(--bg-card)",
        }}
      >
        {map.imageUrl ? (
          <img
            src={map.imageUrl}
            alt={map.name}
            style={{ display: "block", width: "100%", height: "auto" }}
          />
        ) : (
          <div style={{ padding: 40, textAlign: "center", color: "var(--text-faint)" }}>
            地图图片缺失
          </div>
        )}
      </div>
      <p style={{ marginTop: 8, fontSize: 12, color: "var(--text-faint)" }}>
        {map.name} · 标记 {map.markerCount} 个
      </p>
    </div>
  );
}
