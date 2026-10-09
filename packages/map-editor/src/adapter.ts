/**
 * 契约类型的转发出口。
 *
 * 契约实际定义在 `@worldmap/core`（公共类型中心），这里只做转发，
 * 好处是：宿主适配器实现与插件本体都从内核取类型，彼此不必互相依赖，
 * 而使用方仍然可以从本包直接 import（历史写法不失效）。
 */
export type {
  MapEditorFeatures,
  MapEditorHandle,
  MapEditorProps,
  MapEditorTheme,
  MapHostAdapter,
  SaveLayersInput,
  SaveState,
  SaveTilesResult,
} from "@worldmap/core";
