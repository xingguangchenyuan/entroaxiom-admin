# entroaxiom 管理后台 · 界面与工程说明

这份文档讲**界面怎么用、代码怎么组织、本地怎么跑**。接口契约见 [ADMIN_API.md](./ADMIN_API.md)。

## 1. 技术底座

- 基于 `pure-admin-thin` v6.2.0：Vite 7 + Vue 3.5 + TypeScript 5.9 + Element Plus 2.11 + Pinia 3 + Tailwind 4。
- Node `^20.19 || >=22.13`（`.nvmrc`），pnpm ≥ 9。
- 新增依赖只有渲染管线需要的几个：`unified` `remark-parse` `remark-gfm` `remark-math` `remark-rehype` `rehype-slug` `rehype-katex` `rehype-sanitize` `rehype-stringify` `katex` `diff` `unist-util-visit`。
- 开发时 `/api` 由 Vite 代理到后端（`VITE_DEV_BACKEND`，默认 `http://127.0.0.1:8000`）；线上是同源 `VITE_API_BASE=/api/admin`。

## 2. 视觉基线「星仪」

前台与后台共用一套观感，令牌在 `src/style/entro.scss`，页面版式在 `src/style/workspaces.scss`。

| 令牌 | 值 | 用途 |
|---|---|---|
| `--void` | `#03040a` | 页面底色（接近真空） |
| `--abyss` / `--slab` | 更深／更浅的分层底 | 面板、抽屉、卡片 |
| `--bone` | `#efe8da` | 正文主色（暖白，不用纯白） |
| `--sol` | `#e9bd5e` | 强调色（日光金）：链接、当前项、关键按钮 |
| `--glacier` | 冷色 | 次要强调，用于"已发布"等状态 |
| `--ember` / `--aurora` / `--nebula` | 暖红／青／紫 | 危险、私密、提示 |
| `--line` / `--glass-fill` | 半透明描边／填充 | 分隔线与玻璃质感面板 |
| `--font-display` | `Entro Serif`（自托管分片，`src/assets/fonts/`） | 标题 |
| `--font-mono` | 等宽 | 元信息、版本号、日期 |
| `--font-sans` | 正文 | 界面文本 |

- 平台配置在 `public/platform-config.json`：`OverallStyle = dark`、`EpThemeColor = #e9bd5e`。
- 登录页单独一套（`src/views/login/index.vue` + `LoginGalaxy.vue` + `style/login.css`），有星场动效但没有多余装饰。

**约定**：后台不引入图表库、不铺渐变大色块；信息密度靠字号与留白分层，而不是靠色块和阴影。

## 3. 页面与行为

菜单顺序（`src/router/modules/*.ts` 的 `rank`）：内容 → 文件库 → 书影音 → 留言 → 规则 → 导入。

### 3.1 概览 `/welcome`

五个计数（随笔／笔记／书影音／文件／被拦截留言）、最近草稿（点进编辑器）、快捷入口。
能力接口没读到时，顶部出现一条"限制值未从服务端读到，正在用保守默认值"的提示——用提示条而不是禁用功能。

### 3.2 内容列表 `/content/notes`、`/content/essays`

两个资源共用 `src/views/content/list.vue`，只靠路由 `meta.res` 区分。

- 筛选项：关键字、发布状态、可见范围、归类、标签、"只看有未发布修改"。**"只看有未发布修改"关掉时不下发参数**（不是 `false`），避免后端把 `false` 当筛选条件。
- 列表行：标题（有未发布修改时带一个小圆点）＋摘要、归类、日期、两个状态标签（发布状态／可见范围）、更新时间、操作。
- 新建：只填标题与摘要，落库后直接跳编辑器（正文在编辑器里写）。
- 删除：列表行没有 `revision`，所以先 `GET` 详情拿 `revision` 再带 `If-Match` 删；遇到 `REVISION_CONFLICT` 提示"别人改过了"并刷新列表；删完如果当前页只剩空页会回退一页。
- "线上"抽屉直接看发布快照（`GET .../published`），走同一套 Markdown 渲染。

### 3.3 编辑器 `/content/{res}/{id}`

