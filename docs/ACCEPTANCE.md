# 验收记录（ACCEPTANCE）

对应方案：`ENTROAXIOM-后台功能实施方案-20261030.md` 第 12–15 节。
记录时间：2026-10-31（P0 交付与八项缺陷修复）、2026-11-01（R1–R4 修复与 V01–V14 验收）。执行环境：Windows 11，Node v24.21.0，pnpm 11.28.5；浏览器走查用 Edge 156.0.0.0 + BrowserSkill 扩展 0.4.0（bsk CLI 0.4.0 / daemon 0.4.0 / protocol 1.7），驱动 `pnpm dev`（localhost:8848，开发替身），见 §4。

## 1. 结论

- 管理端 P0 阶段 A–F 的**页面与调用链路已实现完毕**，L1（构建/静态检查）与 L2（开发测试替身交互，覆盖请求与状态转换）通过。
- **真实后端联调（L3）未执行**：本机没有后端，也没有任何测试账号。因此结论只能写「管理端实现完成，真实后端联调待完成」，不能写「网站全部功能已可用」。
- **浏览器人工走查与截图已执行**（2026-10-31）：逐页走查登录、工作台、内容编辑（公式与图片预览）、私人阅读、版本历史与恢复、导入预检、文件详情、留言详情、过滤规则、窄屏，并产出方案 §13.3.5 要求的九类截图（见 §4）。
- 走查中**发现并修复一个真实缺陷**：五个单页路由父/子同路径导致 vue-router 只匹配父记录、页面永不渲染（详见 §5.1），修复后逐页复验通过。
- **八项疑似缺陷已逐条审计并修复**（2026-10-31 追加，对应 §5.9）：发布/撤回误标「已保存」、离开未保存内容不存草稿、恢复版本前不保护未保存工作稿、编辑器附件选择器缺失、预览不渲染 `asset:` 附件下载链接、导入表单丢 `id/updated/mood/place`、frontmatter 这些字段解析/导出不保留、同 ID 冲突不检测。逐条核实全部成立，代码 + 冒烟断言 + 浏览器复验（附件选择器、预览下载链接、导入字段回填与显式 ID 落库）均通过，并补了三张截图（§4 第 12–14 行）。
- **四项遗留缺陷 R1–R4 已按 v2 修复执行方案修复**（2026-11-01，对应 §5.10；基线 `entroaxiom-admin-20261031-v2.zip`）：权限回执被当成清除未保存状态的布尔参数（R1）、恢复历史版本前未把当前编辑内容先存成服务端工作稿（R2）、本地草稿只比较标题与正文因而误删元信息修改（R3）、书影音「暂存草稿并离开」未接入任何草稿写入与恢复（R4）。验收矩阵 V01–V14 逐条记录于 §5.10，浏览器实测 V01/V03/V04/V07/V08/V09/V10/V11/V12，其余以自动化与代码核对给出**有边界的结论**。
- **仍未执行**：真实后端联调（L3）。恢复保护的「被替换工作稿真实落库、历史保留策略、权限隔离」以及 revision 并发语义目前只在开发替身上验证过，不能宣称已上线可用。

## 2. 检查命令与结果

### 2.1 命令记录

| 命令 | 结果 | 说明 |
| --- | --- | --- |
| `pnpm install` | 通过 | 依赖与 `pnpm-lock.yaml` 一致；为跑通 stylelint 补装了 `stylelint-config-standard`、`stylelint-config-html`、`stylelint-scss`、`stylelint-order`、`stylelint-prettier`、`postcss-html`、`postcss-scss`（模板原本缺少这些包，`pnpm lint` 在基线里就跑不起来） |
| `pnpm typecheck` | **通过**（exit 0） | `tsc --noEmit && vue-tsc --noEmit --skipLibCheck` |
| `pnpm build` | **通过** | 产物 5.44 MB，`✓ built in 10.67s`（最终复核重跑）；主包 `dist/static/js/index-*.js` 1,291 kB（gzip 431.83 kB），`MarkdownView` chunk 464.90 kB（KaTeX + 管线，按需加载） |
| `pnpm mock:smoke` | **188/188 通过** | 直接驱动 `src/mock/adapter.ts`（esbuild 打包后在 Node 里跑），覆盖鉴权、分页筛选、并发冲突、发布/撤回、版本/恢复、导出、文件鉴权读取与引用、书影音、留言、规则、导入；含 §8.1「frontmatter id/updated/mood/place 导入→commit→落库→导出→再导入」往返与同 ID 冲突（28 条为八项缺陷修复新增） |
| `pnpm render:smoke` | **32/32 通过** | 跑真实 Markdown 管线：表格、任务列表、行内/块级公式、锚点 id、`asset:` 图片、XSS 清洗、脚注、`asset:` 附件链接（`[下载附件](asset:...)` 的 href 保留 + `data-asset-id`，3 条为修复新增） |
| `pnpm v3:regression` | **30/30 通过** | 本轮 R1–R4 新增的回归脚本（`scripts/v3-regression.mjs`）：`editableArticleSnapshot` 归一化比较（摘要/分类/标签/日期/`updated`/随笔心境地点任一不同即不同；笔记不混入随笔字段；正文不 trim；标签不排序；revision 不入差异）、`createSaveQueue` 串行化（同一时刻只有一个保存在飞、失败不破坏后续链、`awaitIdle` 等到最后一条）、`draftVault` 键语义（新建键 `ea:draft:shelf:new` 与条目键互不污染、写入异常返回 `false`、读写清除往返） |
| `pnpm verify` | **通过** | 上面四项的串联（typecheck → mock:smoke → render:smoke → v3:regression） |
| eslint（只读） | **0 问题** | `eslint --max-warnings 0 "src/**/*.{vue,ts}" "scripts/**/*.mjs" "build/**/*.ts"` |
| prettier `--check` | **通过** | 覆盖 `src/**/*.{ts,vue,scss,css,json}`、`scripts/**/*.mjs`；`docs/*.md` 与 `README.md` 未强制格式化（中文自然段会被 `printWidth` 切碎，见 §5） |
| stylelint | **0 问题** | `src/**/*.{vue,scss,css}`；模板的 `src/style/dark.scss:37,42` 曾报 `declaration-property-value-no-unknown`（Sass 变量插值 `1px solid $border-style`，规则误报），已在该两行加 `stylelint-disable-next-line` 并注明原因，现在整条链路为 0 |
| `pnpm lint:check` | **通过**（exit 0） | 只读串联：eslint（`--max-warnings 0`）→ prettier `--check` → stylelint，用于复现 §13.3.2 的三项检查 |
| 浏览器人工走查 + 截图 | **九类全部完成** | 登录/工作台/编辑预览（公式与图片）/私人阅读/版本恢复/导入预检/文件详情/留言详情/过滤规则/窄屏，截图清单见 §4 |
| `dist` 检索替身残留 | **0 命中** | 在 `dist/` 里检索 `MOCK_NOT_IMPLEMENTED` / `installMock` / `mockAdapter` 均无结果 |
| 交付打包 | **342 项 / 3.85 MB** | `D:\网页设计\entroaxiom-admin-20261031-v3.zip`（本轮 R1–R4 修复后的最终包，替换 `20261031-v2.zip`），根目录 `entroaxiom-admin/`；含源码、`pnpm-lock.yaml`、`src/mock`、`scripts/`（三个冒烟/回归脚本）、`docs/`（四份文档 + `screenshots/` 15 张截图）；不含 `node_modules`、`dist`、`.git`；包内检索 `__v3BlockArticleSave`/`SAVE_BLOCKED` 只在两份文档的说明文字里出现，源码与脚本 0 命中 |

