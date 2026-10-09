/**
 * 图层面板：图层的新增 / 改名 / 显隐 / 顺序 / 透明度 / 删除。
 *
 * 设计要点（方案 §9）：
 * - **图层是数据不是代码**：用户可自建「外交」「贸易」等任意图层，
 *   面板不预设固定的类型清单，只给几个常用预设作为默认值
 * - 面板不依赖宿主 CSS 变量，只用 theme token（与编辑器其它部分一致）
 */
import { useState } from "react";
import type { MapEditorTheme, MapLayer } from "@worldmap/core";

/** 新建图层时可选的类型预设（名称只是默认值，用户可改） */
const LAYER_PRESETS: { type: MapLayer["type"]; label: string }[] = [
  { type: "terrain", label: "地形" },
  { type: "political", label: "政治" },
  { type: "military", label: "军事" },
  { type: "religion", label: "宗教" },
  { type: "ethnic", label: "民族" },
  { type: "custom", label: "自定义" },
];

/** 图层面板属性 */
export interface LayerPanelProps {
  theme: MapEditorTheme;
  /** 全部图层（面板内部按 zIndex 从高到低展示，越上面越靠前） */
  layers: MapLayer[];
  /** 当前正在绘制的图层 id */
  activeLayerId: string | null;
  /** 只读模式：隐藏所有写操作 */
  readOnly?: boolean;
  onSelect: (layerId: string) => void;
  onToggleVisible: (layerId: string, visible: boolean) => void;
  onRename: (layerId: string, name: string) => void;
  onOpacity: (layerId: string, opacity: number) => void;
  /** 上移 / 下移一层（本质是改 zIndex） */
  onMove: (layerId: string, direction: "up" | "down") => void;
  onAdd: (name: string, type: MapLayer["type"]) => void;
  onRemove: (layerId: string) => void;
}

/**
 * 图层面板。
 * @param props 见 `LayerPanelProps`
 * @returns 面板节点
 */
