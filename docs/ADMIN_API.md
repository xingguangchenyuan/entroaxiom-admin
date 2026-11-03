# entroaxiom 管理后台 · 接口契约

本文是**管理端前端已经按它实现**的契约（`src/api/*.ts` 是唯一权威，本文解释意图与边界）。
管理端只请求同源 `/api/admin/*`，前缀由 `VITE_API_BASE` 配置；开发时由 Vite 把 `/api` 代理到后端（`VITE_DEV_BACKEND`，默认 `http://127.0.0.1:8000`）。
内容字段与前台 `docs/API.md`（`/api/public/*`）保持一致，本文只写管理端多出来的部分。

> 文末「后端待实现清单」列出开发替身里已有、真实后端还需要补的三个端点（`POST /logout`、`GET /files/{id}/content`、`GET /capabilities`）。

## 1. 通用约定

### 1.1 信封

成功与失败都带 `success`：

```json
{ "success": true,  "data": <payload>, "error": null }
{ "success": false, "data": null, "error": { "code": "REVISION_CONFLICT", "message": "人话", "details": null } }
```

- 前端在响应拦截器里统一脱壳：`success === true` 且带 `data` 键时，业务代码拿到的是 `data` 本身（`src/utils/http/error.ts` 的 `unwrapEnvelope`）。
- 因此 `data` 里**不要**再套一层 `{ success, data }`。
- `error.message` 会原样弹给站长，请写人话（"标题不能为空"，不是 "validation failed"）。
- `error.details` 用 FastAPI 风格：`[{ "loc": ["body", "title"], "msg": "..." }]`，前端会把 `msg` 标到对应输入框。

### 1.2 状态码

用 HTTP 状态码表达结果，同时带信封：`400 / 401 / 403 / 404 / 409 / 413 / 422 / 429 / 5xx`。

| 状态 | 前端行为 |
|---|---|
| `401` | 清登录态、清草稿、回 `/login`。`/login`、`/refresh-token` 自身的 401 只提示，不跳转 |
| `409` | 并发冲突，读 `error.code` 决定后续（见 §1.4） |
| 其它 | 弹 `error.message`，没有就用状态码的默认文案 |

### 1.3 JSON 字段命名

- **JSON 体与响应字段一律 camelCase**（后端用 pydantic alias 转换）。
- **查询参数里分页仍是 snake**：`page`、`page_size`；其余查询参数是 camelCase（`hasUnpublishedChanges`、`publicationStatus`）。
- 日期 `YYYY-MM-DD`；时间戳 ISO 8601 带时区；可空字段用 `null`，不要用空串冒充空值。

### 1.4 并发控制（乐观锁）

- 每个可写资源都有 `revision`（整数，每次成功写入 +1）。
- 写入方式二选一，**都能触发**：
  - 请求体带 `baseRevision`（`PUT`／`PATCH`／`POST .../publish` 等）；
  - `DELETE` 用请求头 `If-Match: <revision>`（十进制、**不加引号**）。
- 不匹配时返回 `409`，`error.code = "REVISION_CONFLICT"`，`data` 建议给出当前 `revision`。
- 前端对 409 的固定处理：**从不自动覆盖**，而是弹出三选一（看差异 / 用我的覆盖 / 放弃我的载入服务端）。

### 1.5 鉴权

**目标形态（P0-5 契约，后端接入时按这一节实现）**

- **会话放在 HttpOnly Cookie 里**：`POST /login` 用 `Set-Cookie` 下发
  `sid=<随机 128bit>; HttpOnly; Secure; SameSite=Strict; Path=/`，会话状态保存在服务端，
  前端**拿不到也读不到**会话值（防 XSS 直接偷令牌）。
- **所有写操作校验来源**：`POST/PUT/PATCH/DELETE` 必须校验 `Origin`（或 `Referer`）与站点同源，
  不匹配直接 `403 FORBIDDEN`；同时拒绝 `Content-Type` 不是`application/json` 的跨站表单提交。
  同源部署不需要 CORS，**不要**对 `/api/admin/*` 开 `Access-Control-Allow-Origin: *`。
- **刷新**：`POST /refresh-token` 凭 Cookie 里的会话换新的 `sid`（轮换，旧值立即失效）；
  前端在 401 时自动调一次，并发请求共用同一次刷新（`src/utils/http/index.ts` 已实现排队重放）。