### 2.2 构建产物关注点

- 首屏不引入 Markdown 管线与 KaTeX：编辑器/预览按路由分包，`MarkdownView` 单独成 chunk。
- 没有远程 CDN 依赖（`VITE_CDN=false`），字体为本地分片（`src/assets/fonts/entro-serif`）。
- `dist` 内不含 `src/mock`，生产构建不受开发替身影响。

### 2.3 测试替身的边界

替身只用于开发：`.env.development` 里 `VITE_MOCK = true`，`src/main.ts` 里 `import.meta.env.VITE_MOCK === "true"` 才会动态 `import("@/mock")`。数据全在内存里，刷新即重置；接口行为刻意包含失败分支（409 `REVISION_CONFLICT`、409 `FILE_IN_USE`、404 `NOT_PUBLISHED`、404 `MOCK_NOT_IMPLEMENTED`）。

### 2.4 未执行项的原因

| 未执行项 | 原因 |
| --- | --- |
| 真实后端联调（L3） | 后端不在本仓库，也没有可用部署地址与账号 |
| 断网/弱网场景 | 替身不发真实网络请求，无法模拟断网 |
| 键盘操作（Tab/快捷键） | 走查期间以 VOM/截图验证为主，未做完整键盘操作矩阵 |
| 破坏性操作的完整按钮流 | 走查保护种子数据，发布/撤回/删除等只打开对话框与确认框，未实际确认执行 |

浏览器走查本身已不阻塞：`bsk` daemon 经后台常驻任务 `bsk daemon start --foreground` 运行，Edge 156.0.0.0 安装 BrowserSkill 扩展 0.4.0 后与 daemon 协议匹配（protocol 1.7），可正常驱动。

## 3. 逐条 AC 记录

结果列的含义：**L1**＝构建与静态检查可证明；**L2**＝开发替身交互可证明（附断言名）；**L3**＝必须真实后端才能验证；**已走查**＝真实浏览器实测；**待人工**＝需要真实浏览器操作、走查后仍未覆盖的残余项。
断言名可在 `scripts/mock-smoke.mjs`、`scripts/render-smoke.mjs` 里检索。

