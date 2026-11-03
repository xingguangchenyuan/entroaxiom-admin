# entroaxiom 管理后台

[entroaxiom 站点](../entroaxiom-site-v3) 的内容管理后台，基于 [pure-admin-thin](https://github.com/pure-admin/pure-admin-thin)（Vue 3 + Vite + Element Plus + TypeScript + Pinia + Tailwind，MIT 许可，见 `LICENSE`）。

前台是 React 项目，后台是独立的 Vue 项目，两者只通过后端接口 `/api/admin/*` 打交道。接口约定见 [`docs/ADMIN_API.md`](docs/ADMIN_API.md)。

## 运行

```bash
pnpm install           # 必须用 pnpm（preinstall 会拦截 npm / yarn）；Node 见 .nvmrc
pnpm dev               # http://localhost:8848，/api 由 Vite 转发到 http://127.0.0.1:8000
pnpm build             # 产物在 dist/
pnpm typecheck         # tsc + vue-tsc
pnpm mock:smoke        # 开发替身的接口与状态断言（188 条）
pnpm render:smoke      # Markdown 渲染管线断言（32 条，含 XSS 清洗）
pnpm v3:regression     # R1–R4 回归断言（30 条：字段快照归一化 / 保存串行化 / 草稿键语义）
pnpm verify            # 上面四项串起来跑
pnpm lint:check        # eslint + prettier --check + stylelint（只读复核；pnpm lint 是写入模式）
```

不开后端也能把界面跑起来：`.env.development` 里默认 `VITE_MOCK = true`，见下文「开发替身」。

## 配置

| 变量 | 作用 | 默认 |
| --- | --- | --- |
| `VITE_API_BASE` | 管理接口前缀（`.env`） | `/api/admin` |
| `VITE_MOCK` | 是否装入开发测试替身（**只允许在开发环境开启**） | 开发 `true`，生产/预发未设置 |
| `VITE_DEV_BACKEND` | 开发时 `/api` 转发到的后端（`.env.development`，需要改端口时取消注释） | `http://127.0.0.1:8000` |
| `VITE_PUBLIC_PATH` | 部署路径；挂在子路径时同时改 `VITE_ROUTER_HISTORY`（子路径直接用 `pnpm build:admin`） | `/` |
| `VITE_ROUTER_HISTORY` | 路由模式：`hash`（默认，静态托管无需回退规则）或 `h5`；子路径写 `hash,/admin/` | `hash` |
| `VITE_CDN` | 打包时是否改用第三方 CDN 的脚本（建议一直为 `false`） | `false` |

运行时界面配置（标题、主题、布局等）在 `public/platform-config.json`。

### 部署到独立子域名 `admin.entroaxiom.com`

当前生产形态：后台走自己的子域名，根路径就是 `/`。

```bash
pnpm install --frozen-lockfile
pnpm build:admin:subdomain   # 读 .env.admin-subdomain
```

- 产物：`dist/`（整个目录复制到 `/srv/entroaxiom/admin`）
- 资源前缀：`/static/...`（`index.html` 里不会出现 `/admin/static/...`）
- Nginx：独立 `server` 块，`root /srv/entroaxiom/admin`，`/api/` 反代到同一个 `127.0.0.1:8000`
- 后端必须把 `https://admin.entroaxiom.com` 写进 `ALLOWED_ORIGINS`，否则写请求全 403
- 自检：`grep -o 'src="[^"]*"' dist/index.html` 应看到 `/static/js/index-*.js`；`grep -c '/admin/' dist/index.html` 应为 0

完整片段见 [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)。

### 部署到 /admin/ 子路径（备选）

```bash
pnpm build:admin   # 读 .env.admin：VITE_PUBLIC_PATH=/admin/、VITE_ROUTER_HISTORY="hash,/admin/"
```

两个值必须同时改：只改前者，路由全 404；只改后者，`index.html` 还去域名根找 `/static/...`，白屏。
Nginx 的 `location /admin/` 要用 `alias`（不是 `root`），完整片段与自检命令见
[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)。

## 开发替身（VITE_MOCK）

后端还没就绪时，用一套内存替身把后台跑起来：任意账号、密码 ≥ 6 位即可登录，数据只在内存里（刷新即重置）。

- 入口：`src/mock/index.ts`；端点实现：`src/mock/adapter.ts`；种子数据：`src/mock/db.ts`；ZIP 读写：`src/mock/zip.ts`。
- 只通过 `src/main.ts` 里的 `import.meta.env.VITE_MOCK === "true"` 动态 `import()` 装入，**生产构建里不会引用**（`dist/` 中检索 `mockAdapter` 为 0 命中）。
- 故意包含失败分支：`409 REVISION_CONFLICT`、`409 FILE_IN_USE`、`404 NOT_PUBLISHED`、`404 MOCK_NOT_IMPLEMENTED`，方便验证错误态。
- 生产接入：把 `VITE_MOCK` 删掉或设为 `false`，配置 `VITE_API_BASE`（以及可选的 `VITE_DEV_BACKEND`）即可走真实接口。

## 文档

| 文件 | 内容 |
| --- | --- |
| [`docs/ADMIN_API.md`](docs/ADMIN_API.md) | 接口契约：字段、错误码、revision 并发、资源鉴权、发布与版本规则、待后端实现清单 |
| [`docs/ADMIN_UI.md`](docs/ADMIN_UI.md) | 页面行为、编辑器状态机、发布与冲突流程、替身边界、验收顺序 |
| [`docs/ACCEPTANCE.md`](docs/ACCEPTANCE.md) | AC-01～AC-30 逐条记录、命令结果、未执行项与原因、后端阻塞清单 |
| [`docs/DELIVERY.md`](docs/DELIVERY.md) | 文件变更摘要、Markdown 方案、新增依赖、打包说明 |

## 和原模板相比改了什么

- 删除了 `mock/` 和 `vite-plugin-fake-server`（原模板在**生产构建里也会启用** mock，任何用户名都能"登录"）。现在的替身在 `src/mock/`，只在开发环境按 `VITE_MOCK` 显式开启。
- 登录页不再预填账号密码。
- `src/utils/http`：加了 `baseURL`；统一把 `{ success, data, error }` 信封拆成载荷（`error.ts` 的 `unwrapEnvelope`）；失败整理成 `ApiError`；401 时只刷新一次并把排队请求一起释放，刷新失败才回登录页。
- 菜单改为静态路由（`src/router/modules`），不再请求 `/get-async-routes`；删除了演示页（权限、异常页之外的示例）。
- 新增整套业务页：概览、内容列表与编辑器、文件库、书影音、留言、过滤规则、导入向导，以及对应的 API 模块、共用组件与组合式函数（清单见 [`docs/DELIVERY.md`](docs/DELIVERY.md)）。
- Markdown 改用与前台同一套 `unified` 管线（remark/rehype + KaTeX + sanitize），不再引入第三方 Vue 渲染组件。
- 清空了通知栏的演示数据（里面有指向第三方站点的头像地址）；页脚、标题、图标换成 entroaxiom 的。
- `.env.staging` 不再从第三方 CDN 加载脚本；Dockerfile 的 Node 版本与 `.nvmrc` 对齐。
- `src/assets/iconfont/iconfont.js`：`vite-plugin-remove-console` 会把 `console && console.log(t)` 删成非法表达式，导致生产构建失败，已改写该行。

## 外观（星仪主题）

后台的外观与前台保持一致：深空底色、骨白文字、恒星金作主色、玻璃质感的卡片，标题用 Entro Serif。

- `src/style/entro.scss`：主题本体。只覆盖 CSS 变量和少量选择器（Element Plus 的 `--el-*`、Pure Admin 的 `--pure-theme-*`），不改组件结构；令牌值与前台 `tokens.css` 一致，前台改色时这里同步改。
- 主色（金色）来自 `public/platform-config.json` 的 `EpThemeColor`，由模板的 JS 生成整套深浅梯度；整体风格 `OverallStyle: "dark"`。
- 金色底上的文字（主按钮、选中的复选框 / 单选、分页当前页、日期选中）统一用深墨色，不用白字（白字在金色上对比度不够）。
- 登录页（`src/views/login`、`src/style/login.css`）固定为深色，不随全局明暗切换，所以去掉了登录页的主题开关。
- 登录页左侧是「星核」（`src/utils/coreGlow.ts`，纯 canvas 2D，不依赖 Vue；组件 `src/views/login/components/LoginGalaxy.vue`）：缓慢自转的倾斜星盘（约 1.6 万粒子，预渲染成一张图，每帧只做一次旋转绘制）、中心恒星、日冕细光芒、四角星耀斑。画法和参数与设计稿 `core-glow.html` 一致，可在 `startCoreGlow(canvas, options)` 里调（`count / tilt / tiltAngle / spin / arms / seed / flare / rays`）。画布是正方形，大小跟随所在列宽并不超过视口高度，窗口缩放自动重画；小屏下被隐藏（尺寸为 0）时暂停绘制；系统开了「减少动态效果」时只画静态一帧。
- `src/style/fonts.css` + `src/assets/fonts/entro-serif/`：从前台复制的 Entro Serif 分片字体（Noto Serif CJK 子集，OFL 许可，见 `public/licenses/`），按 `unicode-range` 用到哪个区段才下载。Cinzel / JetBrains Mono 没有打包，走系统回退；想要和前台完全一致，可以 `pnpm add @fontsource/cinzel @fontsource/jetbrains-mono` 后在 `main.ts` 里引入。
- 设置面板里仍可以切换浅色模式和导航主题：切到浅色后会回到 Pure Admin 原本的样子（星仪主题只在深色下生效）。如果要彻底锁死深色，可以把设置面板里的相关开关删掉。

## 安全说明

- 前端的登录状态和角色判断只是界面层的便利，**真正的鉴权必须在后端**：每个 `/api/admin/*` 都要校验令牌和角色。
- 令牌：access / refresh token 由后端下发，前端只把 refresh token 留在 cookie 里，`localStorage` 的 `user-info` 不再存令牌；会话失效时（主动退出或被动过期）会广播事件，清掉私密资源缓存与草稿。想更稳可以改成 HttpOnly cookie 会话，需要改 `src/utils/auth.ts` 与 `src/utils/http`。
- 私密资源（图片/PDF）不通过公开直链访问：正文里写 `asset:<fileId>`，渲染时换成占位图，再由 `GET /files/{id}/content` 带令牌取 Blob。后端必须校验会话，且不要给 `/api/admin/*` 开 `Access-Control-Allow-Origin: *`。
- Markdown 正文用 `v-html` 渲染，但**原始 HTML 在管线的第一步就被丢弃**，再叠一层 `rehype-sanitize` 白名单（`pnpm render:smoke` 里有脚本注入、`javascript:` 链接、`iframe` 的断言）。留言正文则完全按纯文本渲染，不用 `v-html`。
- 不要把管理端挂在公开可被搜索引擎收录的路径上（`index.html` 已加 `noindex`），建议再用 Nginx 做访问限制。

## 已知限制

- 真实后端未联调（L3）；浏览器人工走查与九类截图已完成（见 [`docs/ACCEPTANCE.md`](docs/ACCEPTANCE.md) §4），残余项为键盘操作矩阵、破坏性按钮流的实际确认、跨标签页退出与弱网场景（§5）。
- `docs/*.md` 与 `README.md` 不纳入 `prettier --check`（中文自然段会被 `printWidth` 切碎），正文排版是手写的。