export function LayerPanel(props: LayerPanelProps): React.ReactElement {
  const { theme, layers, activeLayerId, readOnly } = props;
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("新图层");
  const [newType, setNewType] = useState<MapLayer["type"]>("custom");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");

  // 展示顺序与渲染顺序相反：zIndex 大的在最上面（贴近图层心理模型）
  const ordered = [...layers].sort((a, b) => b.zIndex - a.zIndex);

  return (
    <div
      style={{
        width: 210,
        padding: 8,
        fontSize: 12,
        background: `${theme.panel}f2`,
        border: `1px solid ${theme.border}`,
        borderRadius: theme.radius,
        color: theme.textDim,
        display: "flex",
        flexDirection: "column",
        gap: 4,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6, color: theme.text }}>
        <span style={{ flex: 1 }}>图层</span>
        {!readOnly && (
          <button
            type="button"
            onClick={() => setAdding((value) => !value)}
            style={{
              background: "transparent",
              border: `1px solid ${theme.border}`,
              borderRadius: theme.radius,
              color: theme.text,
              cursor: "pointer",
              fontSize: 12,
              padding: "1px 6px",
            }}
          >
            ＋
          </button>
        )}
      </div>

      {adding && !readOnly && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4, padding: "4px 0" }}>
          <input
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
            placeholder="图层名称"
            style={inputStyle(theme)}
          />
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
            {LAYER_PRESETS.map((preset) => (
              <button
                key={preset.type}
                type="button"
                onClick={() => {
                  setNewType(preset.type);
                  // 用户没改过名字时，用预设名做默认
                  if (newName === "新图层" || newName === "") {
                    setNewName(preset.label);
                  }
                }}
                style={{
                  ...inputStyle(theme),
                  padding: "1px 6px",
                  fontSize: 11,
                  cursor: "pointer",
                  borderColor: newType === preset.type ? theme.accent : theme.border,
                  color: newType === preset.type ? theme.accent : theme.textDim,
                }}
              >
                {preset.label}
              </button>
            ))}
          </div>
          <div style={{ display: "flex", gap: 4 }}>
            <button
              type="button"
              onClick={() => {
                if (!newName.trim()) {
                  return;
                }
                props.onAdd(newName.trim(), newType);
                setAdding(false);
                setNewName("新图层");
              }}
              style={{ ...inputStyle(theme), cursor: "pointer" }}
            >
              创建
            </button>
            <button
              type="button"
              onClick={() => setAdding(false)}
              style={{ ...inputStyle(theme), cursor: "pointer" }}
            >
              取消
            </button>
          </div>
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        {ordered.map((layer) => {
          const isActive = layer.id === activeLayerId;
          return (
            <div
              key={layer.id}
              style={{
                padding: "4px 6px",
                borderRadius: theme.radius,
                background: isActive ? `${theme.accent}22` : "transparent",
                border: `1px solid ${isActive ? theme.accent : "transparent"}`,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                <input
                  type="checkbox"
                  checked={layer.visible}
                  onChange={(event) => props.onToggleVisible(layer.id, event.target.checked)}
                  title="显示 / 隐藏"
                />
                {editingId === layer.id ? (
                  <input
                    autoFocus
                    value={editingName}
                    onChange={(event) => setEditingName(event.target.value)}
                    onBlur={() => {
                      if (editingName.trim()) {
                        props.onRename(layer.id, editingName.trim());
                      }
                      setEditingId(null);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        if (editingName.trim()) {
                          props.onRename(layer.id, editingName.trim());
                        }
                        setEditingId(null);
                      } else if (event.key === "Escape") {
                        setEditingId(null);
                      }
                    }}
                    style={{ ...inputStyle(theme), flex: 1, minWidth: 0 }}
                  />
                ) : (
                  <button
                    type="button"
                    onDoubleClick={() => {
                      setEditingId(layer.id);
                      setEditingName(layer.name);
                    }}
                    onClick={() => props.onSelect(layer.id)}
                    title="单击选中为当前图层，双击改名"
                    style={{
                      flex: 1,
                      minWidth: 0,
                      textAlign: "left",
                      background: "transparent",
                      border: "none",
                      color: isActive ? theme.accent : theme.text,
                      cursor: "pointer",
                      fontSize: 12,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      padding: 0,
                    }}
                  >
                    {layer.name}
                    {layer.storage === "raster" ? "" : "（矢量）"}
                  </button>
                )}
                {!readOnly && (
                  <>
                    <button
                      type="button"
                      title="上移一层"
                      onClick={() => props.onMove(layer.id, "up")}
                      style={tinyButtonStyle(theme)}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      title="下移一层"
                      onClick={() => props.onMove(layer.id, "down")}
                      style={tinyButtonStyle(theme)}
                    >
                      ↓
                    </button>
                    {layers.length > 1 && (
                      <button
                        type="button"
                        title="删除图层"
                        onClick={() => props.onRemove(layer.id)}
                        style={tinyButtonStyle(theme)}
                      >
                        ×
                      </button>
                    )}
                  </>
                )}
              </div>
              <input
                type="range"
                min={10}
                max={100}
                value={Math.round(layer.opacity * 100)}
                onChange={(event) => props.onOpacity(layer.id, Number(event.target.value) / 100)}
                title={`透明度 ${Math.round(layer.opacity * 100)}%`}
                style={{ width: "100%", marginTop: 2 }}
              />
            </div>
          );
        })}
      </div>

      <div style={{ color: theme.textFaint, lineHeight: 1.6, marginTop: 2 }}>
        单击选为当前图层；双击改名；↑↓ 调顺序
      </div>
    </div>
  );
}

/** 输入框样式 */
function inputStyle(theme: MapEditorTheme): React.CSSProperties {
  return {
    background: theme.background,
    color: theme.text,
    border: `1px solid ${theme.border}`,
    borderRadius: theme.radius,
    padding: "2px 6px",
    fontSize: 12,
  };
}

/** 小按钮样式 */
function tinyButtonStyle(theme: MapEditorTheme): React.CSSProperties {
  return {
    background: "transparent",
    border: "none",
    color: theme.textFaint,
    cursor: "pointer",
    fontSize: 12,
    padding: "0 2px",
    lineHeight: 1,
  };
}