| 编号 | 场景 | 结果 | 证据 / 说明 |
| --- | --- | --- | --- |
| AC-01 | 登录失败、成功、刷新页面、退出后访问受保护路由 | L2 通过 + 已走查 | 断言「未登录被拦截」「登录」「密码过短被拒」；浏览器实测登录页（OBSERVATORY CONSOLE，账号/密码/登录），`admin/admin123` 登录进入工作台；`?r=` 整页重载后会话保持（mock token 约 1 小时过期后才回登录页）。路由守卫与 `logOut` 清理见 `src/router/index.ts`、`src/store/modules/user.ts` |
| AC-02 | 多请求同时过期、刷新失败只刷新一次且队列结束 | L1 通过 + 待人工 | `src/utils/http/index.ts` 的 `isExpiring` 去重 + 失败时 `reject` 排队请求；无自动化断言 |
| AC-03 | 新建含中文标题的笔记 | **L2 通过** | 断言「中文标题生成 ASCII ID」「显式 ID 被接受」「重复 ID 被拒绝」（`DUPLICATE_ID`） |
| AC-04 | 表格、任务列表、代码、公式、图片渲染与前台一致 | **L2 通过** + 已走查 | `render:smoke` 32 条：`table/th`、`checkbox/checked`、`katex`、`katex-display`、`<math>`、`asset:` 占位图、脚本被清洗、`[下载附件](asset:...)` href 保留且带 `data-asset-id`（§5b，3 条为修复新增）；浏览器实测编辑器预览：KaTeX 公式（`$a$`/`$e$`/偏心率公式）渲染、表格/引用可见、`asset:` 图片经鉴权 Blob 显示（`naturalWidth 960`，见 `04-editor-math.png`）、`asset:` 附件渲染为带下载图标与 `title=下载附件` 的链接（见 `14-preview-attachment.png`） |
| AC-05 | 后台阅读私密笔记，打开配图与 PDF | L2 通过 + L3 待定 + 已走查 | 断言「上传后是私密」「私密文件没有直链」「私密资源经 `/files/{id}/content` 鉴权读取」；浏览器实测私人阅读页（草稿·私密纯预览模式，见 `05-private-reading.png`）；修复后正文里的 `asset:` 附件链接在预览/阅读区可点，点击走 `fetchFileBlob` + `saveBlob` 下载（`MarkdownView.onRootClick` 拦截 `a[data-asset-id]`，见 §5.9.6）；真实存储一致性属 L3 |
| AC-06 | 已公开文章改工作稿后保存，线上仍是旧文 | **L2 通过** | 断言「保存后标记有待发布修改」「工作稿改动不影响线上快照」 |
| AC-07 | 更新发布 / 撤回发布，失败不误报成功 | **L2 通过** | 断言「copy-public 发布成功」「撤回后回到 draft」「撤回后线上快照不可读」「撤回发布不丢工作稿」；修复后：发布/撤回只在没有未保存改动时才把编辑框标回「已保存」（`onPublished`/`unpublish` 里 `!dirty` 判断，代码级核对，见 §5.9.1），有未保存改动时提示「发布的内容是最近一次已保存的工作稿」 |
| AC-08 | 公开改私密、私密改公开 | **L2 通过** | 断言「改权限不产生发布快照」「可见范围已更新」；前端有二次确认对话框（`PublishDialog` 的 visibility 模式） |
| AC-09 | 两个标签页改同一篇文章 | **L2 通过** | 断言并发冲突返回 409 `REVISION_CONFLICT`；前端 `ConflictDialog` 三选一（看差异/放弃我的/覆盖），不静默覆盖 |
| AC-10 | 自动保存中切换文章 / 离开 / 断网 / 会话失效 | L1 通过 + 已走查（部分） | 编辑页实测「已保存」状态徽章与 2.5s 自动保存节奏（`n_orbit 已保存`）；串行化保存（`queuedMode`、`forArticle` 丢弃过期响应、`snapshotOf` 比对后才置 saved）、`draftVault` 800ms 落草稿；离开/断网竞态仍只有代码级核对 |
| AC-11 | 手动/自动/重复保存时的版本产生规则 | L1 通过 + 已走查 | 版本抽屉实测只有 v4 发布与 v3 后台保存两条（自动保存不单独生成版本，见 `06-version-history.png`）；替身只在 `saveMode === "manual"` 时 `pushVersion`（`src/mock/adapter.ts` 保存分支） |
| AC-12 | 恢复旧版本，随后反悔 | **L2 通过** + 已走查 | 断言「当前稿被保护成版本」「恢复不改线上快照」「恢复不改可见范围」「可以反复恢复」；浏览器实测 v3 详情、「与当前稿对比」「恢复这个版本」按钮与恢复确认框文案（「当前工作稿会先被保留成一个版本…恢复后要重新发布才会更新前台」），见 `06-version-restore.png`；为保护种子数据未实际确认恢复。修复后：恢复前若编辑框有未保存改动，先弹「暂存草稿并恢复 / 不暂存，直接恢复」确认（`onRestored`，见 §5.9.3） |
| AC-13 | 导入普通 UTF-8 `.md` | **L2 通过** + 已走查 | 断言「预检给出候选」「预检解析出标题」「预检可提交」；修复后新增：带 `id/updated/mood/place` frontmatter 的随笔导入，预检表单回填 ID/展示更新日期/心境/地点（见 §8.1 断言与 `13-import-fields.png`）。浏览器实测注入 `roundtrip.md`（frontmatter 四字段）→ 上传并预检 → 「预检结果 · 导入为随笔」→ 表单显示 `ID=imp-roundtrip-2`、写作日期、展示更新日期 2026-10-20、心境 `平静`、地点 `书房`；提交后「原工作稿已存为版本 v_imp-roundtrip-2_1」，文章信息抽屉四字段齐全 |
| AC-14 | ZIP 含文章、中文路径图片、PDF、多篇 Markdown | L2 部分 + 已走查（单文件） | 断言「zip 里找到 md 候选」「zip 候选能解出标题」；导入页整页渲染实测（拖拽区/选择文件/20 MB 上限文案）；多篇候选与歧义的完整 UI 分支待人工 |
| AC-15 | 同 ID 导入、预检过期、目标 revision 变化、重复提交 | L2 部分 + L3 待定 | 修复后 mock 的预检 `conflicts` **按「同类型 + 同 ID」匹配**候选（原恒为空数组），断言覆盖（§8.1：同 ID 再导入时 `preview.conflicts` 出现该候选）；提交 `mode=create` 时显式 `draft.id` 生效（非法 ID 拒绝、重复 `DUPLICATE_ID` 409），`mode=update` 时写入 `updated/mood/place`。`IMPORT_EXPIRED` 与「重复提交幂等」需要后端事务保证 |
| AC-16 | 图片缺失、外部资源、Obsidian 双链与插件语法 | L1 通过 + 已走查（部分） | 预检把 `missing`/`ambiguous`/`unsupported` 分类展示并阻止提交；预检面板实测展示标题/摘要/字数/上限与资源统计；不支持项不猜测转换 |
| AC-17 | 超限 ZIP、路径穿越、异常包、部分资源失败 | L2 部分 + L3 待定 | 前端有 40 MB 上限与 `ARCHIVE_TOO_LARGE` 处理；路径穿越等安全校验按方案属后端职责 |
| AC-18 | 导出工作稿/发布版本为 ZIP 并本地能打开 | **L2 通过** | 断言「导出 zip 是 PK 开头」，并把导出的 zip 重新导回替身且解析出文章——能证明包结构与正文来自所选版本 |
| AC-19 | 上传取消/失败/进度、中文文件名 | L2 部分 + 已走查（上传入口） | 文件库页实测渲染：拖拽区、「选择文件」按钮、20.0 MB 上限与允许扩展名文案；断言中文文件名 `补测-copy.svg` 上传成功；取消/进度条仍只有代码级（`AbortController` + `onUploadProgress`） |
| AC-20 | 删除被引用的文件 | **L2 通过** + 已走查 | 断言引用清单与 `FILE_IN_USE` 拒绝；浏览器实测文件详情抽屉「被谁引用」清单（未引用文件显示「还没有内容引用它」，见 `08-file-detail.png`）；无引用文件可删 |
| AC-21 | 公开文章引用私密资源、共享资源转私密 | **L2 通过** | 断言「预检把私密资源列成待决策项」「copy-public 不改原文件权限」「keep-private 不改文件权限」「make-public 会把文件本身改成公开」 |
| AC-22 | 新建/编辑书影音，消费状态与发布互不影响 | **L2 通过** | 断言「书影音发布成功」，且 `status`（done/doing/want）与 `publicationStatus` 分别保存 |
| AC-23 | 访客留言正常/命中/频繁提交 | L3 待定（公开端） | 管理端只能处理状态；命中与 429 由公开端与后端决定 |
| AC-24 | 含过滤词的昵称、全角/大小写/空格绕过 | **L2 通过** + 已走查（页面） | 断言「命中时 allowed=false」「命中项指出字段」「exact 匹配命中称呼」「干净内容 allowed=true」，并展示 `normalized` 输入；过滤规则页实测渲染 4 条规则（见 `10-moderation.png`） |
| AC-25 | 新增/停用/修改/删除过滤词 | **L2 通过** | 断言「开关改成功」；规则表实测显示停用项与命中证据；删除与旧留言命中证据保留见页面文案与 `docs/ADMIN_API.md` |
| AC-26 | 放行/隐藏/回复/修改回复/删除回复 | L2 部分 + L3 待定 + 已走查（详情） | 断言「状态改成 hidden」；留言详情抽屉实测：正文（纯文本 `pre-wrap`）、IP 哈希仅前 16 位、「仅哈希、不可反查」提示、站长回复编辑 0/500 与保存回复/放行并公开/隐藏/彻底删除按钮（见 `09-guestbook-detail.png`）；回复走 `PUT /guestbook/{id}/reply`，未用 `v-html` |
| AC-27 | 无记录、无筛选结果、请求失败、404/409/413/422/429 | L2 部分 + 已走查（空态） | 断言覆盖 `404 NOT_PUBLISHED`、`409 REVISION_CONFLICT`、`409 FILE_IN_USE`、`404 MOCK_NOT_IMPLEMENTED`；空态实测：版本历史对无版本的草稿显示「还没有历史版本」，文章信息对无效 ID 显示「没有这篇内容，可能已被删除」（`EmptyState` 两种文案） |
| AC-28 | 1440/1280/768/390 宽度、键盘操作、长文件名 | **已走查（窄屏）** + 待人工（键盘） | 390×844 窗口实测：侧栏折叠为「点击展开」、工作台卡片堆叠、顶栏按钮收敛（见 `11-narrow.png`）；断点写在 `src/style/workspaces.scss`（`<1100px` 编辑器默认单栏）；键盘操作与长文件名溢出未实测 |
| AC-29 | 生产构建不启用开发替身 | **L1 通过** | `dist` 检索 0 命中；`VITE_MOCK` 只在 `.env.development` 为 `true`，生产/预发未设置 |
| AC-30 | 私密内容访问后退出、跨标签页退出、对象 URL 清理 | L1 通过 + 待人工 | `src/utils/media.ts` 订阅 `session:cleared`/`session:expired`/`session:external-logout` 清缓存与 Object URL，`draftVault` 在主动退出时清空；跨标签页行为需真实浏览器 |

