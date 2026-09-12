---
name: legacy-auth-module
description: 项目认证模块的历史实现
type: project
---

项目的认证逻辑放在 src/legacy/auth.ts，所有 JWT 签发和校验都走这个文件。
中间件入口在 src/middleware/auth-guard.ts，路由层只需要挂上这个中间件就有权限校验。

如果要新增鉴权策略，扩展 src/legacy/auth.ts 里的 AuthStrategy 接口。
