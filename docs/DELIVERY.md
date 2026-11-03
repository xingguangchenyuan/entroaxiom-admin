# 交付说明与文件变更摘要（DELIVERY）

基线：`entroaxiom-admin-20261030d.zip`（pure-admin-thin v6.2.0）。本目录是它的完整可运行源码，原压缩包未被覆盖。
交付包：`entroaxiom-admin-20261031-v3.zip`（根目录 `entroaxiom-admin/`，不含 `node_modules`、`dist`、`.git`；为本轮 R1–R4 修复后的最终包，替换 `20261031-v2.zip`；更早的 `20261030e.zip` 缺少验收记录与格式检查，`20261031.zip`、`20261031-final.zip` 为上一轮修复前/中间版本，均以 v3 包为准）。

## 1. 交付内容一览

| 类别 | 位置 | 说明 |
| --- | --- | --- |
| 页面 | `src/views/{welcome,content,library,shelf,guestbook,moderation,imports}` | 概览、内容列表/编辑器、文件库、书影音、留言、过滤规则、导入向导 |
| 共用组件 | `src/components/Manager/` | 10 个：`PageHeader`、`StatusPill`、`EmptyState`、`AssetImage`、`AssetPickerDialog`、`MarkdownView`、`MarkdownEditor`、`PublishDialog`、`ConflictDialog`、`VersionHistory` |
| 组合式函数 | `src/composables/` | `usePagedList`（分页筛选 + 竞态保护）、`useUnsavedGuard`（离开确认，支持「暂存成功才离开」的返回值语义）、`useAuthMedia`（鉴权媒体 URL） |
| 请求层 | `src/api/` | 8 个模块 + 7 个类型文件（`content`/`file`/`shelf`/`guestbook`/`moderation`/`imports`/`common`） |
| HTTP / 安全 | `src/utils/http/{index,error,types}.ts`、`src/utils/{auth,session,media,draftVault,mitt,format}.ts` | 统一信封脱壳、`ApiError`、401 刷新去重、会话失效广播、私密资源内存缓存、草稿仓 |
| 编辑态工具 | `src/utils/{editableSnapshot,saveQueue}.ts` | `editableArticleSnapshot`（可编辑字段统一归一化比较，脏状态与草稿恢复同一标准）、`createSaveQueue`（保存串行化 + `awaitIdle`） |
| Markdown | `src/utils/markdown/index.ts` | unified 管线（详见 §3） |
| 路由 | `src/router/modules/*.ts` | 6 个菜单模块，静态路由（不再请求异步路由接口） |
| 开发替身 | `src/mock/` | `adapter.ts`（30+ 端点）、`db.ts`（种子数据）、`zip.ts`（无依赖 ZIP 读写）、`index.ts`（安装入口） |
| 脚本 | `scripts/mock-smoke.mjs`、`scripts/render-smoke.mjs`、`scripts/v3-regression.mjs` | 188 条接口/状态断言（含 §8.1 导入字段往返）、32 条渲染断言（含 §5b 附件链接）、30 条 R1–R4 回归断言（快照归一化 / 保存串行化 / 草稿键语义） |
| 文档 | `docs/ADMIN_API.md`、`docs/ADMIN_UI.md`、`docs/ACCEPTANCE.md`、`docs/DELIVERY.md` | 接口契约、界面说明、验收记录、本文件 |

## 2. 主要页面与调用链路