统计：L2 断言通过 15 条（其中 AC-05 的存储一致性仍待 L3）；L1 通过或部分通过 14 条；九类页面/关键交互已真实走查（AC-01/04/05/10-13/19/20/24/26-28），八项缺陷修复另有浏览器复验（附件选择器、预览下载链接、导入字段回填）；残余待人工项为键盘操作、跨标签页退出、破坏性按钮流确认与弱网场景。

## 4. 截图

走查于 2026-10-31 在 `pnpm dev`（localhost:8848，开发替身）上完成，Edge 156.0.0.0 + BrowserSkill 0.4.0 驱动，截图保存在本仓库 `docs/screenshots/`。方案第 13.3.5 节要求的九类截图全部覆盖：

| 文件 | 对应场景 | 内容 |
| --- | --- | --- |
| `docs/screenshots/02-dashboard.png` | 概览 | 登录后工作台：统计卡片（随笔 2 / 笔记 3 / 书影音 4 / 文件 6 / 拦截的留言 1）、最近在写的、常用的地方 |
| `docs/screenshots/03-content-list.png` | 文章列表 | 随笔列表：搜索/筛选/只看未发布修改，「已发布 公开」与「草稿 私密」两行 |
| `docs/screenshots/04-editor-math.png` | 带公式和图片的编辑预览 | 笔记编辑器并排预览：KaTeX 公式（半长轴/偏心率 `$e=\sqrt{1-b^2/a^2}$`）、表格、引用、`asset:` 图片经鉴权 Blob 渲染（`naturalWidth 960`） |
| `docs/screenshots/05-private-reading.png` | 私人阅读页 | 私密草稿纯预览模式（无编辑控件、无发布入口） |
| `docs/screenshots/06-version-history.png` | 版本历史 | n_orbit 版本列表：v4 发布 / v3 后台保存，说明「自动保存不单独生成版本」 |
| `docs/screenshots/06-version-restore.png` | 版本恢复 | v3 详情 +「与当前稿对比」「恢复这个版本」+ 恢复确认框（保留当前稿、不动线上） |
| `docs/screenshots/07-import-preview.png` | 导入预检 | 上传 `星轨手记.md` 后预检结果：标题/摘要/正文字数（161 字）/上限 512 KB/包内资源/落库方式 |
| `docs/screenshots/08-file-detail.png` | 文件详情 | 文件抽屉：名称/说明/可见范围/被谁引用/ID/版本/创建时间 |
| `docs/screenshots/09-guestbook-detail.png` | 留言详情 | 留言抽屉：正文（纯文本）、IP 哈希（仅前 16 位、「仅哈希、不可反查」）、站长回复编辑、操作按钮 |
| `docs/screenshots/10-moderation.png` | 过滤规则 | 规则表 4 条（含停用项与命中证据展示） |
| `docs/screenshots/11-narrow.png` | 窄屏 | 390×844 窗口：侧栏折叠为「点击展开」、卡片堆叠 |
| `docs/screenshots/12-attachment-picker.png` | 附件选择器 | 编辑器「附件」按钮弹出的「插入附件（下载链接）」对话框，只列出非图片文件（docx/pdf/zip 三种） |
| `docs/screenshots/13-import-fields.png` | 导入字段回填 | 随笔导入预检表单：ID（`imp-roundtrip-2`）、写作日期、展示更新日期（2026-10-20）、心境（平静）、地点（书房）均来自 frontmatter |
| `docs/screenshots/14-preview-attachment.png` | 预览附件链接 | 编辑器预览里 `[下载附件](asset:f_doc_draft)` 渲染成带下载图标、`title=下载附件` 的链接（`a.md-asset-link`，href 保留 `asset:` 协议） |