- **失效**：`401` + `SESSION_EXPIRED` → 前端清本地状态并跳登录页（只提示一次，不弹一堆框）。
- 前端**不持久化任何令牌**；`localStorage` 只存 `username/nickname/avatar/roles/permissions` 这类展示信息。

**当前过渡形态（本仓库现状，后端未接入时的临时实现）**

- 请求头：`Authorization: Bearer <accessToken>`；模板默认还带 `X-Requested-With: XMLHttpRequest`。
- `accessToken` 存在 `authorized-token` cookie 里（`SameSite=Strict`，https 下带 `Secure`），
  **`refreshToken` 只放内存**（`src/utils/auth.ts` 的 `getRefreshToken()`），刷新页面即丢失，
  凭 Cookie 里若有 `refreshToken` 会自动迁移并擦掉。
- 后端接入时必须二选一，不允许两种混跑：要么按上面改成 Cookie 会话（推荐），
  要么保持 Bearer —— 那就必须让 `/refresh-token` 真的接收内存里的 refreshToken，
  否则刷新页面后刷新会话必然失败（`http/index.ts` 现在会直接提示重新登录，不会再发空 body）。
- 管理接口必须逐个校验令牌与角色（前端路由守卫只是界面便利，绕得过去）。
- 资源鉴权读取：私密文件只能通过 `GET /files/{id}/content` 读取（见 §3.3），**不要**把需要 Bearer/Cookie 的地址塞进任何 `publicSrc` 字段——`<img>` 不会带 `Authorization`。

### 1.6 错误码

| code | 场景 |
|---|---|
| `VALIDATION_ERROR` | 字段校验失败（配 `details`） |
| `INVALID_CREDENTIALS` / `INVALID_REFRESH_TOKEN` | 登录／刷新失败 |
| `UNAUTHORIZED` / `FORBIDDEN` | 令牌无效／角色不足 |
| `NOT_FOUND` | 资源不存在 |
| `REVISION_CONFLICT` | 并发冲突（§1.4） |
| `FILE_IN_USE` | 文件仍被引用，不能硬删（配 `details` = 引用清单） |
| `CONTENT_REJECTED` | 公开留言命中过滤规则 |
| `CHECK_EXPIRED` | 发布预检已过期或不可复用（5 分钟 TTL） |
| `CHECK_MISMATCH` | 预检凭据与本次操作不符（换了用户／对象／动作／目标可见范围／revision／私有资源集合） |
| `CONFIRM_REQUIRED` | 发布没带 `confirmed: true` |
| `DUPLICATE_ID` / `DUPLICATE_RULE` | ID 或规则重复 |
| `NOT_PUBLISHED` | 请求线上快照但该文未发布 |
| `IMPORT_EXPIRED` | 导入临时区过期 |
| `ARCHIVE_TOO_LARGE` / `ENTRY_UNREADABLE` / `UNSUPPORTED_TYPE` / `FILE_TOO_LARGE` | 导入包问题 |

## 2. 认证与会话

### `POST /login`

请求 `{ username, password }`。成功后前端把令牌写 cookie、把 `username/nickname/avatar/roles/permissions` 写 `localStorage`（**不存任何令牌**）。

```ts
data: {
  username: string;
  nickname: string;          // 可为空串
  avatar: string;            // 可为空串
  roles: string[];           // 页面级权限，如 ["admin"]
  permissions: string[];     // 按钮级权限；["*:*:*"] 表示全部
  accessToken: string;       // 建议短时效（如 30 分钟）
  refreshToken: string;      // 长时效（如 7 天），轮换使用
  expires: string | number;  // 毫秒时间戳或 ISO 字符串
}
```

账号或密码错误一律 `401` + `INVALID_CREDENTIALS`（不要区分"用户不存在"和"密码错"），并对登录做限流（`429`）。

### `POST /refresh-token`

请求 `{ refreshToken }`，成功返回 `{ accessToken, refreshToken, expires }`（建议轮换，旧的立即作废）。
失败 `401` + `INVALID_REFRESH_TOKEN`：前端会把排队中的请求一起 reject 并回登录页。

### `POST /logout`