| 页面 | 路由 | 关键行为 |
| --- | --- | --- |
| 概览 | `/welcome` | 统计、最近草稿、快捷入口；`capabilities` 读不到时提示能力兜底 |
| 内容列表 | `/content/notes`、`/content/essays` | 关键词/状态/权限/分类/标签/「只看有未发布修改」；新建即时落私密草稿；删除前取 revision |
| 编辑器 | `/content/{res}/{id}` | 自动保存（2.5 s）+ 草稿仓（800 ms）、手动保存（返回明确结果并串行化）、并排/编辑/预览、发布预检→发布、撤回发布、改可见范围、历史版本、导出 md/zip、删除；发布/撤回/改可见范围的成功回执**只刷新服务端详情，不覆盖未保存输入**；恢复历史版本前先确认、再把当前编辑内容存成服务端工作稿，然后用最新 revision 恢复（被替换的稿保留在历史里） |
| 文件库 | `/library` | 拖拽上传队列（并发/取消/进度）、重命名与说明、权限、引用清单、删除拦截 |
| 书影音 | `/shelf` | 列表 + 抽屉编辑，消费状态与发布状态分离，封面走资源选择器；离开/关闭抽屉时「暂存草稿并离开」会**先写进本地草稿再关**，写入失败则取消离开；再次打开该条目（或新建）时询问是否恢复 |
| 留言 | `/guestbook` | 列表 + 详情抽屉，回复/修改回复/删除回复、状态切换、命中证据、IP 只显示哈希前缀 |
| 过滤规则 | `/moderation` | 规则 CRUD + 启用开关 + 样例测试（`contains`/`exact`，字段 `name`/`body`） |
| 导入向导 | `/imports` | 上传预检 → 候选选择/元信息修改（含 ID、展示更新日期、随笔心境/地点）/资源决策 → 提交，支持 `.md` 与 `.zip`；frontmatter 的 `id/updated/mood/place` 全程保留 |

## 3. Markdown 方案与新增依赖

前台是 React，用 remark/rehype 渲染；后台是 Vue，为了让**编辑器预览与前台完全一致**，选了同一套 `unified` 管线，而不是引入第三方 Vue Markdown 组件：

```
remark-parse → remark-gfm → remark-math
  → remarkAssetRefs（把 asset:<fileId> 转成 data-asset-id 占位图）
  → remark-rehype（不开 allowDangerousHtml：原始 HTML 一律丢弃，与前台一致）
  → rehype-slug → rehype-katex → rehype-sanitize（白名单，clobber 前缀关掉以保留锚点 id）
  → rehype-stringify
```

要点：

- 原始 HTML 不解码，脚本类内容从源头就不进 DOM；再叠一层 `rehype-sanitize` 兜底（KaTeX 的 MathML 与 `class`/`style` 显式放开）。
- `clobberPrefix: ""`：默认会加 `user-content-` 前缀，导致锚点与前台对不上。
- `singleTilde: false`：避免 `~文本~` 被当成删除线，与前台一致。
- 私密图片写成 `asset:<fileId>`，渲染成 1×1 占位图 + `data-asset-id`，组件再用鉴权接口换 Blob URL；因此正文可以安全地复制、导出、导入。
- 私密**附件**写成 `[文件名](asset:<fileId>)`：`remarkAssetRefs` 保留 `asset:` href 并加 `data-asset-id`，`rehype-sanitize` 的协议白名单放行 `asset`，预览组件把这类链接渲染成「下载附件」并走鉴权下载（`MarkdownView.onRootClick` → `fetchFileBlob` + `saveBlob`）。

新增运行时依赖：`unified`、`remark-parse`、`remark-gfm`、`remark-math`、`remark-rehype`、`rehype-slug`、`rehype-katex`、`rehype-sanitize`、`rehype-stringify`、`katex`、`diff`、`unist-util-visit`。
新增开发依赖：`@types/hast`、`@types/mdast`、`@types/unist`、`@types/katex`，以及补齐模板缺失的 stylelint 工具链（`stylelint-config-standard`、`stylelint-config-html`、`stylelint-scss`、`stylelint-order`、`stylelint-prettier`、`postcss-html`、`postcss-scss`）。

## 4. 对模板既有文件的改动