另有一张过程图 `docs/screenshots/04-editor.png`（编辑器并排模式全貌）。所有截图均来自开发替身种子数据，不含真实密码、token 或私人笔记。

## 5. 已知问题与偏差

1. **走查中发现并修复的真实缺陷：五个单页路由不可达**。`src/router/modules/{library,imports,guestbook,moderation,shelf}.ts` 原先父路由与子路由 `path` 完全相同（都 `/library` 等），vue-router 4 对同一 full path 只保留父记录 → 点菜单或直接输 hash 路径只匹配父 Layout 记录，持有页面组件的子记录永不匹配，视图区空白（标题/面包屑已变）。修复：参照 `home.ts` 的规范写法——父路由新增 `redirect: "/<mod>/index"`，子路由改绝对路径 `"/<mod>/index"`（与父不同）。已在浏览器逐页复验（`#/library/index`、`#/imports/index`、`#/guestbook/index`、`#/moderation/index` 均渲染出真实页面）。
2. **走查覆盖范围与残余项**。已覆盖：登录、工作台、内容编辑（公式/图片预览）、私人阅读、版本历史与恢复、导入预检、文件详情、留言详情、过滤规则、窄屏（390px）。未覆盖：键盘操作（Tab/快捷键）、自动保存竞态的真实时序、发布/撤回/删除等破坏性按钮流的实际确认（走查保护种子数据，只打开对话框与确认框）、跨标签页退出、弱网/断网。这些场景仍是「代码级核对 + 替身断言」。
3. `src/style/dark.scss` 的两行 Sass 变量插值曾被 stylelint 误报，已用 `stylelint-disable-next-line` 精确关掉（保留原因注释），现在 eslint / prettier / stylelint 三项均 0；`pnpm lint` 是写入模式（`--fix`/`--write`），只读复核请用 `pnpm lint:check`。
4. `docs/*.md` 与 `README.md` 未纳入 `prettier --check`：中文自然段被 `printWidth` 强制折行会破坏可读性，选择保留手写排版。
5. pnpm 11 提示 `package.json` 里的 `pnpm.allowedDeprecatedVersions`、`pnpm.onlyBuiltDependencies` 已不再读取（模板遗留），不影响构建，未迁移到 `pnpm-workspace.yaml`。
6. 编辑器对超大正文（>512 KB）只做拦截与提示，没有分片保存或压缩；这是方案允许的范围（正文上限由 `capabilities.content.maxBodyBytes` 决定）。
7. 版本对比是行级 diff（`diffLines`），没有做逐字 diff——方案把逐字 diff 列为「不必加入的后续增强」。
8. 导出的 ZIP 里资源以 `assets/` 平铺命名（`<fileId>-<原文件名>`），没有保留 Obsidian 的原始目录层级；正文引用会同步改写，导入回来能对上。

### 5.9 八项疑似缺陷审计与修复（2026-10-31）

依据方案：§5.3 L162-169（附件下载、只有服务端确认才显示已保存、离开提醒、不新增跨会话草稿）、§5.5 L196-197（恢复先保留被替换工作稿、可恢复随笔心境/地点）、§6.1 L209/L212（frontmatter 支持 `id/title/summary/category/tags/date/updated/mood/place`；以类型+稳定 ID 判断候选冲突）、§6.3 L230（frontmatter 保留稳定 ID 与常用元信息）、§7.1 L244（附件显示类型/大小/下载按钮）。逐条核实**全部成立**，已修复并复验：