`src/views/content/edit.vue`，是这个后台最复杂的页面。

**布局**：粘性顶栏（返回 / 面包屑 / 保存状态 / 保存草稿 / 发布 / 更多）＋ 大标题输入 ＋ 三档视图切换（并排 / 只编辑 / 只预览）＋ 双栏。窄屏（< 1100px）默认只编辑。

**保存状态机**：

| 状态 | 界面文案 | 触发 |
|---|---|---|
| `idle` | 无 | 刚载入、没有改动 |
| `dirty` | 有未保存修改 | 任一字段变化 |
| `saving` | 保存中 | 正在请求 |
| `saved` | 已保存于 hh:mm:ss | 请求成功**且**这期间没有新改动 |
| `error` | 保存失败（草稿已留底） | 请求失败 |

- 自动保存：改动后 2.5 秒发一次 `saveMode: "auto"`；800 毫秒先把内容写进本地草稿仓。
- 串行化：`save()` 通过 `src/utils/saveQueue.ts` 的 `createSaveQueue()` 排队，同一时刻只有一个保存在飞，按序执行；`save()` 返回 `saved｜dirty｜skipped｜error｜conflict`，`await save()` 只代表这一条排队任务结束（要看结果看返回值）。`awaitSaveIdle()` 等到队列空，`ensureSaved()` 是「确认当前内容已保存到服务端」的唯一入口。
- 保存成功但期间又改了 → 状态保持 `dirty`，草稿保留，不会误显示"已保存"。
- 切到别的文章后，旧请求的响应直接丢弃（用 `forArticle`/`forRes` 比对），不会把 A 的响应写进 B。
- **权限类操作（发布／撤回／改可见范围）从不隐式清脏**：回执只刷新服务端详情（权限、`revision`、发布元信息、资源清单），编辑框里的未保存字段原样保留；只有自动保存/手动保存真的成功才更新"已保存"基准。刷新失败会提示并**保持**未保存状态，避免用错误 `revision` 静默覆盖。

**本地草稿仓**（`src/utils/draftVault.ts`）：`sessionStorage`，前缀 `ea:draft:`，TTL 12 小时，单条上限 2 MB。文章键为 `ea:draft:content:<res>:<id>`，书影音为 `ea:draft:shelf:<id>`，书影音新建为 `ea:draft:shelf:new`。载入时用 `src/utils/editableSnapshot.ts` 的 `editableArticleSnapshot()` 与服务端详情做**全字段归一化比较**（标题／摘要／分类／标签／日期／展示更新日期／正文，随笔另加心境／地点；空值统一、标签不排序、正文不 trim）——只有全部一致才自动清理冗余草稿，任一字段不同都会弹"恢复本地修改 / 丢弃本地修改"。关掉提示（关闭／Esc）**不等于丢弃**，草稿留着；只有明确点"丢弃"才删。写入失败（配额不足等）会返回 `false`，调用方据此取消离开。

**冲突**：保存返回 `409 REVISION_CONFLICT` → 拉取服务端详情 → 对话框三选一：

1. **看看差异**：`diff` 按行着色的红绿对比（标题／摘要也有差异摘要）；
2. **用我的覆盖**：把 `baseRevision` 换成服务端最新 `revision` 后重新保存（站长明确要覆盖）；
3. **放弃我的、载入服务端**：丢弃本地改动。

绝不自动覆盖，也不自动丢弃。

**发布**：`PublishDialog` 两步走，先预检再发布。预检结果按严重程度分组；私密资源逐项让站长选 `keep-private` / `copy-public` / `make-public`（默认 `copy-public`，因为不改变原文件权限）。"是否可继续"只看后端 `canProceed`，前端不自己猜。

**可见范围**：同一个对话框的 `action="visibility"` 模式，保存后**不产生新快照**；文案会明确写"发布只生成快照，前台仍看不到"（`visibility = private` 时）／"私密资源不会自动公开"。

**其它**：撤回发布、导出（Markdown / ZIP，工作稿或线上快照）、删除、文章信息抽屉（摘要／归类／标签／日期／情绪／地点 ＋ 引用资源清单）。标题 ≤ 200，正文上限取 `capabilities.content.maxBodyBytes`（用 `new Blob([body]).size` 算，超限拦手动保存并禁用发布）。