| 文件 | 改动 |
| --- | --- |
| `src/utils/http/index.ts` | 响应拦截器统一脱信封（`unwrapEnvelope`）、401 刷新去重与排队请求失败即释放、`blob/upload/put/patch` 辅助方法、`setHttpAdapter` 注入点 |
| `src/utils/http/error.ts` | 新增 `ApiError`、`envelopeError`、`unwrapEnvelope`、字段错误提取、revision 冲突判定 |
| `src/store/modules/user.ts` | `logOut(reason)`、令牌只留 cookie、登录/刷新读 `accessToken` |
| `src/main.ts` | `VITE_MOCK === "true"` 时动态装入开发替身（生产构建不引用） |
| `src/assets/iconfont/iconfont.js` | `catch (t) { console && console.log(t); }` → `catch (t) { void t; }`：`vite-plugin-remove-console` 删调用后留下了非法表达式，会中断生产构建 |
| `types/global.d.ts`、`types/router.d.ts` | 补 `VITE_MOCK` 与路由 `meta.res` |
| `package.json` | `dev`/`build` 改为直接调 vite（Windows 下 `NODE_OPTIONS=` 前缀不生效），新增 `mock:smoke`、`render:smoke`、`verify`、`lint:check`（只读复核）；`lint` 不再嵌套调用 `pnpm`（本环境 PATH 无 pnpm，嵌套会失败） |
| `.env.development` | 新增 `VITE_MOCK = true`（生产/预发未设置） |
| `src/style/index.scss` | 引入 `workspaces.scss` |
| `src/style/dark.scss` | 两行 Sass 变量插值（`border-right/left: 1px solid $border-style`）加 `stylelint-disable-next-line`（规则误报非值非法） |
| `README.md` | 补充替身开关、验证命令、文档索引与存储说明 |

未改动：整体框架、构建配置（除上文 iconfont 注释）、Element Plus 主题生成方式、既有登录页与星仪主题令牌。

## 5. 验证与打包

```bash
pnpm install
pnpm typecheck   # 0 error
pnpm mock:smoke  # 188/188
pnpm render:smoke# 32/32
pnpm v3:regression # 30/30
pnpm lint:check  # eslint + prettier --check + stylelint 全绿
pnpm build       # 5.44 MB
```

逐条验收记录、未执行项与后端阻塞清单见 [`docs/ACCEPTANCE.md`](ACCEPTANCE.md)；接口契约见 [`docs/ADMIN_API.md`](ADMIN_API.md)；界面与替身用法见 [`docs/ADMIN_UI.md`](ADMIN_UI.md)。

**第一轮已做**：浏览器人工走查与九类截图（Edge + BrowserSkill 0.4.0，`pnpm dev` 开发替身，见 `docs/ACCEPTANCE.md` §4），走查中发现并修复五个单页路由不可达的缺陷（见 §5.1）。

**第二轮已做（2026-10-31 追加）**：八项疑似缺陷逐条审计并修复（§5.9）——发布/撤回误标「已保存」、离开未保存内容不存草稿、恢复版本前未保存保护、编辑器附件选择器（pdf/doc/zip）、预览 `asset:` 附件下载链接、导入表单 `id/updated/mood/place` 字段、frontmatter 字段解析/导出/提交保留、同 ID 冲突检测。代码 + 冒烟（188/32）+ 浏览器复验通过，新增三张截图（`12-attachment-picker.png`、`13-import-fields.png`、`14-preview-attachment.png`）。

**第三轮已做（2026-11-01 追加）**：按 `ENTROAXIOM-后台v2修复执行方案-20261031.md` 修复四项遗留缺陷 R1–R4，逐条见 §6；验收矩阵 V01–V14 与命令记录见 [`docs/ACCEPTANCE.md`](ACCEPTANCE.md) §5.10。

**三轮均未做**：真实后端联调（L3），以及键盘操作矩阵、破坏性按钮流的实际确认、跨标签页退出、弱网场景。原因与残余项见 `docs/ACCEPTANCE.md` §2.4、§5。

## 6. 第三轮（v3）：R1–R4 修复明细

基线是 `entroaxiom-admin-20261031-v2.zip`。四条缺陷都先读代码确认成立再改；改动的文件集中在 `src/views/content/edit.vue`、`src/components/Manager/VersionHistory.vue`、`src/composables/useUnsavedGuard.ts`、`src/views/shelf/index.vue`，并新增两个小工具与一个回归脚本。

