/**
 * 静态资源模块声明。
 *
 * 构建工具（Vite / rolldown）会把 import 进来的图片替换成产物地址，
 * 但 TypeScript 不认识 `.jpg` / `.png` 这类导入，需要在这里声明它们的类型。
 *
 * 约定：素材默认导出的是**最终地址字符串**，可直接交给
 * `MapEditor` 的 `paperTextureUrl` 或 `<img src>` 使用。
 */

declare module "*.jpg" {
  const url: string;
  export default url;
}

declare module "*.jpeg" {
  const url: string;
  export default url;
}

declare module "*.png" {
  const url: string;
  export default url;
}

declare module "*.webp" {
  const url: string;
  export default url;
}

declare module "*.svg" {
  const url: string;
  export default url;
}