**离开保护**：`useUnsavedGuard` 同时挂 `beforeunload`（浏览器原生提醒）与路由守卫。守卫文案承诺"草稿已暂存"，所以确实**先写草稿仓、写成功才放行**：`onLeave` 返回 `false` 时守卫提示"暂存失败，已取消离开。请检查后再试。"并留在当前页（`onLeave` 抛错同样按失败处理）。取消/关闭确认框不算同意丢弃，草稿与表单都保持原样。

### 3.4 版本历史（编辑器抽屉）

左列版本列表（点开预览、不打断当前编辑），右列详情；"与当前稿对比"用 `diffLines` 做行级差异。

**恢复的顺序是"先保护、再恢复"**：点"恢复这个版本"时组件不发请求，而是 `await props.beforeRestore()`（父页面 `edit.vue` 编排）——

1. 有未保存修改时先确认，文案说明"恢复会先把它们保存为服务端工作稿（当前稿会保留在历史版本中），再用所选版本替换；线上发布内容和可见范围不变"，按钮"保存当前稿并恢复"/"取消"；没有未保存修改时也确认一次"恢复为新工作稿"。
2. 取消／关闭／Esc → `ok:false`，**不发恢复请求**，编辑框内容原样保留。
3. 确认后进入恢复事务：暂停自动保存定时器与本地草稿定时器、阻止重复恢复，等队列里在途的保存结束（`awaitSaveIdle()`），再走 `ensureSaved()` 手动保存；保存失败（校验失败／网络错误／会话失效／409 冲突）→ 停止，**不发恢复请求、不覆盖表单**，冲突按既有对话框处理。
4. 保存确认成功（且最新表单与已保存快照一致）才用**最新 `revision`** 调恢复接口；组件拿到结果后应用返回的新工作稿。

恢复不动线上快照也不动权限；被替换的当前稿由服务端留成 `preservedVersion`，历史列表里能找回。恢复失败不伪造成功、不自动重试覆盖。

### 3.5 文件库 `/library`

- 拖拽／选择上传，队列显示进度，可逐个取消（`AbortController`）；并发数取 `capabilities.upload.maxConcurrent`；扩展名与大小在入队时就按 capabilities 校验。
- 表格：名称／类型／大小／可见范围／引用数／更新时间／操作；详情抽屉里改名、改说明、改权限、看引用清单、删除。
- 删除被引用的文件 → `409 FILE_IN_USE`，抽屉里直接列出"被谁引用"（工作稿／线上快照／历史版本／书影音封面），并提供跳转。

### 3.6 书影音 `/shelf`

列表 + 右侧抽屉编辑（没有独立详情路由）。消费状态（已读／在读／想读）与发布状态分开显示；封面用 `AssetPickerDialog` 选文件库图片，存的是 `asset:<fileId>`，外部图直接填 `https://`（`referrerPolicy="no-referrer"`）。
封面是私密的、或被别的内容共享引用时，抽屉里会有单独提示；发布走和文章一样的预检 → 发布；改权限要求先保存（`dirty` 时禁用）。

**草稿与离开**：抽屉只有 `requestClose()` 一个关闭入口（X、遮罩、Esc、底部"关闭"按钮都走它），**一次关闭只弹一次确认**，取消后抽屉保持打开。确认"暂存草稿并离开"时**先写进 `sessionStorage` 草稿仓再关**：编辑中每 800 毫秒防抖暂存一次，键为 `ea:draft:shelf:<id>`，新建条目用 `ea:draft:shelf:new`（不和任何已有条目共用）。写入失败（配额不足等）→ 抽屉不关、提示"暂存失败，已取消离开。请检查后再试。"，表单内容原样保留，恢复存储后可重试。
再次打开该条目时先加载服务端数据，再用同一套字段快照比较本地草稿：全字段一致就静默清理，不一致才问"恢复本地修改 / 丢弃本地修改"——关掉提示不等于丢弃，草稿留着；只有明确"丢弃"才删。草稿基准 `revision` 落后时会额外提示服务端已有更新，由站长决定。新建草稿恢复后创建成功，会把新建键转成该条目的键并清掉，避免下次新建又冒出已经创建过的内容。保存成功只清"本次真正保存且与当前表单一致"的草稿；保存失败或请求期间又改了，草稿保留最新输入。退出登录会清空全部草稿。整个过程不会暗中发布条目，消费状态与发布状态仍相互独立。

