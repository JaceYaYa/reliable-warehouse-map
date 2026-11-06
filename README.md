# Electronic WMS System

仓库管理系统 V151 源码，来自 2026-11-06 交接包。

支持仓库地图、库位与库存、出入库、单箱管理、计价结算、工单、账号权限及备份恢复。

## 本地开发

要求 Node.js >= 22.13.0，使用 pnpm 和包内锁定的依赖版本。

```sh
pnpm install --frozen-lockfile
pnpm dev
pnpm build
pnpm test
```

项目使用 React、vinext、Cloudflare D1 / R2 和 Drizzle。
`.openai/hosting.json` 声明 `DB` 与 `BACKUPS` 绑定；数据库迁移在 `drizzle/`。

## 首次管理员登录

公开版本没有可用的默认管理员密码，也不会在启动时重置已有密码。
在支持可信身份请求头的 Sites 环境中，由站点所有者配置 `HANDOFF_OWNER_EMAIL`，
再通过 `/handoff` 使用对应的 ChatGPT 账号登录并设置个人密码。
`oai-authenticated-user-email` 必须由可信平台注入，不能直接信任外部客户端传入的同名请求头。
其他部署环境需要先配置可信身份入口，再初始化管理员账号。

## 数据与公开范围

本仓库只包含应用源码、数据库结构、依赖锁定文件、文档及测试。
原交接包的完整仓储备份、结算、审计及账号数据没有上传。
业务恢复应通过已部署系统的授权备份恢复流程进行，不能将真实备份提交到公开仓库。
环境变量、数据库文件、私钥及备份归档均应保留在仓库外。

上传源码不代表网站已部署，也不代表业务数据已恢复。