1. **发布/撤回误标「已保存」**。根因：发布按服务端 record 快照进行，前端 `onPublished`/`unpublish` 却无条件把编辑框标回 clean。修复：只在 `!dirty` 时才更新 `originalSnapshot` 并置 `saveState="idle"`；有未保存改动时发布提示置顶「发布的内容是最近一次已保存的工作稿，未保存的改动不会包含进去」。
2. **「暂存草稿并离开」未兑现**。根因：`useUnsavedGuard.confirmLeave` 只问话、由调用方存草稿，侧栏/路由离开分支没存。修复：`useUnsavedGuard` 增加 `onLeave` 选项，确认后调用；编辑页 `goBack` 改为「确认 → `guard.markClean()` → 返回」（避免双弹窗），草稿由 `onLeave` 统一写入。
3. **恢复历史版本未保护未保存内容**。根因：`VersionHistory` 的 `@restored` 直接 `applyDetail` 覆盖。修复：新增 `onRestored(data)`——dirty 时弹「暂存草稿并恢复 / 不暂存，直接恢复」，确认则先 `persistDraft()` 再 `applyDetail`。
4. **编辑器资源选择器限图片**。根因：`MarkdownEditor.vue` 硬编码 `:kinds="['image']"`。修复：新增「附件」按钮 + 第二个 `AssetPickerDialog`（`kinds: ['pdf','archive','doc']`，标题「插入附件（下载链接）」），选中插入 `[name](asset:id)`。
5. **预览只对图片鉴权、无附件下载**。根因：`rehype-sanitize` 默认协议白名单剥掉 `asset:` href；`MarkdownView.decorate` 只处理 `img[data-asset-id]`。修复：sanitize `protocols.href` 放行 `asset`；`decorate` 给 `a[data-asset-id]` 加 `md-asset-link` 类与 `title=下载附件`。
6. **文章内附件流程缺段**（承接 4/5）。修复：`MarkdownView.onRootClick` 拦截 `a[data-asset-id]` → `fetchFileBlob` + `saveBlob` 下载（带错误 toast）。
7. **导入表单丢字段、`id` 传空、不传 `updated/mood/place`**。根因：`imports/index.vue` 的 form 无 `id/updated/mood/place`，commit 硬编码 `id:""`。修复：表单新增 ID（可改，`/^[a-z0-9][a-z0-9-]{0,79}$/` 校验、留空按标题生成、已有同 ID 时提示改「更新既有内容」）、展示更新日期、随笔的「心境/地点」；commit 载荷如实下发。
8. **导出再导入字段不保留 / 同 ID 冲突不检测**。根因：`mock/adapter.ts` 的 `parseMarkdown` 把 `id/updated/mood/place` 当 unknown、导出 frontmatter 不写这些字段、导入 commit 丢弃、预检 `conflicts` 恒为 `[]`。修复：解析/导出/提交都保留（mood/place 仅随笔）；预检按「同类型+同 ID」匹配冲突候选；create 提交显式 ID 生效、重复 `DUPLICATE_ID` 409。

复验：`mock:smoke` 188/188（新增 §8.1 往返 + 同 ID 冲突）、`render:smoke` 32/32（新增 §5b 附件链接）、typecheck 0、lint:check 0、build 5.44 MB；浏览器复验通过（附件选择器、预览 `a.md-asset-link`、导入四字段回填与显式 ID 落库），截图见 §4 第 12–14 行。

## 5.10 四项遗留缺陷 R1–R4 修复与 V01–V14 验收（2026-11-01）

依据：`ENTROAXIOM-后台v2修复执行方案-20261031.md`（基线 `entroaxiom-admin-20261031-v2.zip`）。四条缺陷修复前均先读到对应代码确认成立，再改。结论边界：**除 V01 外全部为开发替身验证**；`preservedVersion` 真实落库、历史保留策略、权限隔离仍须后端联调。

### 5.10.1 改了什么

| 缺陷 | 根因（修复前） | 修复后行为 | 主要文件 |
| --- | --- | --- | --- |
| **R1** 权限操作吞掉未保存状态 | `reloadAfterMutation(cleanAfter = false)` 把「是否清脏」做成布尔形参，模板上 `@published="reloadAfterMutation"` 把 `PublishDialog` 抛出的**事件对象**当参数传入（对象为真值）→ 权限成功后 `originalSnapshot = snapshotOf(form)`，未保存输入被标成已保存 | 去掉形参：`reloadAfterMutation()` 只刷新服务端详情，**从不碰** `originalSnapshot`/`saveState`；权限弹窗改绑命名函数 `onVisibilityApplied()`；发布改绑 `onPublished()`（仅 `!dirty` 时才更新快照）；刷新失败改为 warning 提示且**保持 dirty**；`unpublish` 增加「响应是否属于当前文章」守卫 | `src/views/content/edit.vue` |
| **R2** 恢复历史版本不保护当前编辑内容 | `VersionHistory.restore()` 自己弹确认后立刻发恢复请求；`edit.vue` 的 `onRestored` 反而在**恢复成功之后**才问「是否暂存」，关闭提示还会继续覆盖；`save()` 排队时提前返回，`await save()` 不代表保存完成 | 保护前移到请求之前：父页面提供可等待的 `beforeRestore()`，组件在**发请求前** `await` 它；`save()` 改为返回明确结果（`saved`/`dirty`/`skipped`/`error`/`conflict`）并串行化，新增 `ensureSaved()` 与 `awaitSaveIdle()`；恢复事务期间暂停自动保存定时器、阻止重复恢复、用**最新 revision** 恢复；成功后 `applyDetail` + 清本地草稿（不再二次询问） | `src/views/content/edit.vue`、`src/components/Manager/VersionHistory.vue`、`src/utils/saveQueue.ts`（新） |
| **R3** 本地草稿只比较标题与正文 | `offerDraft()` 用 `local.body/title === server.body/title` 判「无差异」，只改了摘要/分类/标签/日期的草稿被直接 `clearDraft` 删掉；确认框 `catch` 不分取消与关闭，一律删草稿 | 抽出统一归一化比较 `editableArticleSnapshot()`（可编辑字段全部参与：标题/摘要/分类/标签/日期/展示更新日期/正文，随笔另加心境/地点；可选字段 null/空串统一；标签 trim 去空但**不排序**；正文**不 trim**；revision/时间戳/权限/发布状态不参与）；只有全部一致才自动清理；只有**明确丢弃**才删草稿，关闭/Esc 保留 | `src/utils/editableSnapshot.ts`（新）、`src/views/content/edit.vue` |
| **R4** 书影音「暂存草稿并离开」未兑现 | `useUnsavedGuard` 的 `onLeave` 无返回值，守卫默认放行；`shelf/index.vue` 根本没传 `onLeave`，也没有任何草稿读写 | 守卫支持 `onLeave` 返回 `false` 即**取消离开**（并提示「暂存失败，已取消离开」）；书影音接入草稿仓：条目键 `ea:draft:shelf:<id>`、新建键 `ea:draft:shelf:new`，编辑中 800 ms 防抖暂存，打开条目/新建时先载服务端数据再询问恢复，创建成功清理新建键（键转换），保存成功只清「本次真正保存且与表单一致」的草稿；抽屉关闭统一走 `requestClose()`，X/遮罩/Esc/底部按钮只确认一次 | `src/composables/useUnsavedGuard.ts`、`src/views/shelf/index.vue`、`src/utils/draftVault.ts`（沿用其 `saveDraft` 布尔返回） |