### 3.7 留言 `/guestbook`

列表 + 详情抽屉。**正文一律纯文本渲染**（`white-space: pre-wrap` + `word-break: break-word`），邮箱只在详情里出现，IP 只展示哈希前 16 位并注明"仅哈希、不可反查"。
命中过滤规则的留言会展示证据快照（当时的规则文本、作用字段、匹配时间）；规则后来被删了也仍然解释得清。
回复是覆盖式写入，编辑中的回复也会进草稿仓（关抽屉时暂存，保存成功才清）；列表里的"直接改状态"因为列表项没有 `revision`，会先取详情拿 `revision` 再 `PATCH`。

### 3.8 规则 `/moderation`

规则表（词／分类／匹配方式／作用字段／启用开关／更新时间）＋ 样例测试面板。
开关是乐观切换、失败后以服务端为准重载列表。测试面板返回 `allowed` / 命中项 / 规范化后的输入（折叠展示）/ `policyVersion`。
**文案明确声明**：这是站长自维护的小词表，不是平台审核系统，不承诺全面拦截——避免给站长虚假的安全感。

### 3.9 导入 `/imports`

三步：上传预检 → 确认内容 → 完成。

1. 选类型（笔记／随笔），拖入 `.md` 或 `.zip`（≤ 40 MB），带进度与取消；
2. ZIP 多篇时必须先选一篇；可改标题／摘要／归类／标签／日期／正文；资源表按 `matched / unreferenced / missing / ambiguous / unsupported` 区分，只有 `unreferenced` 可以勾选"一起导入"；警告与 ID 冲突（选"更新"时必须指定目标）；
3. 结果页给出新建资源数、关联资源数、被保护下来的原版本，并提供"去打开发表"（导入不会自动发布）。

中途关闭会 `DELETE /imports/{id}` 释放临时区。

## 4. 代码结构

```
src/
  api/            契约层：types/ 定义形状，其余按资源分文件（content/file/shelf/guestbook/moderation/imports/user/capabilities）
  components/Manager/   业务组件：PageHeader、StatusPill、EmptyState、AssetImage、MarkdownView、MarkdownEditor、
                        AssetPickerDialog、PublishDialog、ConflictDialog、VersionHistory
  composables/    usePagedList（分页+竞态）、useUnsavedGuard（离开保护）、useAuthMedia（鉴权图片）
  mock/           开发替身：db.ts（内存种子）、adapter.ts（30+ 端点）、zip.ts（极简 ZIP）、index.ts（安装入口）
  router/modules/ 六个菜单模块
  store/modules/  user（会话）、capabilities（能力缓存）
  style/          entro.scss（令牌）、workspaces.scss（页面版式）
  utils/          http/（请求与错误）、markdown/（渲染管线）、draftVault、media、session、format、message
  views/          welcome / content（list+edit）/ library / shelf / guestbook / moderation / imports / login
scripts/mock-smoke.mjs  替身冒烟测试
docs/             本文件 + ADMIN_API.md
```

几个刻意的取舍：

- **统一脱壳在拦截器里做**，不在每个 api 函数里写 `.data`——漏一个就整页崩，集中一处更稳。
- **Markdown 渲染与前台同一条管线**：`unified` + `remark-gfm`（`singleTilde: false`）+ `remark-math` + `rehype-slug` + `rehype-katex`（`strict: "ignore"`）+ `rehype-sanitize`（扩展 schema 放行 MathML 与 `data-asset-*`，`clobberPrefix: ""` 让锚点 id 与前台一致）。**不开 `allowDangerousHtml`**，原来的 HTML 与前台一样被丢弃。
- 正文里的图片统一写 `asset:<fileId>`；渲染时先变成占位节点，再由 `media.ts` 换鉴权 blob URL，失败则显示"受限资源"占位。这样私密图片不会因为 `<img>` 不带 Authorization 而裂图。
- 表格在渲染后包一层 `.md-table-wrap` 允许容器内横滚，不撑破页面。

