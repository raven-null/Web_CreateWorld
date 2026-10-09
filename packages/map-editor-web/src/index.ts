/**
 * `@worldmap/editor-web` 的出口：浏览器侧的平台适配实现。
 *
 * 与插件本体的分工：本包负责「和外界打交道」（HTTP、存储、压缩、导出），
 * 插件本体只认契约，因此换宿主时只需要换这一层。
 */
export * from "./http-adapter";