### 5.10.2 V01–V14 矩阵

「验证方式」列：**浏览器**＝bsk 驱动 Edge 156 实操开发替身；**自动化**＝`pnpm v3:regression` / `mock:smoke`；**代码核对**＝读实现与调用链。为制造「保存不成功」的前置，临时在 `src/mock/adapter.ts` 的 `PUT /articles/{res}/{id}` 里加过 `__v3BlockArticleSave` 定向拦截开关（只拦正文保存，放行权限/历史接口），**验收后已删除并重跑全部检查**（`dist` 检索无残留）。

| 编号 | 结果 | 验证方式 | 关键结果 |
| --- | --- | --- | --- |
| V01 | **通过** | 浏览器 | 拦保存后改正文 → 保存状态「保存失败」、正文 369 字保留；「更多 → 改为私密」应用成功、可见范围变「私密」，**正文与未保存状态都没被回执覆盖**；反向改回公开同样成立。整页刷新后弹出「发现本地草稿…要用它替换线上工作稿的内容吗？」，没有被误认为已保存 |
| V02 | **通过（部分代码核对）** | 浏览器 + 代码核对 | 无未保存改动时改权限：状态正常回到「已保存」，不制造虚假 dirty；权限回执刷新失败走 `reloadAfterMutation` 的 catch 分支，只提示、不清 dirty、不改 `originalSnapshot`（`edit.vue` 该函数体内无 `originalSnapshot`/`saveState` 赋值） |
| V03 | **通过** | 浏览器 | 未保存改动 379 字 → 恢复 v3 → 先弹恢复前确认框 → 确认后**先保存成功（状态「已保存」）再恢复**（正文 379→310）→ 历史新增 `v7 历史恢复`，其中 `v6 后台保存 756 B` 完整包含恢复前的「【V03恢复前改动】」两段；再手动保存产生 `v8`，**`v6` 仍在**（后续保存没删掉唯一恢复入口）；可见范围仍「公开」 |
| V04 | **通过** | 浏览器 | 确认框「取消」→ 正文 329 字原样、无新版本；「Esc」→ `box:false`、正文 347 字原样、版本列表仍只有 v4/v3（未发恢复请求）。Esc 必须用真实按键（`bsk press Escape`），`dispatchEvent(new KeyboardEvent(...))` 关不掉 Element Plus 弹窗 |
| V05 | **通过（自动化 + 代码核对）** | 自动化 + 代码核对 | `ensureSaved()` 只有拿到 `"saved"` 才返回成功；`"skipped"`（标题空/正文超限）、`"error"`（网络/会话）、`"conflict"`（409，已由 `openConflict` 弹三选一）一律返回 `"failed"`，`beforeRestore` 直接返回 `{ok:false}` 且不发恢复请求；恢复接口自身失败时组件保留已保存的当前稿、`finally` 复位 `restoring` |
| V06 | **通过（自动化 + 代码核对）** | 自动化 + 代码核对 | `createSaveQueue` 保证同一时刻只有一个保存在飞、按序执行、失败不影响后续；`beforeRestore` 先 `clearTimeout` 停掉 2.5 s 自动保存与 800 ms 草稿定时器，`restoreBusy` 期间 watcher 直接 return；`restoring` 再挡重复点击；恢复用 `ensureSaved()` 后的**最新 revision**，旧响应因 `snapshotOf(form) !== sentSnapshot` 不会覆盖表单 |
| V07 | **通过** | 浏览器 | 只改摘要（标题/正文完全不动）→ 暂存并离开 → 重新进入**仍弹「发现本地草稿」**（旧实现会因标题正文相同直接删草稿）→ 恢复后摘要含「【V07仅改摘要】」、正文 347 字未变、状态仍「保存失败」（真实未保存）；对确认框按 Esc 关闭后草稿仍在（sessionStorage 键未消失），再次进入仍弹提示 |
| V08 | **通过** | 浏览器 + 自动化 | 全部可编辑字段一致且保存成功后，草稿被清理、`sessionStorage` 无残留键、再次进入不弹提示（不反复打扰）；旧版草稿缺 `mood/place` 时靠 `?? ""` 归一化仍可正常读取（归一化用例覆盖 null/空串/缺失） |
| V09 | **通过** | 浏览器 | 已有条目改短评 → 底部「关闭」→ **只弹一次**确认（「这条书记录还有未保存的修改…」）→「暂存草稿并离开」→ 抽屉关闭、写入 `ea:draft:shelf:s_winter`；重开该条目弹「发现本地草稿…要用它替换当前表单吗？」→ 恢复后短评「【V09短评】…」、其余字段齐全、保存按钮可用（真实未保存）；再改标题后点关闭选「留在这里」→ 抽屉不关、输入保留 |
| V10 | **通过** | 浏览器 | 新建条目填标题+短评 → 关闭暂存 → 键为 `ea:draft:shelf:new`，与 `s_winter` 互不污染；再点「新建条目」弹恢复提示 → 恢复后标题 7 字 + 短评 14 字完整回来 → 保存创建成功（列表 5 条）→ 新建键被清理 → **再次「新建条目」是空表单、无旧内容提示**（新建键→条目键转换正确） |
| V11 | **通过** | 浏览器 | 用 `Storage.prototype.setItem` 抛异常模拟配额不足：点「暂存草稿并离开」→ 提示「暂存失败，已取消离开。请检查后再试。」、抽屉保持打开（620px）、输入未丢；恢复 `setItem` 后重试 → 正常写入草稿并关闭抽屉 |
| V12 | **通过** | 浏览器 + 代码核对 | 保存成功 → 草稿键被清理（`ea:draft:` 前缀键归零）、状态「已保存」；保存期间又有新输入时 `snapshotOf(form) !== sentSnapshot` → `savedClean=false`，草稿保留、`saveState` 回到 `dirty`；书影音侧新建/编辑分支分别按「创建即兑现」与「快照一致」判定 |
| V13 | **通过** | 浏览器 | V03 恢复前后可见范围一直是「公开」、线上发布指针未变；恢复与普通保存都不触发发布接口（`doPublish` 只在显式点发布时调用），权限变化只走 `patchArticleVisibility` |
| V14 | **通过（部分代码核对）** | 浏览器 + 代码核对 | 笔记/随笔切换与在途响应靠 `forRes`/`forArticle` 守卫丢弃（`runSave`、`reloadAfterMutation`、`unpublish` 均有）；文章草稿键按 `content:<res>:<id>` 隔离，书影音按 `shelf:<id>` 隔离；主动退出登录沿用 `clearAllDrafts()`（`draftVault` 监听 `session:cleared`）并清理私密媒体缓存 |