| 编号 | 修复前的问题 | 修复后的行为 | 修改文件 |
| --- | --- | --- | --- |
| **R1** 权限回执被当成「清脏」布尔参数 | `reloadAfterMutation(cleanAfter = false)` 曾接收 `PublishDialog` 抛出的**事件对象**（真值），改可见范围成功后把当前未保存表单写成 `originalSnapshot`，界面显示「已保存」 | 去掉该形参，`reloadAfterMutation()` 只刷新服务端详情，不碰 `originalSnapshot`/`saveState`；可见范围改绑命名函数 `onVisibilityApplied()`，发布改绑 `onPublished()`（只有 `!dirty` 才更新快照）；刷新失败给 warning 且**保持未保存**；撤回发布补「响应是否属于当前文章」守卫；三条回执路径都过期响应丢弃 | `src/views/content/edit.vue` |
| **R2** 恢复历史版本不保护当前内容 | 组件自己弹确认后立刻发恢复请求；父页面在**恢复成功之后**才问「是否暂存」，关闭提示仍继续覆盖；`save()` 排队时提前返回，`await save()` 并不等于保存完成 | 保护前移到请求之前：组件通过可等待的 `beforeRestore()` 回调让父页面先完成「确认 → 保存当前稿 → 拿到最新 revision」；`save()` 改为返回 `saved/dirty/skipped/error/conflict` 并串行执行（`createSaveQueue`），新增 `ensureSaved()`、`awaitSaveIdle()`；恢复期间暂停自动保存定时器、阻止重复恢复；成功后应用返回的新工作稿并清本地草稿 | `src/views/content/edit.vue`、`src/components/Manager/VersionHistory.vue`、`src/utils/saveQueue.ts`（新增） |
| **R3** 草稿只比较标题与正文 | `offerDraft()` 用标题+正文判「无差异」，只改了摘要/分类/标签/日期的草稿被当作冗余直接删除；确认框 `catch` 不分取消与关闭，一律删草稿 | 新增 `editableArticleSnapshot()` 统一归一化比较（标题/摘要/分类/标签/日期/展示更新日期/正文全参与，随笔另加心境/地点；可选字段 null 与空串统一；标签 trim 去空但不排序；正文不 trim；revision/时间戳/权限/发布状态不参与）；只有全部一致才自动清理；只有明确「丢弃」才删，关闭/Esc 保留 | `src/utils/editableSnapshot.ts`（新增）、`src/views/content/edit.vue` |
| **R4** 书影音「暂存草稿并离开」未兑现 | `useUnsavedGuard.onLeave` 无返回值、守卫默认放行；`shelf/index.vue` 既没传 `onLeave` 也没有任何草稿读写 | 守卫支持 `onLeave` 返回 `false` 即取消离开（提示「暂存失败，已取消离开。请检查后再试。」）；书影音接入草稿仓：条目键 `ea:draft:shelf:<id>`、新建键 `ea:draft:shelf:new`，编辑中 800 ms 防抖暂存，打开条目/新建时先载服务端数据再询问恢复，创建成功后清理新建键（键转换），保存成功只清「本次真正保存且与表单一致」的草稿；关闭抽屉统一走 `requestClose()`，X/遮罩/Esc/底部按钮只确认一次 | `src/composables/useUnsavedGuard.ts`、`src/views/shelf/index.vue` |

兼容性与边界：

- 草稿仓仍是 `sessionStorage`（`ea:draft:` 前缀、12 小时 TTL、2 MB 上限），没有引入 `localStorage`/IndexedDB/Service Worker；旧的 v2 草稿数据可直接读取（缺失的可选字段按空串归一化）。
- 没有改动接口契约：`restoreVersion` 的入参/返回、`PATCH visibility`、`publish/unpublish` 都保持原样，`docs/ADMIN_API.md` 未改。
- 没有新增每次敲字的历史版本、没有新增草稿中心页面、没有暗中发布条目，消费状态与发布状态仍相互独立。
- 保存/恢复的通信方式与草稿生命周期有变化，已同步 `docs/ADMIN_UI.md`。
- 为制造「保存不成功」的前置，验收期间临时代替身加过 `__v3BlockArticleSave` 拦截开关，**已删除**；`dist` 检索无残留，生产构建不引用替身。