**后端待实现**。前端主动登出时静默调用它（`silent: true`，5 秒超时，失败也照常清本地状态），用于服务端撤销 refreshToken。
请求体 `{ refreshToken }`（可选，便于服务端精确撤销），成功返回 `data: null`。

### 会话失效的两种语义（前端已实现，后端不用担心）

- **主动登出**：清 token、清路由、`clearAllDrafts()` —— 站长自己点的，草稿跟着会话走。
- **被动失效**（401 或别的标签页登出）：保留 `sessionStorage` 里的草稿 12 小时，站长重新登录后编辑器会问"恢复本地修改"。

## 3. 能力与概览

### `GET /capabilities`（后端待实现，可先缺省）

前端启动时读一次并缓存（`src/store/modules/capabilities.ts`）。**缺失或失败不影响使用**：会退回保守兜底值并标记 `authoritative = false`，界面显示"限制值未从服务端读到"。

```ts
data: {
  upload: { maxFileBytes, allowedKinds: FileKind[], allowedExtensions: string[], maxConcurrent };
  import: { maxArchiveBytes, maxExpandedBytes, maxEntries };
  content: { maxBodyBytes, versionRetention, maxTitleChars, maxSummaryChars, charCounting: "codepoint" | "utf16" };
  features: { importZip, exportZip, versionRestore, moderationTest, serverLogout, authenticatedMedia };
  policyVersion?: string;
}
```

`features` 决定界面是否显示对应入口（例如 `exportZip: false` 就只给 Markdown 导出）。

### `GET /dashboard`

```ts
data: {
  stats: { essays, notes, shelf, files, blockedGuestbook, pendingGuestbook? };
  recentDrafts: Array<{ res: "notes" | "essays"; id; title; updatedAt; status; hasUnpublishedChanges }>;
  storage: { usedBytes, totalBytes } | null;
}
```

### `GET /content-options?type=notes|essays`

```ts
data: { categories: string[]; tags: string[] }
```

用于编辑器里的下拉候选（`allow-create`，站长的历史值优先）。`type` 省略时返回全站合集。

## 4. 文章（notes / essays）

`{res}` 取 `notes` 或 `essays`，其余完全同构。

### 4.1 数据形状

```ts
ArticleDraft {            // 可编辑字段
  id: string; title: string; body: string;
  summary: string | null; category: string | null;
  tags: string[] | null; date: string | null; updated: string | null;
  mood?: string | null; place?: string | null;
}

ArticleDetail extends ArticleDraft {
  visibility: "public" | "private";
  status: "draft" | "published";          // 是否有活动发布快照
  hasUnpublishedChanges: boolean;          // 工作稿与线上快照是否有差异
  revision: number;                        // 乐观锁
  createdAt; updatedAt; publishedAt: string | null; publishedRevision: number | null;
  assets: ArticleAsset[];                  // 正文引用的资源（见 §3.3 的 AssetImage 用法）
}
```

列表项不返回 `body`，但返回 `charCount?`、`hasUnpublishedChanges`、`publishedAt`、`publishedRevision`。

### 4.2 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/articles/{res}?page=&page_size=&keyword=&status=&visibility=&category=&tag=&hasUnpublishedChanges=` | `{ items: ArticleListItem[], total }`，含草稿与私密 |
| GET | `/articles/{res}/{id}` | `ArticleDetail` |
| POST | `/articles/{res}` | 新建，`id` 是 slug；冲突 `409 DUPLICATE_ID` |
| PUT | `/articles/{res}/{id}` | 保存工作稿，见下 |
| PATCH | `/articles/{res}/{id}/visibility` | 只改可见范围，**不产生新快照** |
| POST | `/articles/{res}/{id}/publication-check` | 发布预检（§4.4） |
| POST | `/articles/{res}/{id}/publish` | 发布（§4.4） |
| POST | `/articles/{res}/{id}/unpublish` | 撤回发布，`{ baseRevision }` |
| GET | `/articles/{res}/{id}/published` | 线上快照 `PublishedArticleView`；未发布 `404 NOT_PUBLISHED` |
| DELETE | `/articles/{res}/{id}` | 头 `If-Match: <revision>`，返回 `{ deleted: true }` |
| GET | `/articles/{res}/{id}/versions?page=&page_size=` | `ArticleVersionSummary[]` |
| GET | `/articles/{res}/{id}/versions/{versionId}` | `ArticleVersion`（含 `body`） |
| POST | `/articles/{res}/{id}/versions/{versionId}/restore` | `{ baseRevision }` → `{ article, preservedVersion }` |
| GET | `/articles/{res}/{id}/export?source=working|published&format=md|zip` | 二进制（§4.5） |

