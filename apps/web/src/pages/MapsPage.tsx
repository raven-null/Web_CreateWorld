import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { api } from "../lib/api";
import { uploadImage } from "../lib/image-upload";
import { showToast } from "../lib/toast";

/** 地图列表项 */
interface MapListItem {
  id: string;
  name: string;
  imageUrl: string;
  markerCount: number;
  createdAt: number;
}

/** 地图详情（含标记） */
interface MapDetail {
  id: string;
  worldId: string;
  name: string;
  imageUrl: string;
  canEdit: boolean;
  markers: MarkerItem[];
}

/** 标记 */
interface MarkerItem {
  id: string;
  x: number;
  y: number;
  label: string;
  entryId: string | null;
  entryTitle: string | null;
}

/** 世界信息（本页只用到名称） */
interface WorldInfo {
  name: string;
}

/** 条目下拉选项 */
interface EntryOption {
  id: string;
  title: string;
}

/**
 * 地图页：上传自定义地图图片，点击放置标记并关联条目。
 * 使用 Leaflet 的 CRS.Simple 图片叠加模式。
 */
export default function MapsPage() {
  const { worldId = "" } = useParams<{ worldId: string }>();
  const navigate = useNavigate();

  const [world, setWorld] = useState<WorldInfo | null>(null);
  const [maps, setMaps] = useState<MapListItem[]>([]);
  const [activeMapId, setActiveMapId] = useState<string | null>(null);
  const [detail, setDetail] = useState<MapDetail | null>(null);
  const [entries, setEntries] = useState<EntryOption[]>([]);
  const [error, setError] = useState("");

  // 新建地图
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [newFile, setNewFile] = useState<File | null>(null);
  const [creating, setCreating] = useState(false);

  // 添加标记
  const [addMode, setAddMode] = useState(false);
  const [pendingMarker, setPendingMarker] = useState<{ x: number; y: number } | null>(null);
  const [markerLabel, setMarkerLabel] = useState("");
  const [markerEntryId, setMarkerEntryId] = useState("");

  // 编辑标记
  const [editingMarker, setEditingMarker] = useState<MarkerItem | null>(null);

  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const leafletRef = useRef<L.Map | null>(null);
  const layerRef = useRef<L.LayerGroup | null>(null);
  const imageSizeRef = useRef({ width: 1000, height: 1000 });
  const addModeRef = useRef(false);
  const canEditRef = useRef(false);

  useEffect(() => {
    addModeRef.current = addMode;
  }, [addMode]);

  /** 加载地图列表与条目选项 */
  const loadLists = useCallback(async () => {
    const [list, entryList] = await Promise.all([
      api<MapListItem[]>(`/api/worlds/${worldId}/maps`),
      api<EntryOption[]>(`/api/worlds/${worldId}/entries`),
    ]);
    setMaps(list);
    setEntries(entryList);
    setActiveMapId((current) => current ?? list[0]?.id ?? null);
  }, [worldId]);

  /** 加载当前地图详情 */
  const loadDetail = useCallback(async (mapId: string) => {
    const data = await api<MapDetail>(`/api/maps/${mapId}`);
    setDetail(data);
    canEditRef.current = data.canEdit;
  }, []);

  // 初始加载
  useEffect(() => {
    api<WorldInfo>(`/api/worlds/${worldId}`)
      .then(setWorld)
      .catch(() => setWorld(null));
    loadLists().catch((err: Error) => setError(err.message));
  }, [worldId, loadLists]);

  // 切换地图时加载详情
  useEffect(() => {
    if (!activeMapId) {
      setDetail(null);
      return;
    }
    loadDetail(activeMapId).catch((err: Error) => setError(err.message));
  }, [activeMapId, loadDetail]);

  /** 重建 Leaflet 地图（地图切换时） */
  useEffect(() => {
    if (!detail || !mapContainerRef.current) {
      return;
    }
    leafletRef.current?.remove();
    leafletRef.current = null;
    layerRef.current = null;

    const image = new Image();
    image.onload = () => {
      const width = image.naturalWidth;
      const height = image.naturalHeight;
      imageSizeRef.current = { width, height };
      if (!mapContainerRef.current) {
        return;
      }

      const map = L.map(mapContainerRef.current, {
        crs: L.CRS.Simple,
        minZoom: -4,
        maxZoom: 3,
        attributionControl: false,
      });
      const bounds = L.latLngBounds([0, 0], [height, width]);
      L.imageOverlay(detail.imageUrl, bounds).addTo(map);
      map.fitBounds(bounds);
      map.setMaxBounds(bounds.pad(0.3));

      const layer = L.layerGroup().addTo(map);
      leafletRef.current = map;
      layerRef.current = layer;

      // 点击空白处：添加标记模式下记录坐标
      map.on("click", (event: L.LeafletMouseEvent) => {
        if (!addModeRef.current || !canEditRef.current) {
          return;
        }
        const x = event.latlng.lng / width;
        const y = 1 - event.latlng.lat / height;
        if (x < 0 || x > 1 || y < 0 || y > 1) {
          return;
        }
        setMarkerLabel("");
        setMarkerEntryId("");
        setPendingMarker({ x, y });
      });
    };
    image.src = detail.imageUrl;

    return () => {
      leafletRef.current?.remove();
      leafletRef.current = null;
      layerRef.current = null;
    };
  }, [detail?.id, detail?.imageUrl]);

  // 标记变化时重绘（不重建地图，保持视野）
  useEffect(() => {
    const layer = layerRef.current;
    const map = leafletRef.current;
    if (!layer || !map || !detail) {
      return;
    }
    layer.clearLayers();
    const { width, height } = imageSizeRef.current;

    for (const marker of detail.markers) {
      const latlng = L.latLng(height * (1 - marker.y), width * marker.x);
      const circle = L.circleMarker(latlng, {
        radius: 7,
        color: "#c9a15c",
        weight: 2,
        fillColor: "#c9a15c",
        fillOpacity: 0.65,
      });
      circle.bindTooltip(marker.label || "标记", { direction: "top" });
      circle.on("click", (event: L.LeafletMouseEvent) => {
        L.DomEvent.stopPropagation(event);
      });

      // 气泡内容：标题 + 关联条目 + 操作按钮
      const container = document.createElement("div");
      container.className = "map-popup";
      const title = document.createElement("strong");
      title.textContent = marker.label || "未命名标记";
      container.appendChild(title);
      if (marker.entryId) {
        const link = document.createElement("a");
        link.textContent = marker.entryTitle ?? "关联条目";
        link.href = `/w/${detail.worldId}/entries/${marker.entryId}`;
        link.onclick = (clickEvent) => {
          clickEvent.preventDefault();
          navigate(`/w/${detail.worldId}/entries/${marker.entryId}`);
        };
        container.appendChild(link);
      }
      if (detail.canEdit) {
        const actions = document.createElement("div");
        actions.className = "map-popup-actions";
        const editButton = document.createElement("button");
        editButton.type = "button";
        editButton.textContent = "编辑";
        editButton.className = "btn ghost small";
        editButton.onclick = () => {
          setEditingMarker(marker);
          map.closePopup();
        };
        const deleteButton = document.createElement("button");
        deleteButton.type = "button";
        deleteButton.textContent = "删除";
        deleteButton.className = "btn ghost small";
        deleteButton.onclick = () => {
          void (async () => {
            if (!window.confirm("确定删除这个标记？")) {
              return;
            }
            try {
              await api(`/api/markers/${marker.id}`, { method: "DELETE" });
              map.closePopup();
              await loadDetail(detail.id);
              await loadLists();
            } catch (err) {
              showToast("error", (err as Error).message);
            }
          })();
        };
        actions.append(editButton, deleteButton);
        container.appendChild(actions);
      }
      circle.bindPopup(container);
      circle.addTo(layer);
    }
  }, [detail, navigate, loadDetail, loadLists]);

  /** 创建地图：先上传图片再保存 */
  const handleCreateMap = async (event: FormEvent) => {
    event.preventDefault();
    if (!newName.trim() || !newFile) {
      showToast("warning", "请填写地图名称并选择图片");
      return;
    }
    setCreating(true);
    try {
      const uploaded = await uploadImage(newFile, 4096);
      const data = await api<{ id: string }>(`/api/worlds/${worldId}/maps`, {
        method: "POST",
        body: { name: newName.trim(), imageKey: uploaded.key },
      });
      showToast("success", "地图已创建");
      setShowCreate(false);
      setNewName("");
      setNewFile(null);
      await loadLists();
      setActiveMapId(data.id);
    } catch (err) {
      showToast("error", (err as Error).message);
    } finally {
      setCreating(false);
    }
  };

  /** 提交新标记 */
  const handleCreateMarker = async (event: FormEvent) => {
    event.preventDefault();
    if (!detail || !pendingMarker) {
      return;
    }
    try {
      await api(`/api/maps/${detail.id}/markers`, {
        method: "POST",
        body: { x: pendingMarker.x, y: pendingMarker.y, label: markerLabel.trim(), entryId: markerEntryId || null },
      });
      setPendingMarker(null);
      setAddMode(false);
      await loadDetail(detail.id);
      await loadLists();
      showToast("success", "标记已添加");
    } catch (err) {
      showToast("error", (err as Error).message);
    }
  };

  /** 保存标记编辑 */
  const handleUpdateMarker = async (event: FormEvent) => {
    event.preventDefault();
    if (!detail || !editingMarker) {
      return;
    }
    try {
      await api(`/api/markers/${editingMarker.id}`, {
        method: "PATCH",
        body: { label: markerLabel.trim(), entryId: markerEntryId || null },
      });
      setEditingMarker(null);
      await loadDetail(detail.id);
      showToast("success", "标记已更新");
    } catch (err) {
      showToast("error", (err as Error).message);
    }
  };

  /** 重命名地图 */
  const handleRenameMap = async () => {
    if (!detail) {
      return;
    }
    const name = window.prompt("新的地图名称", detail.name);
    if (!name?.trim()) {
      return;
    }
    try {
      await api(`/api/maps/${detail.id}`, { method: "PATCH", body: { name: name.trim() } });
      await loadLists();
      await loadDetail(detail.id);
    } catch (err) {
      showToast("error", (err as Error).message);
    }
  };

  /** 删除地图 */
  const handleDeleteMap = async () => {
    if (!detail || !window.confirm(`确定删除地图「${detail.name}」及其全部标记？`)) {
      return;
    }
    try {
      await api(`/api/maps/${detail.id}`, { method: "DELETE" });
      setDetail(null);
      setActiveMapId(null);
      await loadLists();
      showToast("success", "地图已删除");
    } catch (err) {
      showToast("error", (err as Error).message);
    }
  };

  // 打开编辑标记表单时预填字段
  useEffect(() => {
    if (editingMarker) {
      setMarkerLabel(editingMarker.label);
      setMarkerEntryId(editingMarker.entryId ?? "");
    }
  }, [editingMarker]);

  if (error) {
    return <div className="notice error">{error}</div>;
  }

  const markerFormOpen = pendingMarker !== null || editingMarker !== null;

  return (
    <>
      <div className="entry-view-head">
        <div>
          <h1 className="page-title" style={{ marginBottom: 4 }}>
            地图
          </h1>
          <p className="page-subtitle" style={{ marginBottom: 0 }}>
            {world?.name ?? ""}
          </p>
        </div>
        {detail?.canEdit && (
          <div className="entry-view-actions">
            <button
              type="button"
              className={`btn${addMode ? "" : " ghost"}`}
              onClick={() => {
                setAddMode((value) => !value);
                setPendingMarker(null);
              }}
            >
              {addMode ? "点地图放置标记…" : "添加标记"}
            </button>
            <button type="button" className="btn ghost" onClick={() => void handleRenameMap()}>
              重命名地图
            </button>
            <button type="button" className="btn ghost" onClick={() => void handleDeleteMap()}>
              删除地图
            </button>
          </div>
        )}
      </div>

      <div className="map-tabs">
        {maps.map((map) => (
          <button
            key={map.id}
            type="button"
            className={`tag-chip${activeMapId === map.id ? " active" : ""}`}
            onClick={() => setActiveMapId(map.id)}
          >
            {map.name}（{map.markerCount}）
          </button>
        ))}
        <button type="button" className="btn ghost small" onClick={() => setShowCreate(true)}>
          + 新建地图
        </button>
      </div>

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
                <label htmlFor="mapFile">地图图片（自动压缩转 WebP，建议 4096px 以内）</label>
                <input
                  id="mapFile"
                  type="file"
                  accept="image/*"
                  onChange={(event) => setNewFile(event.target.files?.[0] ?? null)}
                  required
                />
              </div>
              <div style={{ display: "flex", gap: 10 }}>
                <button type="submit" className="btn" disabled={creating}>
                  {creating ? "上传中…" : "创建地图"}
                </button>
                <button type="button" className="btn ghost" onClick={() => setShowCreate(false)}>
                  取消
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {maps.length === 0 && !showCreate && (
        <div className="empty">
          还没有地图，点「+ 新建地图」上传你的世界地图
        </div>
      )}

      {detail && (
        <div className="map-view" ref={mapContainerRef} />
      )}

      {detail && detail.markers.length === 0 && (
        <div className="notice" style={{ marginTop: 10 }}>
          点击地图上的位置放置标记，标记可以关联到条目。
        </div>
      )}

      {markerFormOpen && detail && (
        <div
          className="modal-overlay"
          onClick={() => {
            setPendingMarker(null);
            setEditingMarker(null);
          }}
        >
          <div className="modal" onClick={(clickEvent) => clickEvent.stopPropagation()}>
            <h2 className="section-title">{editingMarker ? "编辑标记" : "添加标记"}</h2>
            <form className="form" style={{ maxWidth: "none" }} onSubmit={editingMarker ? handleUpdateMarker : handleCreateMarker}>
              <div className="field">
                <label htmlFor="markerLabel">标记名称</label>
                <input
                  id="markerLabel"
                  value={markerLabel}
                  onChange={(event) => setMarkerLabel(event.target.value)}
                  placeholder="如：银月城"
                  required
                />
              </div>
              <div className="field">
                <label htmlFor="markerEntry">关联条目（可选）</label>
                <select
                  id="markerEntry"
                  value={markerEntryId}
                  onChange={(event) => setMarkerEntryId(event.target.value)}
                >
                  <option value="">不关联</option>
                  {entries.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.title}
                    </option>
                  ))}
                </select>
              </div>
              <div style={{ display: "flex", gap: 10 }}>
                <button type="submit" className="btn">
                  保存
                </button>
                <button
                  type="button"
                  className="btn ghost"
                  onClick={() => {
                    setPendingMarker(null);
                    setEditingMarker(null);
                  }}
                >
                  取消
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      <div style={{ marginTop: 14 }}>
        <Link to={`/w/${worldId}/entries`} className="btn ghost small">
          返回条目列表
        </Link>
      </div>
    </>
  );
}
