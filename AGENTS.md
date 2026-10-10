# AGENTS.md — 项目协作约定

> 本文件是给 AI 编码助手的项目规范，所有代码工作必须遵守。

## 项目概述

世界观协作平台（网页版为主，规划电脑版 / 安卓版）。完整方案见 `docs/方案.md`。

## 文档约定

- 一切设计类方案、规划与建议统一写入 `docs/` 目录，不散落在根目录或其他位置
- **内容分流**：功能 / 产品方案写入 `docs/方案.md`；UI / 视觉设计写入 `docs/UI设计.md`
- **每次代码更新完成后，必须在 `docs/更新日志.md` 顶部登记一条**（最新在上，格式：日期 · 类型 · 内容）

## 代码规范（必须遵守）

1. **每个函数都要有注释**：说明用途、参数、返回值、副作用；使用中文注释，简洁清楚
2. **能拆就拆**：按职责拆分文件与函数，一个函数只做一件事（单一职责）；长逻辑拆成多个小函数
3. **清晰优先**：命名见名知意（中文业务概念可用拼音或英文，避免随意缩写）；宁可多几行直白代码，不写晦涩的炫技写法
4. **尽量简化**：不写用不到的功能，不做过度抽象；优先复用已有工具函数
5. **类型完备**：TypeScript 严格模式，避免 `any`；公共类型统一定义在 `packages/core`
6. **注释写「为什么」和「怎么用」**，不写废话（比如 `// 加一` 这种无意义注释）

## 工程结构（单仓库 monorepo）

```
apps/
  web/      React SPA：三端共用的界面与业务逻辑
  server/   Cloudflare Workers（Hono API）+ D1 迁移脚本
  desktop/  Tauri 壳（Windows）+ 本地 SQLite
  android/  Capacitor 壳（Android）+ 本地 SQLite
packages/
  core/     共用领域逻辑：数据模型、双向链接、版本、权限
  storage/  存储适配层（平台 API / SQLite / IndexedDB）
  sync/     同步适配层（平台 API / WebDAV）
  map-*/    地图编辑器插件（内核 / 组件 / 平台实现）
assets/     主站素材：品牌、界面、插图、演示图（详细规范见 assets/README.md）
docs/       方案与设计文档
```

**素材放哪**（两处，按「换个项目还能不能用」判断，细则见 `docs/方案.md` §11.1）：
- 主站自己的（Logo、插图、演示底图）→ 仓库根 `assets/`
- 地图编辑器渲染要用的（地形纹理、编辑器图标、3D 贴图）→ `packages/map-editor/assets/`，随插件包分发
- 每份素材都要在对应素材库的 `README.md` 清单里登记来源与许可证；来源不明的一律不收

## 关键技术与约束

- **零信用卡**：不使用需要绑定支付方式的 Cloudflare 服务；图片存 Workers KV（1GB），数据库用 D1（单库 500MB）
- **认证**：better-auth（username 插件）+ 邀请码注册；本期不接邮件服务
- **编辑器**：TipTap，零语法门槛；内容按「块」存储（`entry_blocks`）
- **AI**：外部 OpenAI 兼容接口，用户自带 Key，Worker 代理转发
- **自动保存**：本地 IndexedDB 暂存 + 服务端防抖保存；版本快照节流
- **长文**：阅读页懒渲染；超 3 万字切换分块编辑

## 常用命令

- 安装依赖：`pnpm install`
- 同时启动前后端：`pnpm dev`（服务端 8787 / 前端 5173）
- 仅启动服务端：`pnpm dev:server`；仅启动前端：`pnpm dev:web`
- 本地数据库迁移：`pnpm --filter @create-world/server db:migrate:local`
- 创建 better-auth 认证表（首次启动后调用一次，本地的 MIGRATE_SECRET 见 `.dev.vars.example`）：
  `POST http://localhost:8787/api/migrate`，请求头 `x-migrate-secret: <值>`
- 全量类型检查：`pnpm typecheck`
- 前端构建：`pnpm --filter @create-world/web build`
- 部署（构建前端 + 发布 Worker）：`pnpm deploy`
- 远程数据库迁移：`pnpm --filter @create-world/server db:migrate:remote`

## 生产环境

- 地址：https://ravennull.monster（自定义域名，绑定在 Cloudflare Worker 上）—— **对外应只使用这个地址**
- Worker 默认地址：https://create-world.wyz15728790233.workers.dev（仍部署在 Cloudflare，域名本身有效）
  - ⚠️ **实测（2026-10-09）：该域名在部分网络下 DNS 被污染**，解析到 `108.160.169.181`（非 Cloudflare IP 段，疑似运营商劫持），`curl` 连接直接超时；而自定义域名正常解析到 Cloudflare（`104.21.x` / `172.67.x`）
  - 结论：不要再把它当作"双活备用地址"宣传或依赖；需要备用入口时应另配一个自定义域名
- 架构：单个 Worker 同时提供 API 与前端静态资源（同域）；数据在 D1，图片在 KV
- **`BETTER_AUTH_URL` 必须与当前对外域名一致**，否则浏览器会拒收会话 cookie（现象：页面能打开但登录不上）
- 生产密钥（BETTER_AUTH_SECRET / MIGRATE_SECRET / AI_KEY_SECRET / ADMIN_USERNAMES / BOOTSTRAP_INVITE_CODE / BETTER_AUTH_URL）
  通过 `wrangler secret bulk` 管理，不写入仓库
- 修改代码后执行 `pnpm deploy` 即发布；数据库结构变更先本地加迁移文件，再执行远程迁移命令
- ⚠️ **git 推送偶发连不上 GitHub 时的处理**：现象为 `Failed to connect to github.com:443 after 21000 ms`（`Test-NetConnection github.com -Port 443` 却显示可达）。原因是 git 默认走 HTTP/2，在当前网络下不稳定；解决办法是强制 HTTP/1.1：
  `git -c http.version=HTTP/1.1 push origin main`
- ⚠️ **`github.com:443` 被阻断时的绕行**（2026-10-09 实测）：现象为 HTTPS 一直 `Failed to connect`，但同一时间 `ssh.github.com:443`、`codeload.github.com`、`api.github.com` 都是通的 —— 属**单域名阻断**，不是整体断网。此时改用 SSH 走 443 端口即可（本机 `~/.ssh` 已有可用密钥，`ssh -T -p 443 git@ssh.github.com` 返回 `Hi raven-null!` 即为正常）：
  `git push ssh://git@ssh.github.com:443/raven-null/Web_CreateWorld.git main:main`
  诊断命令：`Test-NetConnection github.com -Port 443 -InformationLevel Quiet` 对多个 GitHub 域名各测一次，看是否只有主域不通。

## 提交规范

- 提交信息用中文，格式：`类型: 简述`（如 `feat: 条目编辑器自动保存`、`fix: 修复链接解析`）
- 不提交密钥、`.dev.vars`、本地数据文件
- ⚠️ **不要用 `git add -A` / `git add .`**：工作区里可能同时存在他人（或自己）尚未完成、不属于本次改动的文件，一把梭会把无关改动混进同一个提交，也会误加只读参考目录（如 `.tmp-ref`）。
  只添加本次明确改动的路径，例如 `git add apps/web/src/pages/MapEditorPage.tsx docs/地图编辑器更新日志.md`；
  提交后用 `git show --stat HEAD` 核对文件清单，再推送。