### 4.3 保存工作稿（`PUT`）

```json
{
  "id": "...", "title": "...", "body": "...", "summary": null, "category": "星图",
  "tags": ["轨道"], "date": "2026-10-30", "updated": null, "mood": null, "place": null,
  "baseRevision": 7,
  "saveMode": "auto"
}
```

- `saveMode: "auto" | "manual"` —— 后端**必须用同样的校验**，但可以把自动保存的失败降级（例如只在手动保存时返回 422 的完整 `details`；自动保存返回同样的 `error` 即可，前端会显示"保存失败"并保留草稿）。
- **保存不允许改 `visibility`／`status`**：权限走 `/visibility`，发布走 `/publish`。前端不会传，后端应忽略或拒绝，以防"顺手改权限"绕过发布检查。
- 成功返回最新 `ArticleDetail`（含新 `revision`、`hasUnpublishedChanges`）。

### 4.4 发布：预检 → 发布

**预检** `POST .../publication-check`：

```json
{ "action": "publish", "baseRevision": 7, "targetVisibility": "public" }
```

```ts
data: {
  checkId: string;            // 一次性凭据，5 分钟 TTL
  expiresAt: string;
  action: "publish" | "visibility";
  targetVisibility: "public" | "private";
  checks: Array<{ code: string; severity: "info" | "warning" | "error"; message: string; fileIds?: string[] }>;
  assetDecisions: Array<{
    fileId: string; name: string; kind: FileKind;
    visibility: "public" | "private";
    options: Array<"keep-private" | "copy-public" | "make-public">;
    sharedWithPrivate: boolean;   // 该资源还被别的私密内容引用
    reason: string | null;
  }>;
  canProceed: boolean;          // 只看后端：无 error 即可继续
}
```

预检项（开发替身已实现，建议后端沿用同一套 code）：
`MISSING_TITLE`、`EMPTY_BODY`、`MISSING_SUMMARY`（warning）、`SHORT_BODY`（warning）、`DANGLING_REF`（正文引用了不存在的资源）、`PRIVATE_ASSET`（私密资源要公开，需站长决策）、`DANGLING_COVER`（书影音封面缺失）。

**发布** `POST .../publish`：

```json
{
  "baseRevision": 7,
  "checkId": "chk_...",
  "targetVisibility": "public",
  "assetDecisions": [{ "fileId": "f_img_chart", "decision": "copy-public" }],
  "confirmed": true
}
```

- 必须带 `confirmed: true`（前端在对话框里让站长明确点过），否则 `409 CONFIRM_REQUIRED`。
- `checkId` **不是"这张票存在没用过"就行**，它必须绑定下面这些字段，且由服务端**原子消费**
  （校验 + 作废在同一次操作里完成，并发请求只有一个能成功）：

  | 绑定项 | 说明 |
  |---|---|
  | 用户 | 谁申请的票就只能谁用 |
  | 对象 | `subjectType`（`article` / `shelf`）+ `subjectId`：A 文章的票不能用来发布 B |
  | 动作 | `action`（`publish` / `visibility`）：改权限的票不能用来发布 |
  | 目标可见范围 | `targetVisibility`（`public` / `private` / `null`）：预检时说 public，提交时改成 private 必须重新预检 |
  | 基础版本 | `revision`：票是按某个 revision 签发的，期间内容变了就不能用 |
  | 资源集合 | 正文里私密文件的 id 集合（排序后比对）：偷偷换图、加一张私密图都要重新预检 |
  | 有效期 | 5 分钟 TTL（`expiresAt`） |

  不符时返回 `409 CHECK_MISMATCH`（文档早期版本写的 `CHECK_EXPIRED` 仍然兼容，前端对两者都按"重新预检"处理），
  过期返回 `409 CHECK_EXPIRED`；**两种都必须重新走 `publication-check`**，不能拿旧票重试。
