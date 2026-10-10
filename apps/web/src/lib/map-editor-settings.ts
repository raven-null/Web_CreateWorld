/**
 * 地图编辑器的界面偏好（本项目宿主的存储实现）。
 *
 * 插件本体不允许碰 `localStorage`（CI 边界规则第 3 条），
 * 因此「存哪儿」这件事由宿主负责：这里用 localStorage，
 * 将来桌面端换成配置文件、移动端换成 SQLite 都可以，插件不用改。
 */
import type { MapEditorViewSettings } from "@worldmap/core";

/** localStorage 键名（带版本号，将来改结构时不会读到旧格式） */
const STORAGE_KEY = "create-world:map-editor-view:v1";

/**
 * 读取已保存的界面偏好。
 * 读取失败（隐私模式、禁用存储、JSON 损坏）时返回空对象，用插件默认值。
 *
 * @returns 偏好设置；没有任何记录时返回空对象
 */
export function loadMapEditorViewSettings(): MapEditorViewSettings {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) {
      return {};
    }
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return {};
    }
    const record = parsed as Record<string, unknown>;
    const settings: MapEditorViewSettings = {};
    if (typeof record.gridIntervalDeg === "number") {
      settings.gridIntervalDeg = record.gridIntervalDeg;
    }
    if (record.renderStyle === "flat" || record.renderStyle === "handdrawn") {
      settings.renderStyle = record.renderStyle;
    }
    if (typeof record.zoomMin === "number") {
      settings.zoomMin = record.zoomMin;
    }
    if (typeof record.zoomMax === "number") {
      settings.zoomMax = record.zoomMax;
    }
    return settings;
  } catch {
    return {};
  }
}

/**
 * 保存界面偏好。
 * 写入失败时静默忽略：存不下偏好不该影响画地图。
 *
 * @param settings 要保存的偏好
 */
export function saveMapEditorViewSettings(settings: MapEditorViewSettings): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // 忽略：无存储权限时只是下次打开回到默认值
  }
}
