# AGENTS.md — 项目协作约定

> 本文件是给 AI 编码助手的项目规范，所有代码工作必须遵守。

## 项目概述

世界观协作平台（网页版为主，规划电脑版 / 安卓版）。完整方案见 `docs/方案.md`。

## 文档约定

- 一切设计类方案、规划与建议统一写入 `docs/` 目录（如 `docs/方案.md`），不散落在根目录或其他位置

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
```

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

- 地址：https://create-world.wyz15728790233.workers.dev
- 架构：单个 Worker 同时提供 API 与前端静态资源（同域）；数据在 D1，图片在 KV
- 生产密钥（BETTER_AUTH_SECRET / MIGRATE_SECRET / AI_KEY_SECRET / ADMIN_USERNAMES / BOOTSTRAP_INVITE_CODE / BETTER_AUTH_URL）
  通过 `wrangler secret bulk` 管理，不写入仓库
- 修改代码后执行 `pnpm deploy` 即发布；数据库结构变更先本地加迁移文件，再执行远程迁移命令

## 提交规范

- 提交信息用中文，格式：`类型: 简述`（如 `feat: 条目编辑器自动保存`、`fix: 修复链接解析`）
- 不提交密钥、`.dev.vars`、本地数据文件