- 资源决策的字段名是 `{ fileId, decision }`（`decision` 取 `keep-private` / `copy-public` / `make-public`），对应预检返回的 `options` 列表。三种语义**不可混用**：
  - `keep-private`：资源保持私密，正文引用在前台显示为"受限资源"占位（`*[图片未公开：alt]*`），**公开接口里不允许残留裸 `asset:` 引用**；
  - `copy-public`：**不改原文件权限**，为这篇文章生成一份公开副本（新文件 id，原文件仍 `private`），再把正文引用换成副本的公开地址；被其它私密内容共享时的默认选项；
  - `make-public`：真的把文件本身改成公开（会影响所有引用方）。
- 正文转换在**发布时**完成：内部存 `body` 保留 `asset:` 引用（供引用计数/差异比较），
  对外快照另存一份 `publicBody`，把 `![alt](asset:id)` / `[文字](asset:id)` 换成公开 URL 或占位文案。
  `GET .../published` 返回的是 `publicBody`。
- 成功：更新 `status = published`、写 `publishedAt`／`publishedRevision`，并可生成一条 `source = "publish"` 的版本。

**改可见范围**（同样要预检）：`publication-check` 传 `action: "visibility"` + `targetVisibility`，再 `PATCH .../visibility`：

```json
{ "visibility": "public", "baseRevision": 7, "checkId": "chk_..." }
```

改可见范围**必须带 checkId**（和发布同一套绑定规则，`action` 为 `visibility`）。
前端 `applyVisibility()` 会先调预检再 PATCH；少了这张票会 `409 CHECK_EXPIRED`。

⚠️ 语义要点（前端文案也这么写）：**`visibility = public` 不等于"上线"**。文章没发布时前台仍然看不到；发布只生成快照，不改权限。二者正交。

### 4.5 导出

`GET /articles/{res}/{id}/export?source=working|published&format=md|zip`

- 响应必须是二进制，并带 `Content-Disposition: attachment; filename*=UTF-8''<urlencoded>`；前端从它取文件名（也兼容 `filename=`）。
- `format=md`：frontmatter（`id`/title/summary/category/tags/date/updated，随笔另含 mood/place）+ 正文；重新导入时这些字段会被预检/提交保留（§9）。
- `format=zip`：Markdown + 引用的资源文件（按正文里的 `asset:<fileId>` 或相对路径组织）+ 一份 `README.txt` 说明资源清单。
- `source=published` 但未发布 → `404 NOT_PUBLISHED`。
- 错误也可能以 JSON 返回：前端会把 Blob 解码回 JSON 再取 `error.message`（见 `toApiErrorAsync`），所以出错时**不要**回 200 + 空文件。

### 4.6 版本

```ts
ArticleVersionSummary { versionId; version: number; source: "manual" | "publish" | "import" | "restore";
                        createdAt; title; summary: string | null; size: number | null }
ArticleVersion extends ArticleMeta { versionId; version; source; createdAt; body; mood?; place? }
```

- 恢复：`POST .../versions/{versionId}/restore`，`{ baseRevision }` → `{ article: ArticleDetail, preservedVersion: string }`。
- 语义：**恢复不覆盖线上快照、不改权限**；当前工作稿会先被保留成一条版本（`preservedVersion`），所以恢复本身不丢东西。
- 保留条数由 `capabilities.content.versionRetention` 决定（默认 20）。

## 5. 文件库

### 5.1 形状

```ts
FileItem {
  id; name;              // name 是展示名，不是服务器路径
  ext; kind: "image" | "pdf" | "archive" | "doc" | "other";
  size; updatedAt; description; visibility;
  revision; createdAt; referenceCount;
  publicSrc: string | null;   // 私密文件必须为 null
  // —— 统一别名（P1-7）：同含义的第二种写法，前台两种都认，新代码请用这一组 ——
  mime: string | null;        // 服务端给的真实内容类型
  visible: boolean;           // = visibility === "public"
  publicUrl: string | null;   // 公开地址，等价于 publicSrc；私密时为 null
  status: "ready" | "processing" | "failed";   // 服务端处理状态（转码/查毒等），未知按 ready
}

FileReference { usage: "working" | "published" | "version" | "cover";
                owner: "notes" | "essays" | "shelf";
                targetId; title; version: number | null; isPublic: boolean }
```