## 5. 本地开发与开发替身

```bash
pnpm install
pnpm dev          # http://localhost:8848/
pnpm typecheck    # tsc --noEmit && vue-tsc --noEmit --skipLibCheck
pnpm build        # rimraf dist && vite build
pnpm mock:smoke   # 开发替身冒烟测试（110 条断言）
```

**开发替身默认打开**：`.env.development` 里 `VITE_MOCK = true`，`src/main.ts` 会在建 store 之前动态 `import("@/mock")` 并 `setHttpAdapter(mockAdapter)`。改 `false` 就直连真后端（走 Vite 代理）。

- 登录：任意账号，密码 ≥ 6 位。
- 数据全在内存，刷新页面即回到种子状态（种子见 `src/mock/db.ts`：5 篇文章、6 个文件、4 条书影音、4 条留言、4 条规则）。
- 替身会主动 sleep 120–340ms，方便看加载态；未实现的端点会 `console.warn` 并返回 `404 MOCK_NOT_IMPLEMENTED`，不会假装成功。
- **生产包不含替身**：`VITE_MOCK` 只在 development 为 true，`dist` 里检索不到 mock 代码（已实测为 0 命中）。

`scripts/mock-smoke.mjs` 用 esbuild 把 `src/mock/adapter.ts` 打成一个临时模块再直接驱动适配器，覆盖：鉴权、能力、概览、文章筛选分页、并发冲突、发布预检、发布、撤回、版本与恢复、导出（md/zip 真解压校验）、文件上传与鉴权读取、引用清单、`FILE_IN_USE`、书影音、留言、规则与测试器、Markdown/ZIP 导入、未实现端点。

## 6. 验收与已知边界

已经过的验证：

- `pnpm typecheck` 通过（0 error）。
- `pnpm build` 通过，产物 5.44 MB（gzip 后主包约 432 kB），无 mock 残留。
- `pnpm mock:smoke` 110/110 通过。

**没做到的**：没有做真实浏览器的人工走查。本机缺少 `bsk` CLI，浏览器自动化插件无法启动守护进程（`cannot start an independent Windows daemon`），因此界面正确性是靠"类型检查 + 替身全端点断言 + 构建通过"间接保证的。第一次真机验收时，建议按这个顺序点一遍：

1. 登录 → 概览数字是否与库一致；
2. 内容列表筛选／分页／"只看未发布修改"；
3. 编辑器：改标题等 3 秒看自动保存、断网看失败提示、刷新页面看草稿恢复；
4. 两个标签页同时改同一篇 → 后保存的一方是否弹冲突对话框；
5. 发布预检里私密资源的三种决策、发布后前台是否可见；
6. 文件库删除被引用的文件是否给出引用清单；
7. 留言纯文本渲染（贴一段带 `<b>` 和 `<script>` 的文字，确认按文本显示）；
8. 导入一篇 `.md` 与一个含图片的 `.zip`。

已知取舍：

- 移动端只保证"能用"（窄屏默认单栏编辑），没有做专门的手机交互。
- 编辑器是原生 `textarea` + 工具条，不是所见即所得；换来的是与前台 100% 相同的渲染结果和零编辑器依赖风险。
- 没有做批量操作（批量删除／批量改权限），P0 阶段刻意留白。
- 字体用自托管分片，首次加载会有一次字体请求；没有做 `font-display` 之外的优化。

## 7. 一个构建坑（记录下来，避免重复踩）

`build/plugins.ts` 里的 `vite-plugin-remove-console` 用 AST 删除生产包里的 `console` 调用。`src/assets/iconfont/iconfont.js` 是模板自带的旧版脚本，其中有一句 `console && console.log(t);`，被删掉调用后变成 `console && ;`，导致 `vite build` 报 `Expression expected` 失败。
处理方式：把那句改成空处理（`void t;`，附注释说明原因）。以后再往仓库里塞第三方脚本时，先 grep 一遍 `console &&` 这种非调用写法。
