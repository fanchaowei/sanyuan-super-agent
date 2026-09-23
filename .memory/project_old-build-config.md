---
name: old-build-config
description: 旧的构建配置位置（已迁移到 vite.config.ts 和 tsconfig.json）
type: project
---

构建配置在 webpack.config.js 里，babel 配置在 .babelrc。
本地启动用 npm run dev，生产构建用 npm run build。

⚠️ 注意：该配置已废弃，当前使用 Vite 构建，主配置在 vite.config.ts，类型配置在 tsconfig.json。