### 5.2 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/files?page=&page_size=&keyword=&kind=&visibility=&unused=&sort=recent|size` | `{ items, total }` |
| GET | `/files/{id}` | `FileItem` |
| POST | `/files` | `multipart/form-data`：`file`（必填）、`description?`、`visibility?`；返回 `FileItem` |
| PUT | `/files/{id}` | 只改元数据：`{ name?, description?, visibility?, baseRevision }` |
| DELETE | `/files/{id}` | 头 `If-Match: <revision>`；仍被引用 → `409 FILE_IN_USE`，`details` = 引用清单 |
| GET | `/files/{id}/references` | `FileReference[]` |
| GET | `/files/{id}/content` | **后端待实现**：鉴权读取原始字节（`responseType: blob`） |

上传要求：

- 超过 `capabilities.upload.maxFileBytes` → `413 FILE_TOO_LARGE`；
- 扩展名／内容类型按白名单校验（`allowedExtensions`、`allowedKinds`），不许信任客户端文件名当存储路径；
- `visibility=private` 的文件**不能**经 `/uploads/public/` 直接访问；
- 公开文件只有**一种**对外地址形态：`/uploads/public/<fileId>.<ext>`（`FileItem.publicSrc`／`publicUrl` 都是这个值）。
  历史上出现过的 `/media/<id>.<ext>` 已经作废 —— 前台 Nginx 只反代 `/api/` 与 `/uploads/`，
  `/media/` 会命中 `try_files ... /index.html` 返回 200 HTML，`<img>` 解码失败且看不出原因；
- 书影音封面也走这个接口，管理端保存的是 `asset:<fileId>`（不是直链）；对外响应里另给 `coverUrl`（公开地址，私密时为 `null`）。

### 5.3 `GET /files/{id}/content`（鉴权读取）

- 需要会话凭据（Cookie 会话方案下就是 `sid`，浏览器 `fetch(...{credentials:'include'})` 自动带；当前 Bearer 方案下是 `Authorization` 头），
  `Content-Type` 用真实 MIME，带 `Content-Disposition`（下载用）；未授权返回 401，不要返回 302 到登录页（`<img>`/`fetch` 都会拿不到错误码）。
- 前端用途：私密图片在编辑器/预览/引用面板里显示、资源下载。`src/utils/media.ts` 会把它转成 blob URL 并在登录态变化时整体失效（LRU 80 条、并发合并）。

## 6. 书影音 shelf

```ts
ShelfItemDraft {
  id; kind: "book" | "film" | "music";
  title; creator: string | null; year: number | null;
  rating: number | null;                   // 0–5，允许 .5
  status: "done" | "doing" | "want";       // 消费状态，不是发布状态
  date: string | null; tags: string[] | null;
  quote: string | null; review: string | null;   // review 纯文本，空行分段
  cover: string | null;                    // asset:<fileId> | https://... | null
  link: string | null;                     // 只允许 http/https
}

ShelfItemAdmin extends ShelfItemDraft {
  publicationStatus: "draft" | "published";   // 发布状态，刻意与 status 分开
  visibility: "public" | "private";
  revision; createdAt; updatedAt;
  coverVisibility: "public" | "private" | null;  // 封面资源自身权限
  coverShared: boolean;                     // 封面被别的内容共享引用
  coverUrl: string | null;                  // 封面对外地址（/uploads/public/...）；封面私密或未发布时为 null
}
```

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/shelf?page=&page_size=&keyword=&kind=&status=&publicationStatus=&visibility=` | `{ items, total }` |
| GET | `/shelf/{id}` | `ShelfItemAdmin` |
| POST | `/shelf` | 新建（无 `baseRevision`） |
| PUT | `/shelf/{id}` | `ShelfSavePayload`＝Draft + `baseRevision` |
| PATCH | `/shelf/{id}/visibility` | `{ visibility, baseRevision, checkId }`（改可见范围必须带预检凭据） |
| DELETE | `/shelf/{id}` | 头 `If-Match` |
| POST | `/shelf/{id}/publication-check` | 同文章预检，检查项含 `DANGLING_COVER` |
| POST | `/shelf/{id}/publish` | `{ baseRevision, checkId, targetVisibility?, assetDecisions?, confirmed: true }` |
| POST | `/shelf/{id}/unpublish` | `{ baseRevision }` |

## 7. 留言 guestbook

留言正文是**访客输入**：管理端一律按纯文本渲染（`white-space: pre-wrap`），绝不 `v-html`。后端也不要用 Markdown 渲染它。

```ts
GuestbookMessage {
  id; name; email: string | null;      // email 仅管理端可见，公开接口不得返回
  site: string | null; body;           // body 是完整纯文本
  sigil: "sun" | "moon" | "mercury" | "venus" | "mars" | "jupiter" | "saturn" | null;
  status: "approved" | "blocked" | "hidden" | "pending";
  reply: { body; createdAt; updatedAt: string | null } | null;
  evidence: ModerationEvidence | null; // 命中规则的快照（§8）
  ipHash: string | null;               // 只存哈希，管理端只展示
  createdAt; revision;
}

