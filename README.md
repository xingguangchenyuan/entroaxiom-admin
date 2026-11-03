# EntroAxiom 管理后台

[entroaxiom.com](https://entroaxiom.com) 的内容管理后台，线上地址 <https://admin.entroaxiom.com>。基于 [pure-admin-thin](https://github.com/pure-admin/pure-admin-thin)（MIT，见 `LICENSE`）改造，外观与前台同一套"星仪"主题。

![Vue](https://img.shields.io/badge/vue-3.5-42b883)
![Vite](https://img.shields.io/badge/vite-7-646cff)
![TypeScript](https://img.shields.io/badge/typescript-5.9-3178c6)
![Element Plus](https://img.shields.io/badge/element--plus-2.11-409eff)
![Tests](https://img.shields.io/badge/tests-216%20%2B%2032%20%2B%2030-brightgreen)

## 三个仓库

| 仓库 | 作用 | 技术栈 |
| --- | --- | --- |
| **entroaxiom-admin**（本仓库） | 内容管理界面 | Vue 3 · Vite · Element Plus |
| [entroaxiom-site](https://github.com/xingguangchenyuan/entroaxiom-site) | 前台站点 | React 18 · Vite |
| [entroaxiom-backend](https://github.com/xingguangchenyuan/entroaxiom-backend) | API 与业务规则 | Fastify 5 · PostgreSQL 16 |

前台是 React 项目、后台是 Vue 项目，两者只通过 `/api/admin/*` 打交道。接口契约见 [`docs/ADMIN_API.md`](docs/ADMIN_API.md)。

## 能做什么

- **内容**：随笔与学习笔记的列表（筛选、分页、批量）、Markdown 编辑器（实时预览、公式、表格、草稿自动保存）、可见范围、发布预检与发布、撤回、历史版本与恢复、导出 md/zip。
- **文件库**：上传（拖拽、进度、重名处理）、编辑名称/描述/可见性、引用查看、删除保护（被引用时 409）。
- **书架**：书/影/音的条目、评分、进度、封面（含资源决策）。
- **留言**：列表、详情（正文、邮箱、站点、IP 哈希）、回复、隐藏、删除。
- **审核规则**：关键词规则的新增/编辑/启停/删除，命中测试。
- **导入**：ZIP/Markdown 预演 → 逐条选择 → 提交，冲突提示。
- **概览**：内容与文件统计、存储用量。

## 技术栈

Vue 3.5 · Vite 7 · TypeScript 5.9 · Element Plus 2.11 · Pinia 3 · Vue Router 4 · Tailwind 4（仅布局工具类）· axios · ECharts（概览图）· `unified` 渲染管线（remark/rehype + KaTeX + sanitize）· SCSS。

## 目录

```
src/
  api/            接口封装：content / file / shelf / guestbook / moderation / imports / capabilities / user / query
  views/          页面：welcome（概览）、content（列表 + 编辑器）、library（文件）、shelf、guestbook、moderation、imports、login、error
  components/     Manager（发布弹窗、Markdown 视图等业务组件）+ Re* （表格、弹窗、图标等基础组件）
  composables/    useAuthMedia（带会话取图）、usePagedList、useUnsavedGuard
  utils/http/     请求拦截、信封拆解、401 刷新队列、会话失效广播
  utils/markdown/ 与前台一致的渲染管线
  mock/           开发替身（仅开发环境按 VITE_MOCK 装入）
  router/         静态路由表（modules/）
  store/          Pinia：用户、应用设置
  style/          entro.scss（星仪主题）、login.css、fonts.css
```

## 快速开始

```bash
pnpm install        # 必须用 pnpm（preinstall 里的 only-allow 会拦 npm / yarn）；Node 见 .nvmrc
pnpm dev            # http://localhost:8848，/api 由 Vite 转发到 127.0.0.1:8000
pnpm dev            # 想脱离后端看界面：.env.development 里 VITE_MOCK = true（默认）
```

不开后端也能把每个页面点开：`.env.development` 默认 `VITE_MOCK = true`，任意账号、密码 ≥ 6 位即可登录，数据只在内存里，刷新即重置。改成 `false` 就直连真后端。

## 构建

| 命令 | 产物 | 用途 |
| --- | --- | --- |
| `pnpm build` | `dist/` | 通过 `.env.production`，根路径 + hash 路由 |
| `pnpm build:staging` | `dist/` | 预发，读 `.env.staging` |
| `pnpm build:admin` | `dist/` | 挂在 `/admin/` 子路径（`VITE_PUBLIC_PATH=/admin/` + `VITE_ROUTER_HISTORY="hash,/admin/"`） |
| `pnpm build:admin:subdomain` | `dist/` | **当前生产形态**：独立子域名，根路径 + hash 路由 |

两个路径变量必须同时改：只改 `VITE_PUBLIC_PATH` 会让路由全 404；只改 `VITE_ROUTER_HISTORY` 会让 `index.html` 还去域名根找 `/static/...` 而白屏。

自检：

```bash
grep -o 'src="[^"]*"' dist/index.html     # 应看到 /static/js/index-*.js
grep -c '/admin/' dist/index.html         # 子域名构建应为 0
```

## 配置

| 变量 | 作用 | 默认 |
| --- | --- | --- |
| `VITE_API_BASE` | 管理接口前缀（`.env`） | `/api/admin` |
| `VITE_DEV_BACKEND` | 开发时 `/api` 转发到的后端 | `http://127.0.0.1:8000` |
| `VITE_MOCK` | 是否装入开发替身（**只允许开发环境开启**） | 开发 `true`，生产未设置 |
| `VITE_PUBLIC_PATH` | 部署路径 | `/` |
| `VITE_ROUTER_HISTORY` | `hash`（默认，静态托管无需回退规则）或 `h5` | `hash` |
| `VITE_CDN` | 打包时是否改用第三方 CDN 的脚本（建议永远 `false`） | `false` |
| `VITE_SITE_URL` | 前台站点地址，仅用于「在站点中查看」的绝对链接 | 空 |

运行时界面配置（标题、主题、布局）在 `public/platform-config.json`。

## 测试与门禁

```bash
pnpm typecheck      # tsc + vue-tsc
pnpm verify         # mock:smoke + render:smoke + v3:regression + typecheck
pnpm lint:check     # eslint + prettier --check + stylelint（只读；pnpm lint 是写入模式）
pnpm build          # 顺带验证生产构建
```

| 套件 | 条数 | 覆盖 |
| --- | --- | --- |
| `pnpm mock:smoke` | 216 | 替身接口与状态断言：列表分页、revision 冲突、发布决策、导入、留言状态机 |
| `pnpm render:smoke` | 32 | Markdown 渲染管线，含 XSS 清洗（脚本注入、`javascript:` 链接、`iframe`） |
| `pnpm v3:regression` | 30 | R1–R4：字段快照归一化、保存串行化、草稿键语义 |

## 鉴权与会话

- 真正的凭证是后端下发的 HttpOnly `sid` cookie（`Secure`、`SameSite=Strict`）；前端**不接触**它，同源请求由浏览器自动携带。
- 登录接口返回的 `accessToken` / `refreshToken` 只是界面占位：`refreshToken` 仅驻留内存，`accessToken` 存在 JS 可读的 cookie 里只为多标签页同步登录态，不参与后端鉴权。
- 401 时只刷新一次，排队的请求一起释放；刷新失败才回登录页（`utils/http/index.ts`）。会话失效会广播事件，清掉私密资源缓存与草稿。
- 后台页面的权限判断只是界面便利，**真正的鉴权在后端**；私密资源一律通过 `GET /api/admin/files/{id}/content` 带会话取 Blob，不走公开直链。
- Markdown 正文用 `v-html` 渲染，但原始 HTML 在管线第一步就被丢弃，再叠一层 `rehype-sanitize` 白名单；留言正文按纯文本渲染。
- `index.html` 已加 `noindex`；建议再用 Nginx 或 Cloudflare Access 限制来源。

## 发布与冲突的处理方式

- 打开发布面板会先跑预检，把 `checkId` 与当时的 `baseRevision` 绑定；面板打开期间**暂停自动保存**，否则 revision 一变，`checkId` 就必然过期。
- 每个私密资源必须逐项选择 `keep-private` / `copy-public` / `make-public`，没有默认值，未选完不能提交。
- `CHECK_EXPIRED`：自动重新预检并提示再确认一次；`REVISION_CONFLICT`：关闭面板、拉取最新数据、重新打开，绝不覆盖别人的改动。

## 主题

- `src/style/entro.scss`：只覆盖 CSS 变量与少量选择器（Element Plus 的 `--el-*`、Pure Admin 的 `--pure-theme-*`），令牌值与前台 `tokens.css` 一致，前台改色时这里同步改。
- 主色（金色）来自 `public/platform-config.json` 的 `EpThemeColor`，整体 `OverallStyle: "dark"`；金色底上的文字用深墨色，不用白字。
- 登录页左侧的「星核」（`src/utils/coreGlow.ts`，纯 canvas 2D）：缓慢自转的倾斜星盘、中心恒星、日冕光芒，参数可在 `startCoreGlow(canvas, options)` 调；系统开启「减少动态效果」时只画静态一帧，小屏隐藏。
- `src/style/fonts.css` + `src/assets/fonts/entro-serif/`：从前台复制的 Entro Serif 分片字体（Noto Serif CJK 子集，OFL），按 `unicode-range` 按需下载。

## 部署

当前生产形态：独立子域名，根路径。

```bash
pnpm install --frozen-lockfile
pnpm build:admin:subdomain          # 读 .env.admin-subdomain
rsync -a --delete dist/ /srv/entroaxiom/admin/
```

- Nginx：独立 `server` 块，`root /srv/entroaxiom/admin`，`/api/` 反代到同一个 `127.0.0.1:8000`，`/static/` 长缓存、`index.html` 不缓存。
- 后端必须把 `https://admin.entroaxiom.com` 写进 `ALLOWED_ORIGINS`，否则写请求全 403（Origin 校验）。
- 完整片段与自检命令见 [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)。

## 文档

| 文件 | 内容 |
| --- | --- |
| [`docs/ADMIN_API.md`](docs/ADMIN_API.md) | 接口契约：字段、错误码、revision 并发、资源鉴权、发布与版本规则 |
| [`docs/ADMIN_UI.md`](docs/ADMIN_UI.md) | 页面行为、编辑器状态机、发布与冲突流程、替身边界 |
| [`docs/ACCEPTANCE.md`](docs/ACCEPTANCE.md) | 逐条验收记录与命令结果 |
| [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) | 子域名与子路径两种部署方式 |
| [`docs/DELIVERY.md`](docs/DELIVERY.md) | 文件变更摘要、Markdown 方案、依赖说明 |

## 和原模板相比改了什么

- 不再使用模板的 `vite-plugin-fake-server`：插件没有接进 `build/plugins.ts`，`mock/` 目录也已移除。原模板的 mock 由插件在 **vite 配置层面**注入，`pnpm build` 也会生效，任何用户名都能"登录"；现在的替身是 `src/mock/` 里一个 axios adapter，只在开发环境按 `VITE_MOCK` 动态 `import()`，生产构建里既不会执行、也检索不到入口。`package.json` 里还留着 `vite-plugin-fake-server` 这条依赖没删（死依赖，不影响构建，下次 `pnpm install` 时可以顺手清掉）。
- 登录页不再预填账号密码。
- `src/utils/http`：加 `baseURL`；把 `{success,data,error}` 信封拆成载荷；失败整理成 `ApiError`；401 只刷新一次并释放排队请求；会话失效只提示一次。
- 菜单改为静态路由（`src/router/modules`），不再请求 `/get-async-routes`；删除了模板的演示页。
- 新增整套业务页与 API 模块（清单见 [`docs/DELIVERY.md`](docs/DELIVERY.md)）。
- Markdown 改用与前台同一套 `unified` 管线，不再引入第三方 Vue 渲染组件。
- 清空通知栏演示数据；页脚、标题、图标换成 entroaxiom 的。
- `.env.staging` 不再从第三方 CDN 加载脚本；Dockerfile 的 Node 版本与 `.nvmrc` 对齐。
- `src/assets/iconfont/iconfont.js`：`vite-plugin-remove-console` 会把 `console && console.log(t)` 删成非法表达式导致生产构建失败，已改写该行。
- `package.json` 的 `name` 从模板的 `pure-admin-thin` 改为 `entroaxiom-admin`（`version` 保持模板的 6.2.0）。

## 已知限制

- 没有组件级测试（Vue Test Utils 未接入）：门禁靠类型检查、构建、以及三套源码/替身级的 smoke 与回归断言；真实交互靠浏览器人工走查。
- `lint:check` 只覆盖 `src/**` 与 `scripts/**`，README 与本目录下的 `docs/*.md` 不在检查范围内（中文自然段会被 `printWidth` 切碎），排版是手写的。

## 许可

MIT（继承 pure-admin-thin，见 `LICENSE`）。主题、业务页面与接口封装为本项目新增。
