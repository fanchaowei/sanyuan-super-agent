---
name: deploy-process
description: 部署流程的关键步骤
type: project
---

完整部署流程参见 docs/deployment-guide.md。

执行顺序：
1. 拉代码、装依赖
2. 跑数据库迁移（脚本：scripts/migrate.sh）
3. 构建前端产物
4. 启动服务（用 scripts/deploy.sh 一键启动）

上次部署事故跟 users 表 email 字段从 VARCHAR(255) 改成 VARCHAR(100) 有关——具体复盘见部署指南。