GuestbookListItem { id; name; excerpt; status; createdAt; replied: boolean; sigil; site }
```

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/guestbook?page=&page_size=&keyword=&status=&replied=` | `{ items: GuestbookListItem[], total }`，默认时间倒序 |
| GET | `/guestbook/{id}` | `GuestbookMessage` |
| PATCH | `/guestbook/{id}` | 改状态：`{ status: "approved" | "hidden", baseRevision }`（**就是这条资源本身**，没有 `/status` 子资源） |
| PUT | `/guestbook/{id}/reply` | 覆盖式写入回复：`{ body, baseRevision }`，`body ≤ 500` |
| DELETE | `/guestbook/{id}/reply` | 删回复，`If-Match: <revision>`，返回更新后的 `GuestbookMessage` |
| DELETE | `/guestbook/{id}` | 物理删除，`If-Match: <revision>`，返回 `{ deleted: true }` |

状态语义：`approved` 已公开 / `blocked` 命中过滤规则被拦 / `hidden` 被站长隐藏 / `pending` 仅兼容历史数据（界面按"待复核"展示）。

## 8. 过滤规则 moderation

这是**站长自维护的小词表**，不是平台级审核系统，前端文案也这么写（不承诺全面拦截）。

```ts
ModerationRule {
  id; text;                                  // 词／短语，规范化后为空视为非法
  matchMode: "contains" | "exact";            // 首版不开放任意正则
  fields: Array<"name" | "body">;             // 不对邮箱做敏感词展示
  category: string;                           // 只是管理标签
  enabled: boolean; revision; createdAt; updatedAt;
}

ModerationEvidence {                          // 挂在留言上的命中快照
  ruleId: string | null; ruleText: string | null;
  field: "name" | "body"; reason: string;
  policyVersion: string | null; matchedAt: string | null;
}
```

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/moderation/rules?page=&page_size=&keyword=&enabled=` | `{ items, total }` |
| POST | `/moderation/rules` | 新建（`text/matchMode/fields/category/enabled`），重复 → `409 DUPLICATE_RULE` |
| PUT | `/moderation/rules/{id}` | 更新**或**启停（同一个端点，启停只传 `{ enabled, baseRevision }`） |
| DELETE | `/moderation/rules/{id}` | 头 `If-Match` |
| POST | `/moderation/test` | `{ name, body }` → 见下 |

```ts
data: { allowed: boolean;
        matches: Array<{ ruleId; text; matchMode; field: "name" | "body" }>;
        normalized: { name; body };        // 后端规范化后的输入，界面折叠展示
        policyVersion: string | null;
        note?: string | null }