### 5.10.3 本轮检查记录（实际命令与结果）

| 命令 | 结果 |
| --- | --- |
| `pnpm typecheck` | exit 0（修复过程中曾报 1 处 `beforeRestore` 判别联合在 `vue-tsc` 下不收窄的 TS2339，改为扁平返回类型 `{ ok: boolean; baseRevision?: number; reason?: string }` 后通过） |
| `pnpm lint:check` | exit 0（eslint + prettier `--check` + stylelint；新增 `scripts/v3-regression.mjs` 先经 `prettier --write` 整理） |
| `pnpm mock:smoke` | 188/188（既有断言全部保留，覆盖恢复接口的 `preservedVersion`、恢复后 revision 递增、恢复不改线上快照/可见范围） |
| `pnpm render:smoke` | 32/32（`asset:` 附件链接未退化） |
| `pnpm v3:regression` | 30/30（本轮新增） |
| `pnpm build` | exit 0，5.44 MB / `✓ built in 11.54s`；`dist` 检索 `__v3BlockArticleSave`、`SAVE_BLOCKED`、`mockAdapter`、`installMock` 均 0 命中 |
| 浏览器验收 | V01/V03/V04/V07/V08/V09/V10/V11/V12 实测通过（Edge 156 + BrowserSkill 0.4.0，bsk 会话 `rtrg`，`pnpm dev` 开发替身） |

证据说明：验收矩阵里浏览器实测的判定依据是「DOM 文本 + `sessionStorage` 键 + 请求后状态」，未逐条截图；方案 §11 要求的截图可复现于上述步骤（权限操作后的未保存状态、恢复前确认框、恢复前原稿的历史入口、仅元信息草稿恢复、书影音草稿恢复）。截图不含私人内容与令牌。

### 5.10.4 本轮已知限制

- 恢复保护与「被替换工作稿落库」只在开发替身上成立；真实后端必须自行保证 `preservedVersion` 真实写库、历史保留策略与权限隔离。
- 未做保存失败提示的自动化断言以外的弱网/断网验证；`beforeunload` 走浏览器原生提醒，不承诺自定义文案覆盖关标签页场景。
- 书影音本轮只做本地草稿暂存与恢复，没有新增自动服务端保存，也未改变「消费状态与发布状态相互独立」的设计。

## 6. 后端仍需实现/确认的接口与行为

| 项 | 对应 AC | 说明 |
| --- | --- | --- |
| `POST /logout` | AC-01 / AC-30 | 前端已按「尽力而为」调用（5s 超时、失败也清本地），后端可撤销 refresh token |
| `GET /files/{id}/content` | AC-05 / AC-19 / AC-30 | 私密资源的鉴权读取通道，必须校验会话，不能返回公开直链 |
| `GET /capabilities` | AC-04 / AC-17 / AC-27 | 正文上限、允许扩展名、版本保留条数、功能开关 |
| 发布预检与资源决策 | AC-07 / AC-21 | `publication-check` 的 `checkId` 一次性、5 分钟过期；`copy-public` 不得改动原文件权限 |
| 版本与恢复语义 | AC-11 / AC-12 | 恢复只改工作稿，先保留当前稿，不动线上快照与权限 |
| 导入事务 | AC-13 / AC-14 / AC-15 / AC-17 | 预检临时区、候选选择、提交幂等、过期清理、路径穿越与压缩炸弹防护 |
| 留言审核与限流 | AC-23 / AC-24 / AC-26 | 命中词的行为、429 频率限制、公开端数据不得含邮箱与命中证据 |
| revision 并发控制 | AC-09 | `If-Match` 用十进制 revision，冲突返回 409 `REVISION_CONFLICT` |

## 7. 复现步骤

```bash
pnpm install
pnpm typecheck        # 0 error
pnpm mock:smoke       # 188/188
pnpm render:smoke     # 32/32
pnpm v3:regression    # 30/30（R1–R4 回归：快照归一化、保存串行化、草稿键语义）
pnpm build            # 5.44 MB
pnpm dev              # http://localhost:8848，任意账号 + 密码 ≥6 位进开发替身
```

浏览器走查：Edge 安装 BrowserSkill 扩展后连到 bsk daemon（`bsk daemon start --foreground` 常驻），按 §4 清单逐页导航并截图；截图已存于 `docs/screenshots/`。侧栏五个单页入口的路径是 `#/library/index`、`#/imports/index`、`#/guestbook/index`、`#/moderation/index`、`#/shelf/index`（修复后规范路径）。

要接真实后端：把 `.env.development` 的 `VITE_MOCK` 改成 `false`，并配置 `VITE_API_BASE` 与（可选的）`VITE_DEV_BACKEND`。