```

**证据快照是必须的**：规则被改或删之后，旧留言仍要能解释"当时为什么被拦"，所以 `GuestbookMessage.evidence` 里存的是当时的 `ruleText`／`reason`，不是 `ruleId` 的实时关联。

## 9. 导入 imports

三步：预检 → （多候选时）选择 → 提交。

### `POST /imports/preview`

`multipart/form-data`：`file`（`.md` 或 `.zip`，≤ 40 MB）、`type`（`notes` | `essays`）。超时按 180 秒给（前端已设）。

```ts
ImportPreview {
  importId; expiresAt; type: "notes" | "essays";
  candidates: Array<{ path; title: string | null; size }>;
  selectedPath: string | null;         // ZIP 多篇时为空，需先 select
  draft: ArticleDraft | null;
  unknownFrontmatter: string[];        // 前端不认识、不会下发的字段名
  assets: Array<{ path; name; kind; size; referenced: boolean;
                  state: "matched" | "unreferenced" | "missing" | "ambiguous" | "unsupported";
                  candidates?: string[]; note?: string | null }>;
  warnings: Array<{ code; severity: "info" | "warning" | "error"; message; path?: string | null }>;
  conflicts: Array<{ id; title; updatedAt; revision }>;   // 同类型 ID 冲突候选
  committable: boolean;                 // 后端判断；false 时界面说明原因
  missingCount: number;
}
```

### `POST /imports/{importId}/select`

`{ path }` → 返回更新后的 `ImportPreview`（`selectedPath` 与该候选的 `draft`）。

### `POST /imports/{importId}/commit`

```json
{
  "mode": "create",
  "targetId": null,
  "baseRevision": null,
  "draft": { "id": "my-essay-2026", "title": "...", "summary": null, "category": null,
             "tags": null, "date": null, "updated": null, "mood": null, "place": null,
             "body": "..." },
  "includeUnreferencedPaths": []
}
```

- `draft.id`：来自 frontmatter 的稳定 ID，可空（留空时后端按标题生成 slug）；`mode=create` 时后端必须遵守显式 `id`（非法格式 422、已存在 409 `DUPLICATE_ID`）。

```ts
data: { articleId; title; createdAssets: number; linkedAssets: number; preservedVersion: string | null }
```

- `mode: "update"` 时必须带 `targetId` + `baseRevision`，且把原工作稿保护成一条版本（`preservedVersion`）；`updated` 照写，随笔的 `mood/place` 也照写。
- 未被正文引用的包内文件**默认不导入**，只有 `includeUnreferencedPaths` 里显式列出才带上。
- 提交后导入临时区即失效；此后的发布仍然要走 `publication-check` → `publish`（导入**不会**自动发布）。

### `DELETE /imports/{importId}`

释放临时区，成功 `data: null`（前端静默调用，失败不打扰站长）。

## 10. 前端如何处理这些接口（实现说明，便于后端对齐行为）

- **统一脱壳**：`src/utils/http/error.ts` 的 `unwrapEnvelope`；`envelopeError` 把 `success: false` 变成 `ApiError`（即使 HTTP 是 200）。
- **刷新令牌**：401 且不是 `/login`、`/refresh-token` 时，`src/utils/http/index.ts` 用 `refreshToken` 静默刷新并重放排队请求；刷新失败 → 排队请求一起 reject + 回登录页。
- **乐观锁**：`src/api/query.ts` 的 `ifMatch(revision)` 产出的头部值就是十进制字符串，不带引号。
- **分页参数**：`pagedQuery` 把 `pageSize` 转成 `page_size`，空值由 `buildQuery` 过滤（不会发 `keyword=` 这种空串）。
- **二进制**：导出用 `responseType: "blob"`，上传用 `multipart/form-data`（http 层会自动删掉 `Content-Type`，让浏览器带 boundary）。

## 11. 后端待实现清单

开发替身（`src/mock/`）里这三个端点已有实现，真实后端需要补上；前端的调用点都不在关键路径上，缺了会降级而不是崩：

1. **`POST /logout`** —— 撤销 refreshToken。缺了前端仍能登出（只清本地）。
2. **`GET /files/{id}/content`** —— 带鉴权的原始字节。缺了私密图片显示占位、资源下载报错，公开资源不受影响。
3. **`GET /capabilities`** —— 限制值与特性开关。缺了前端用保守兜底值（`FALLBACK_CAPABILITIES`），界面上会提示"限制值未从服务端读到"。

## 12. 后端安全清单

- 令牌用不可预测的随机值或签名 JWT；`refreshToken` 轮换、服务端可撤销；登录与刷新做限流。
- 管理与公开接口分开路由，管理接口默认全部需要认证（白名单放行 `/login`、`/refresh-token`）。
- 同源部署不需要 CORS；**不要**对 `/api/admin/*` 开 `Access-Control-Allow-Origin: *`。
- 若改用 Cookie 会话：`HttpOnly; Secure; SameSite=Strict`，并校验 `X-Requested-With`。
- 上传：服务端生成文件名，校验扩展名与真实内容类型，限制大小，私密文件不走公开静态目录。
- 记录管理操作日志（谁、什么时候、改了什么、旧值新值）。
- 留言与命中的规则文本都是不可信输入，落库前规范化、输出时按文本转义（前端已按纯文本渲染）。
