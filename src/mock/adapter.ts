/**
 * 开发替身：一个 Axios adapter，把 `/api/admin` 下的请求接到 src/mock/db.ts 的内存数据。
 *
 * 几条自我约束：
 *  1. 只实现 docs/ADMIN_API.md 里真实存在的端点——替身不能替不存在的接口“兜底”，
 *     否则页面看起来能用，接上真后端就露馅。
 *  2. 成功一律返回 `{ success: true, data }` 信封，失败返回 `{ success: false, error }`，
 *     与后端的信封保持一致，前端拦截器统一脱壳的逻辑才算被真正验证过。
 *  3. 并发写必须走 revision 检查，冲突时返回 REVISION_CONFLICT，让冲突对话框有机会出现。
 */

import type {
  AxiosAdapter,
  AxiosResponse,
  InternalAxiosRequestConfig
} from "axios";

import {
  articles,
  assetRefsIn,
  articleById,
  assetsOf,
  at,
  capabilities,
  charCount,
  clone,
  fileById,
  fileBytes,
  files,
  guestbook,
  newId,
  POLICY_VERSION,
  pushVersion,
  referencesFor,
  refreshReferenceCounts,
  rules,
  shelf,
  versionSummaries,
  versions
} from "./db";
import { createZip, readZip } from "./zip";

import type {
  ArticleDetail,
  AssetDecision,
  ContentRes,
  FileItem,
  GuestbookMessage,
  ImportAsset,
  ImportPreview,
  ModerationRule,
  PublicationCheckResult,
  ShelfItemAdmin,
  Visibility
} from "@/api/types";

/* ------------------------------------------------------------------ *
 * 响应构造
 * ------------------------------------------------------------------ */

type Headers = Record<string, string>;

function respond<T>(
  config: InternalAxiosRequestConfig,
  status: number,
  data: T,
  headers: Headers = {}
): AxiosResponse<T> {
  return {
    data,
    status,
    statusText: status < 400 ? "OK" : "Error",
    headers,
    config,
    request: null
  } as AxiosResponse<T>;
}

function ok<T>(
  config: InternalAxiosRequestConfig,
  data: T,
  headers?: Headers
): AxiosResponse {
  return respond(config, 200, { success: true, data, error: null }, headers);
}

function fail(
  config: InternalAxiosRequestConfig,
  status: number,
  code: string,
  message: string,
  details?: unknown
): AxiosResponse {
  return respond(config, status, {
    success: false,
    data: null,
    error: { code, message, details: details ?? null }
  });
}

function okBlob(
  config: InternalAxiosRequestConfig,
  blob: Blob,
  filename: string
): AxiosResponse {
  return respond(config, 200, blob, {
    "content-type": blob.type || "application/octet-stream",
    "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`
  });
}

/* ------------------------------------------------------------------ *
 * 请求解析
 * ------------------------------------------------------------------ */

function headerOf(config: InternalAxiosRequestConfig, name: string): string {
  const headers = config.headers as unknown as {
    get?: (key: string) => unknown;
    [key: string]: unknown;
  };
  const fromGetter = headers?.get?.(name);
  const value =
    fromGetter ??
    headers?.[name] ??
    headers?.[name.toLowerCase()] ??
    headers?.[name.replace(/^if-/, "If-")];
  return value == null ? "" : String(value);
}

function parseBody(config: InternalAxiosRequestConfig): Record<string, any> {
  const data = config.data as unknown;
  if (!data) return {};
  if (typeof data === "string") {
    try {
      return JSON.parse(data);
    } catch {
      return {};
    }
  }
  if (typeof data === "object" && !(data instanceof FormData)) {
    return data as Record<string, any>;
  }
  return {};
}

function splitUrl(config: InternalAxiosRequestConfig): {
  path: string;
  params: URLSearchParams;
} {
  const raw = `${config.baseURL ?? ""}${config.url ?? ""}`;
  const [beforeHash] = raw.split("#");
  const [pathname, search] = beforeHash.split("?");
  const path = pathname
    .replace(/^https?:\/\/[^/]+/, "")
    .replace(/^\/api\/admin/, "");
  const params = new URLSearchParams(search ?? "");

  // axios 的 params 是交给 adapter 去拼的：自定义 adapter 不处理的话，
  // 筛选和分页参数会全部丢掉（页面看起来“没反应”）。
  const extra = config.params as Record<string, unknown> | undefined;
  if (extra && typeof extra === "object") {
    for (const [key, value] of Object.entries(extra)) {
      if (value === undefined || value === null || value === "") continue;
      if (Array.isArray(value)) {
        for (const item of value) params.append(key, String(item));
      } else {
        params.set(key, String(value));
      }
    }
  }

  return {
    path: path || "/",
    params
  };
}

function paged<T>(items: T[], params: URLSearchParams) {
  const page = Math.max(1, Number(params.get("page") ?? 1) || 1);
  const size = Math.max(1, Number(params.get("page_size") ?? 10) || 10);
  const start = (page - 1) * size;
  return { items: items.slice(start, start + size), total: items.length };
}

function equalsAny(value: string, needle: string) {
  return value.toLowerCase().includes(needle.trim().toLowerCase());
}

/* ------------------------------------------------------------------ *
 * 鉴权（替身只做形状，不做真正的安全）
 * ------------------------------------------------------------------ */

const SESSIONS = new Map<string, string>();

function issueSession(username: string) {
  const accessToken = `stub.${newId("tok")}`;
  SESSIONS.set(accessToken, username);
  return {
    avatar: "",
    username,
    nickname: username === "admin" ? "站长" : username,
    roles: ["admin"],
    permissions: ["*:*:*"],
    accessToken,
    refreshToken: `stub.${newId("ref")}`,
    expires: new Date(Date.now() + 2 * 60 * 60 * 1000)
  };
}

function tokenValid(config: InternalAxiosRequestConfig): boolean {
  const header = headerOf(config, "Authorization");
  if (!header) return false;
  const token = header.replace(/^Bearer\s+/i, "");
  return SESSIONS.has(token) || token.startsWith("stub.");
}

/* ------------------------------------------------------------------ *
 * 文章：跟发布状态有关的重复逻辑收在这里
 * ------------------------------------------------------------------ */

function detailOf(record: (typeof articles)[number]): ArticleDetail {
  return clone({
    id: record.id,
    title: record.title,
    summary: record.summary,
    category: record.category,
    tags: record.tags,
    date: record.date,
    updated: record.updated,
    mood: record.mood ?? null,
    place: record.place ?? null,
    body: record.body,
    visibility: record.visibility,
    status: record.status,
    hasUnpublishedChanges: record.hasUnpublishedChanges,
    revision: record.revision,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    publishedAt: record.publishedAt,
    publishedRevision: record.publishedRevision,
    assets: assetsOf(record)
  }) as ArticleDetail;
}

function listItemOf(record: (typeof articles)[number]) {
  return {
    id: record.id,
    title: record.title,
    summary: record.summary,
    category: record.category,
    tags: record.tags,
    date: record.date,
    updated: record.updated,
    visibility: record.visibility,
    status: record.status,
    hasUnpublishedChanges: record.hasUnpublishedChanges,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    publishedAt: record.publishedAt,
    publishedRevision: record.publishedRevision,
    mood: record.mood ?? null,
    place: record.place ?? null,
    charCount: charCount(record.body)
  };
}

function conflict(config: InternalAxiosRequestConfig) {
  return fail(
    config,
    409,
    "REVISION_CONFLICT",
    "这条内容在你编辑期间被改过，请先看最新版本。"
  );
}

function checkRevision(
  config: InternalAxiosRequestConfig,
  current: number,
  base: unknown
): AxiosResponse | null {
  const sent = Number(base ?? headerOf(config, "If-Match"));
  if (!Number.isFinite(sent) || sent !== current) return conflict(config);
  return null;
}

function slugId(title: string, res: ContentRes): string {
  // ID 只允许 ASCII：标题里的中文一律当分隔符，再补一个短后缀保证唯一。
  // 真实后端多半也是「可读片段 + 短哈希」，替身这样生成更接近实际形态。
  const head = title
    .trim()
    .replace(/[^\x20-\x7E]+/g, "-")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 24);
  const prefix = res === "essays" ? "e" : "n";
  const suffix = Date.now().toString(36).slice(-4);
  return `${prefix}_${head ? `${head}-` : ""}${suffix}`.slice(0, 64);
}

/** 列表项里的 publishedAt 只在确实生成过快照时才有值，这里统一算一次 */

/* ------------------------------------------------------------------ *
 * 发布预检：两处（文章／书影音）都要用
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * 公开文件地址：全项目只此一个生成点
 *
 * 之前这里写的是 `/media/<id>.<ext>`，而站点的 Nginx 只反代 /api 与 /uploads，
 * 于是公开封面在线上命中 SPA 兜底、返回 200 text/html，<img> 解码失败。
 * 统一成 /uploads/public/<id>.<ext>：站点已经有 /uploads 的 location，私密文件不进这个目录。
 * ------------------------------------------------------------------ */

const PUBLIC_FILE_BASE = "/uploads/public";

function publicUrlOf(file: FileItem): string {
  return `${PUBLIC_FILE_BASE}/${file.id}.${file.ext}`;
}

/** 把文件本身转成公开（make-public），返回公开地址 */
function makeFilePublic(file: FileItem): string {
  if (file.visibility !== "public" || !file.publicSrc) {
    file.visibility = "public";
    file.revision += 1;
    file.updatedAt = new Date().toISOString();
    file.publicSrc = publicUrlOf(file);
  }
  return file.publicSrc;
}

/**
 * 复制一份公开副本（copy-public）：新 ID、新文件，原文件权限完全不动。
 * 文档要求"副本必须有新 ID，且原文件仍然私密"；
 * 之前这里不建副本、只改权限，等于把 copy-public 当成 make-public 用了。
 */
function copyFileToPublic(file: FileItem): FileItem {
  const now = new Date().toISOString();
  const copy: FileItem = {
    ...clone(file),
    id: newId("f"),
    visibility: "public",
    revision: 1,
    createdAt: now,
    updatedAt: now,
    referenceCount: 0,
    publicSrc: null
  };
  copy.publicSrc = publicUrlOf(copy);
  files.unshift(copy);
  return copy;
}

/** 把 body 里的 `![alt](asset:id)` 或 `[文本](asset:id)` 换成发布快照可用的形态 */
function publishBodyOf(body: string, decisions: Map<string, string>): string {
  const resolve = (id: string): { url: string | null; name: string } => {
    const file = fileById(id);
    if (!file) return { url: null, name: "" };
    if (file.visibility === "public") {
      return { url: file.publicSrc ?? makeFilePublic(file), name: file.name };
    }
    const decision = decisions.get(id);
    if (decision === "make-public") {
      return { url: makeFilePublic(file), name: file.name };
    }
    if (decision === "copy-public") {
      return { url: copyFileToPublic(file).publicSrc, name: file.name };
    }
    // keep-private 或根本没给决定：不能把裸 asset: 交给公开接口，
    // 也不能给一个需要鉴权、前台必然加载失败的地址。
    return { url: null, name: file.name };
  };

  return body
    .replace(
      /!\[([^\]]*)\]\(asset:([A-Za-z0-9_]+)(?:\s+"[^"]*")?\)/g,
      (_all, alt: string, id: string) => {
        const { url, name } = resolve(id);
        if (!url)
          return `*[图片未公开${alt || name ? `：${alt || name}` : ""}]*`;
        return `![${alt}](${url})`;
      }
    )
    .replace(
      /\[([^\]]+)\]\(asset:([A-Za-z0-9_]+)(?:\s+"[^"]*")?\)/g,
      (_all, text: string, id: string) => {
        const { url } = resolve(id);
        return url ? `[${text}](${url})` : `${text}（文件未公开）`;
      }
    );
}

/* ------------------------------------------------------------------ *
 * 发布预检凭据（checkId）
 *
 * 文档把 checkId 定义成"站长看过这份预检"的凭据，所以它必须绑定：
 *   申请人 / 对象类型 + 对象 id / 操作（publish|visibility） /
 *   目标可见范围 / 预检时的 revision / 预检时识别到的私密资源集合 / 有效期。
 * 只判"存在且没过期"会让 A 的凭据能发布 B、"改可见范围"的凭据能当"发布"用。
 * ------------------------------------------------------------------ */

type CheckAction = "publish" | "visibility";

interface CheckTicket {
  expiresAt: number;
  action: CheckAction;
  targetVisibility: Visibility | null;
  subjectType: "article" | "shelf";
  subjectId: string;
  revision: number;
  /** 预检时需要站长决定的私密资源 id，排序后拼接；发布时若集合变了就是过期 */
  assetIds: string;
  user: string;
}

const CHECKS = new Map<string, CheckTicket>();

const CHECK_TTL_MS = 5 * 60 * 1000;

function userOf(config: InternalAxiosRequestConfig): string {
  const token = headerOf(config, "Authorization").replace(/^Bearer\s+/i, "");
  return SESSIONS.get(token) ?? "admin";
}

function issueCheckId(ticket: Omit<CheckTicket, "expiresAt">): string {
  const checkId = newId("chk");
  CHECKS.set(checkId, { ...ticket, expiresAt: Date.now() + CHECK_TTL_MS });
  return checkId;
}

/**
 * 预检凭据的校验结果。
 *
 * 这里刻意用单一定义而不是 `{ok:true}|{ok:false}` 的联合：
 * 后台 tsconfig 是 `strict: false`（`strictNullChecks` 关闭），
 * 布尔字面量判别式在这种配置下**收窄不生效**，联合体在调用处只会报"属性不存在"。
 */
interface CheckResult {
  ok: boolean;
  ticket?: CheckTicket;
  /** 失败时的响应信息 */
  status?: number;
  code?: string;
  message?: string;
}

/** 把校验失败转成统一的错误响应（缺省就按凭据不匹配处理） */
function checkFailedResponse(
  config: InternalAxiosRequestConfig,
  result: CheckResult
): AxiosResponse {
  return fail(
    config,
    result.status ?? 409,
    result.code ?? "CHECK_MISMATCH",
    result.message ?? "预检凭据校验未通过，请重新检查。"
  );
}

function consumeCheck(
  checkId: unknown,
  expected: Omit<CheckTicket, "expiresAt">
): CheckResult {
  const key = String(checkId ?? "");
  const ticket = key ? CHECKS.get(key) : undefined;
  if (!ticket) {
    return {
      ok: false,
      status: 409,
      code: "CHECK_EXPIRED",
      message: "预检已过期，请重新检查后再发布。"
    };
  }
  // 先作废再校验：无论后面哪一项不匹配，这张凭据都不能再用第二次
  CHECKS.delete(key);
  if (ticket.expiresAt < Date.now()) {
    return {
      ok: false,
      status: 409,
      code: "CHECK_EXPIRED",
      message: "预检已过期，请重新检查后再发布。"
    };
  }
  if (ticket.user !== expected.user) {
    return {
      ok: false,
      status: 409,
      code: "CHECK_MISMATCH",
      message: "这个预检凭据不是当前登录账号申请的，请重新检查。"
    };
  }
  if (
    ticket.subjectType !== expected.subjectType ||
    ticket.subjectId !== expected.subjectId
  ) {
    return {
      ok: false,
      status: 409,
      code: "CHECK_MISMATCH",
      message: "这张预检凭据对应的不是当前这条内容，请重新检查。"
    };
  }
  if (ticket.action !== expected.action) {
    return {
      ok: false,
      status: 409,
      code: "CHECK_MISMATCH",
      message: "这张预检凭据是为另一种操作申请的，请按当前操作重新检查。"
    };
  }
  if (ticket.revision !== expected.revision) {
    return {
      ok: false,
      status: 409,
      code: "CHECK_MISMATCH",
      message: "预检之后内容又被改过，请重新检查后再发布。"
    };
  }
  if (
    (ticket.targetVisibility ?? null) !== (expected.targetVisibility ?? null)
  ) {
    return {
      ok: false,
      status: 409,
      code: "CHECK_MISMATCH",
      message: "目标可见范围和预检时不一致，请重新检查。"
    };
  }
  if (ticket.assetIds !== expected.assetIds) {
    return {
      ok: false,
      status: 409,
      code: "CHECK_MISMATCH",
      message: "预检之后资源的公开状态变了，请重新检查。"
    };
  }
  return { ok: true, ticket };
}

/** 正文里当前仍需决策的私密资源集合（排序后拼接，用作预检指纹） */
function privateAssetFingerprint(body: string): string {
  return assetRefsIn(body)
    .filter(id => fileById(id)?.visibility === "private")
    .sort()
    .join("|");
}

/**
 * 改可见范围和其他写操作一样要消费预检凭据。
 * 缺凭据时明确报错，而不是像以前那样"预检发了个 checkId，patch 根本不看"。
 */
function guardCheck(
  config: InternalAxiosRequestConfig,
  body: Record<string, any>,
  expected: Omit<CheckTicket, "expiresAt">
): AxiosResponse | null {
  const result = consumeCheck(body.checkId, expected);
  if (result.ok) return null;
  return checkFailedResponse(config, result);
}

/* ------------------------------------------------------------------ *
 * 导入：Markdown frontmatter 的最小解析
 * ------------------------------------------------------------------ */

interface Draft {
  /** 来自 frontmatter 的稳定 ID；缺省时由 commit 按标题生成 */
  id?: string;
  title: string;
  summary: string | null;
  category: string | null;
  tags: string[] | null;
  date: string | null;
  updated?: string | null;
  mood?: string | null;
  place?: string | null;
  body: string;
}

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,79}$/;

function parseMarkdown(text: string): { draft: Draft; unknown: string[] } {
  const unknown: string[] = [];
  const draft: Draft = {
    title: "",
    summary: null,
    category: null,
    tags: null,
    date: null,
    updated: null,
    mood: null,
    place: null,
    body: text
  };
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return { draft, unknown };

  draft.body = text.slice(match[0].length);
  for (const line of match[1].split(/\r?\n/)) {
    const pair = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line.trim());
    if (!pair) continue;
    const [, key, rawValue] = pair;
    const value = rawValue.trim().replace(/^["']|["']$/g, "");
    switch (key) {
      case "title":
        draft.title = value;
        break;
      case "summary":
      case "description":
        draft.summary = value || null;
        break;
      case "category":
        draft.category = value || null;
        break;
      case "date":
        draft.date = value || null;
        break;
      case "updated":
        draft.updated = value || null;
        break;
      case "mood":
        draft.mood = value || null;
        break;
      case "place":
        draft.place = value || null;
        break;
      case "id":
        draft.id = value || undefined;
        break;
      case "tags": {
        const list = value
          .replace(/^\[|\]$/g, "")
          .split(",")
          .map(item => item.trim().replace(/^["']|["']$/g, ""))
          .filter(Boolean);
        draft.tags = list.length ? list : null;
        break;
      }
      default:
        unknown.push(key);
    }
  }
  // 稳定 ID 必须符合 URL 标识规范（方案 §5.2）：只允许小写字母数字连字符。
  // 非法 ID 当作未知字段，不参与导入，由站长在确认页决定。
  if (draft.id !== undefined && !ID_PATTERN.test(draft.id)) {
    unknown.push("id");
    draft.id = undefined;
  }
  if (!draft.title) {
    const heading = /^#\s+(.+)$/m.exec(draft.body);
    draft.title = heading?.[1]?.trim() ?? "";
  }
  return { draft, unknown };
}

interface ImportSession {
  type: ContentRes;
  candidates: Array<{ path: string; title: string | null; size: number }>;
  contents: Map<string, string>;
  assets: ImportAsset[];
  warnings: ImportPreview["warnings"];
  expiresAt: number;
  selectedPath: string | null;
}

const IMPORTS = new Map<string, ImportSession>();

function previewOf(id: string, session: ImportSession): ImportPreview {
  const selected = session.selectedPath
    ? session.contents.get(session.selectedPath)
    : undefined;
  const parsed = selected ? parseMarkdown(selected) : null;

  // 以“类型 + 稳定 ID”判断候选冲突（方案 §6.1）：frontmatter 里带了 id 时，
  // 后台里同类型已有同 ID 的文章会出现在 conflicts，供站长选择“更新既有内容”。
  const conflicts = parsed?.draft?.id
    ? articles
        .filter(a => a.res === session.type && a.id === parsed.draft?.id)
        .map(a => ({
          id: a.id,
          title: a.title,
          updatedAt: a.updatedAt,
          revision: a.revision
        }))
    : [];

  return {
    importId: id,
    expiresAt: new Date(session.expiresAt).toISOString(),
    type: session.type,
    candidates: session.candidates,
    selectedPath: session.selectedPath,
    draft: parsed
      ? {
          id: parsed.draft.id ?? "",
          title: parsed.draft.title,
          summary: parsed.draft.summary,
          category: parsed.draft.category,
          tags: parsed.draft.tags,
          date: parsed.draft.date,
          updated: parsed.draft.updated ?? null,
          body: parsed.draft.body,
          mood: parsed.draft.mood ?? null,
          place: parsed.draft.place ?? null
        }
      : null,
    unknownFrontmatter: parsed?.unknown ?? [],
    assets: session.assets,
    warnings: session.warnings,
    conflicts,
    committable: !!parsed && session.assets.every(a => a.state !== "missing"),
    missingCount: session.assets.filter(a => a.state === "missing").length
  };
}

/* ------------------------------------------------------------------ *
 * 路由
 * ------------------------------------------------------------------ */

type Handler = (
  config: InternalAxiosRequestConfig,
  match: RegExpExecArray,
  params: URLSearchParams
) => AxiosResponse | Promise<AxiosResponse>;

interface Route {
  method: string;
  pattern: RegExp;
  handler: Handler;
}

const routes: Route[] = [];

function route(method: string, pattern: RegExp, handler: Handler) {
  routes.push({ method, pattern, handler });
}

/* ---------- 会话 ---------- */

route("post", /^\/login$/, config => {
  const body = parseBody(config);
  const username = String(body.username ?? "").trim();
  const password = String(body.password ?? "");
  if (!username || !password) {
    return fail(config, 422, "VALIDATION_ERROR", "请填写用户名和密码", [
      { loc: ["body", "username"], msg: "不能为空" }
    ]);
  }
  if (password.length < 6) {
    return fail(config, 401, "INVALID_CREDENTIALS", "用户名或密码不正确");
  }
  return ok(config, issueSession(username));
});

route("post", /^\/refresh-token$/, config => {
  const body = parseBody(config);
  const refreshToken = String(body.refreshToken ?? "");
  if (!refreshToken.startsWith("stub.")) {
    return fail(
      config,
      401,
      "INVALID_REFRESH_TOKEN",
      "登录状态已失效，请重新登录"
    );
  }
  const session = issueSession("admin");
  return ok(config, {
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    expires: session.expires
  });
});

route("post", /^\/logout$/, config => {
  const token = headerOf(config, "Authorization").replace(/^Bearer\s+/i, "");
  SESSIONS.delete(token);
  return ok(config, { success: true });
});

/* ---------- 能力 / 概览 ---------- */

route("get", /^\/capabilities$/, config => ok(config, clone(capabilities)));

route("get", /^\/dashboard$/, config => {
  const recentDrafts = articles
    .filter(
      article => article.hasUnpublishedChanges || article.status === "draft"
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 5)
    .map(article => ({
      res: article.res,
      id: article.id,
      title: article.title,
      updatedAt: article.updatedAt,
      status: article.status,
      hasUnpublishedChanges: article.hasUnpublishedChanges
    }));

  return ok(config, {
    stats: {
      essays: articles.filter(a => a.res === "essays").length,
      notes: articles.filter(a => a.res === "notes").length,
      shelf: shelf.length,
      files: files.length,
      blockedGuestbook: guestbook.filter(m => m.status === "blocked").length,
      pendingGuestbook: guestbook.filter(m => m.status === "pending").length
    },
    recentDrafts,
    storage: {
      usedBytes: files.reduce((sum, file) => sum + file.size, 0),
      totalBytes: 2 * 1024 * 1024 * 1024
    }
  });
});

route("get", /^\/content-options$/, config => {
  const categories = new Set<string>();
  const tags = new Set<string>();
  for (const article of articles) {
    if (article.category) categories.add(article.category);
    for (const tag of article.tags ?? []) tags.add(tag);
  }
  return ok(config, { categories: [...categories], tags: [...tags] });
});

/* ---------- 文章 ---------- */

route("get", /^\/articles\/(notes|essays)$/, (config, match, params) => {
  const res = match[1] as ContentRes;
  const keyword = (params.get("keyword") ?? "").trim();
  const status = params.get("status");
  const visibility = params.get("visibility");
  const category = params.get("category");
  const tag = params.get("tag");
  const dirtiness = params.get("hasUnpublishedChanges");

  const rows = articles
    .filter(article => article.res === res)
    .filter(
      article =>
        !keyword ||
        equalsAny(`${article.title} ${article.summary ?? ""}`, keyword)
    )
    .filter(article => !status || article.status === status)
    .filter(article => !visibility || article.visibility === visibility)
    .filter(article => !category || article.category === category)
    .filter(article => !tag || (article.tags ?? []).includes(tag))
    .filter(article =>
      dirtiness === null
        ? true
        : String(article.hasUnpublishedChanges) === dirtiness
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map(listItemOf);

  return ok(config, paged(rows, params));
});

route("post", /^\/articles\/(notes|essays)$/, (config, match) => {
  const res = match[1] as ContentRes;
  const body = parseBody(config);
  const title = String(body.title ?? "").trim();
  if (!title) {
    return fail(config, 422, "VALIDATION_ERROR", "标题不能为空", [
      { loc: ["body", "title"], msg: "不能为空" }
    ]);
  }
  const id = body.id?.trim() ? String(body.id) : slugId(title, res);
  if (articleById(res, id)) {
    return fail(
      config,
      409,
      "DUPLICATE_ID",
      "这个 ID 已经存在，换一个标题或手工指定 ID"
    );
  }
  const now = new Date().toISOString();
  const record = {
    res,
    id,
    title,
    summary: body.summary ?? null,
    category: body.category ?? null,
    tags: body.tags ?? null,
    date: body.date ?? null,
    updated: body.updated ?? null,
    mood: body.mood ?? null,
    place: body.place ?? null,
    body: String(body.body ?? ""),
    visibility: "private" as Visibility,
    status: "draft" as const,
    hasUnpublishedChanges: true,
    revision: 1,
    createdAt: now,
    updatedAt: now,
    publishedAt: null,
    publishedRevision: null,
    assets: [],
    published: null
  };
  articles.push(record);
  pushVersion(record, "manual");
  refreshReferenceCounts();
  return ok(config, detailOf(record));
});

route("get", /^\/articles\/(notes|essays)\/([^/]+)$/, (config, match) => {
  const record = articleById(match[1] as ContentRes, match[2]);
  if (!record)
    return fail(config, 404, "NOT_FOUND", "没有这篇内容，可能已被删除");
  return ok(config, detailOf(record));
});

route("put", /^\/articles\/(notes|essays)\/([^/]+)$/, (config, match) => {
  const record = articleById(match[1] as ContentRes, match[2]);
  if (!record)
    return fail(config, 404, "NOT_FOUND", "没有这篇内容，可能已被删除");
  const body = parseBody(config);
  const conflictResponse = checkRevision(
    config,
    record.revision,
    body.baseRevision
  );
  if (conflictResponse) return conflictResponse;

  const title = String(body.title ?? record.title).trim();
  if (!title) {
    return fail(config, 422, "VALIDATION_ERROR", "标题不能为空", [
      { loc: ["body", "title"], msg: "不能为空" }
    ]);
  }
  if (charCount(title) > capabilities.content.maxTitleChars) {
    return fail(
      config,
      422,
      "VALIDATION_ERROR",
      `标题不能超过 ${capabilities.content.maxTitleChars} 字`
    );
  }

  record.title = title;
  record.summary = body.summary ?? null;
  record.category = body.category ?? null;
  record.tags = body.tags ?? null;
  record.date = body.date ?? null;
  record.updated = body.updated ?? null;
  if (record.res === "essays") {
    record.mood = body.mood ?? null;
    record.place = body.place ?? null;
  }
  record.body = String(body.body ?? "");
  record.revision += 1;
  record.updatedAt = new Date().toISOString();
  record.hasUnpublishedChanges =
    record.status === "draft" || hasDiffFromSnapshot(record);

  // auto 保存只更新工作稿；manual 才留版本，避免自动保存把版本列表刷满
  if (body.saveMode === "manual") pushVersion(record, "manual");

  refreshReferenceCounts();
  return ok(config, detailOf(record));
});

function hasDiffFromSnapshot(record: (typeof articles)[number]): boolean {
  const snapshot = record.published;
  if (!snapshot) return true;
  return (
    snapshot.title !== record.title ||
    (snapshot.summary ?? "") !== (record.summary ?? "") ||
    (snapshot.category ?? "") !== (record.category ?? "") ||
    (snapshot.date ?? "") !== (record.date ?? "") ||
    JSON.stringify(snapshot.tags ?? []) !== JSON.stringify(record.tags ?? []) ||
    snapshot.body !== record.body
  );
}

route(
  "patch",
  /^\/articles\/(notes|essays)\/([^/]+)\/visibility$/,
  (config, match) => {
    const record = articleById(match[1] as ContentRes, match[2]);
    if (!record)
      return fail(config, 404, "NOT_FOUND", "没有这篇内容，可能已被删除");
    const body = parseBody(config);
    const conflictResponse = checkRevision(
      config,
      record.revision,
      body.baseRevision
    );
    if (conflictResponse) return conflictResponse;
    const visibility = body.visibility as Visibility;
    if (visibility !== "public" && visibility !== "private") {
      return fail(
        config,
        422,
        "VALIDATION_ERROR",
        "visibility 只能是 public 或 private"
      );
    }
    const checkError = guardCheck(config, body, {
      action: "visibility",
      targetVisibility: visibility,
      subjectType: "article",
      subjectId: record.id,
      revision: record.revision,
      assetIds: privateAssetFingerprint(record.body),
      user: userOf(config)
    });
    if (checkError) return checkError;
    record.visibility = visibility;
    record.revision += 1;
    record.updatedAt = new Date().toISOString();
    return ok(config, detailOf(record));
  }
);

route(
  "post",
  /^\/articles\/(notes|essays)\/([^/]+)\/publication-check$/,
  (config, match) => {
    const record = articleById(match[1] as ContentRes, match[2]);
    if (!record)
      return fail(config, 404, "NOT_FOUND", "没有这篇内容，可能已被删除");
    const body = parseBody(config);
    const conflictResponse = checkRevision(
      config,
      record.revision,
      body.baseRevision
    );
    if (conflictResponse) return conflictResponse;

    const checks: PublicationCheckResult["checks"] = [];
    if (!record.title.trim()) {
      checks.push({
        code: "MISSING_TITLE",
        severity: "error",
        message: "标题是空的。"
      });
    }
    if (!record.body.trim()) {
      checks.push({
        code: "EMPTY_BODY",
        severity: "error",
        message: "正文是空的。"
      });
    }
    if (!record.summary) {
      checks.push({
        code: "MISSING_SUMMARY",
        severity: "warning",
        message: "没有摘要，前台列表里会用正文开头代替。"
      });
    }
    if (charCount(record.body) < 40) {
      checks.push({
        code: "SHORT_BODY",
        severity: "info",
        message: "正文很短，确认这是想公开的样子。"
      });
    }

    const assetDecisions: AssetDecision[] = [];
    const dangling: string[] = [];
    for (const id of assetRefsIn(record.body)) {
      const file = fileById(id);
      if (!file) {
        dangling.push(id);
        continue;
      }
      if (file.visibility === "public") continue;
      const shared = sharedWithPrivate(file.id, {
        owner: record.res,
        targetId: record.id
      });
      assetDecisions.push({
        fileId: file.id,
        name: file.name,
        kind: file.kind,
        visibility: file.visibility,
        options: ["keep-private", "copy-public", "make-public"],
        sharedWithPrivate: shared,
        reason: shared
          ? "这张图还被其他未公开内容引用，转成公开会一起露出。"
          : "这是私密资源，公开文章看不到它。"
      });
    }
    if (dangling.length) {
      checks.push({
        code: "DANGLING_REF",
        severity: "error",
        message: `正文引用了 ${dangling.length} 个不存在的资源（${dangling.join("、")}），发布前请替换或删除。`,
        fileIds: dangling
      });
    }
    if (assetDecisions.length) {
      checks.push({
        code: "PRIVATE_ASSET",
        severity: "warning",
        message: `正文里有 ${assetDecisions.length} 个私密资源，需要逐个决定怎么处理。`,
        fileIds: assetDecisions.map(item => item.fileId)
      });
    }

    const action = body.action === "visibility" ? "visibility" : "publish";
    // 目标可见范围必须和凭据一起绑定：预检时选的是"公开"，提交时却改成"私密"，
    // 就说明两次操作之间条件变了，必须重新预检（consumeCheck 会比对不上而拒绝）。
    const targetVisibility =
      action === "visibility"
        ? ((body.targetVisibility as Visibility) ?? record.visibility)
        : ((body.targetVisibility as Visibility) ?? null);

    if (action === "visibility" && targetVisibility === "public") {
      const danglingVis = assetRefsIn(record.body).filter(id => !fileById(id));
      if (danglingVis.length) {
        checks.push({
          code: "DANGLING_REF",
          severity: "error",
          message: "正文引用了不存在的资源，先修好再改成公开。"
        });
      }
    }

    const canProceed = !checks.some(check => check.severity === "error");
    return ok(config, {
      checkId: issueCheckId({
        action,
        targetVisibility,
        subjectType: "article",
        subjectId: record.id,
        revision: record.revision,
        assetIds: privateAssetFingerprint(record.body),
        user: userOf(config)
      }),
      expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      action,
      targetVisibility,
      checks,
      // 只改可见范围不会复制或公开文件，因此不返回资源决策（与真实后端一致）
      assetDecisions: action === "publish" ? assetDecisions : [],
      canProceed
    } satisfies PublicationCheckResult);
  }
);

route(
  "post",
  /^\/articles\/(notes|essays)\/([^/]+)\/publish$/,
  (config, match) => {
    const record = articleById(match[1] as ContentRes, match[2]);
    if (!record)
      return fail(config, 404, "NOT_FOUND", "没有这篇内容，可能已被删除");
    const body = parseBody(config);
    const conflictResponse = checkRevision(
      config,
      record.revision,
      body.baseRevision
    );
    if (conflictResponse) return conflictResponse;

    const requestedVisibility =
      body.targetVisibility === undefined || body.targetVisibility === null
        ? null
        : (body.targetVisibility as Visibility);
    const decisionMap = new Map<string, string>(
      (
        (body.assetDecisions ?? []) as Array<{
          fileId: string;
          decision: string;
        }>
      ).map(item => [item.fileId, item.decision])
    );
    // publish 端点只认"为发布申请的"凭据：拿 visibility 的凭据来发布必须失败
    const checkResult = consumeCheck(body.checkId, {
      action: "publish",
      targetVisibility: requestedVisibility,
      subjectType: "article",
      subjectId: record.id,
      revision: record.revision,
      assetIds: privateAssetFingerprint(record.body),
      user: userOf(config)
    });
    if (!checkResult.ok) {
      return checkFailedResponse(config, checkResult);
    }
    if (body.confirmed !== true) {
      return fail(config, 422, "CONFIRM_REQUIRED", "发布需要明确确认检查结果");
    }

    // 站长对私密资源的决定（正文与封面同一套规则）：
    //   make-public  把文件本身转公开，其他引用它的地方也会跟着公开
    //   copy-public  只为这次发布生成一份公开副本（新 ID），原文件权限不动
    //   keep-private 保持私密，发布快照里换一句"图片未公开"，不留裸 asset: 引用
    // 真正的转换在 publishBodyOf() 里逐处进行。

    record.visibility = requestedVisibility ?? record.visibility;
    record.status = "published";
    record.hasUnpublishedChanges = false;
    record.revision += 1;
    record.publishedRevision = record.revision;
    record.publishedAt = new Date().toISOString();
    record.updatedAt = record.publishedAt;
    record.published = {
      title: record.title,
      summary: record.summary,
      category: record.category,
      tags: record.tags ? [...record.tags] : null,
      date: record.date,
      updated: record.updated,
      body: record.body,
      // 公开接口读这一份：里面的 asset: 已按站长决定换成公开地址或"图片未公开"
      publicBody: publishBodyOf(record.body, decisionMap),
      visibility: record.visibility,
      mood: record.mood ?? null,
      place: record.place ?? null,
      publishedAt: record.publishedAt,
      publishedRevision: record.revision
    };
    pushVersion(record, "publish");
    refreshReferenceCounts();
    return ok(config, detailOf(record));
  }
);

route(
  "post",
  /^\/articles\/(notes|essays)\/([^/]+)\/unpublish$/,
  (config, match) => {
    const record = articleById(match[1] as ContentRes, match[2]);
    if (!record)
      return fail(config, 404, "NOT_FOUND", "没有这篇内容，可能已被删除");
    if (record.status !== "published") {
      return fail(
        config,
        409,
        "NOT_PUBLISHED",
        "这篇当前没有在线快照，不需要撤回。"
      );
    }
    const body = parseBody(config);
    const conflictResponse = checkRevision(
      config,
      record.revision,
      body.baseRevision
    );
    if (conflictResponse) return conflictResponse;

    record.status = "draft";
    record.hasUnpublishedChanges = true;
    record.revision += 1;
    // 撤回发布等于撤掉线上快照：之后 /published 与 source=published 的导出都应当 404
    record.published = null;
    record.publishedAt = null;
    record.publishedRevision = null;
    record.updatedAt = new Date().toISOString();
    refreshReferenceCounts();
    return ok(config, detailOf(record));
  }
);

route(
  "get",
  /^\/articles\/(notes|essays)\/([^/]+)\/published$/,
  (config, match) => {
    const record = articleById(match[1] as ContentRes, match[2]);
    if (!record?.published) {
      return fail(
        config,
        404,
        "NOT_PUBLISHED",
        "这篇还没有线上快照，前台看不到。"
      );
    }
    const snapshot = record.published;
    return ok(config, {
      id: record.id,
      title: snapshot.title,
      summary: snapshot.summary,
      category: snapshot.category,
      tags: snapshot.tags,
      date: snapshot.date,
      updated: snapshot.updated,
      // 公开接口只返回对外正文：资产地址已落成公开 URL，不会漏出 asset: 引用
      body: snapshot.publicBody ?? snapshot.body,
      visibility: snapshot.visibility,
      publishedAt: snapshot.publishedAt,
      publishedRevision: snapshot.publishedRevision,
      mood: snapshot.mood ?? null,
      place: snapshot.place ?? null,
      assets: assetsOf(record)
    });
  }
);

route("delete", /^\/articles\/(notes|essays)\/([^/]+)$/, (config, match) => {
  const res = match[1] as ContentRes;
  const record = articleById(res, match[2]);
  if (!record)
    return fail(config, 404, "NOT_FOUND", "没有这篇内容，可能已经删掉了");
  const conflictResponse = checkRevision(config, record.revision, undefined);
  if (conflictResponse) return conflictResponse;

  const index = articles.indexOf(record);
  articles.splice(index, 1);
  delete versions[`${res}:${record.id}`];
  refreshReferenceCounts();
  return ok(config, { deleted: true });
});

route(
  "get",
  /^\/articles\/(notes|essays)\/([^/]+)\/versions$/,
  (config, match) => {
    const record = articleById(match[1] as ContentRes, match[2]);
    if (!record)
      return fail(config, 404, "NOT_FOUND", "没有这篇内容，可能已被删除");
    return ok(config, versionSummaries(record.res, record.id));
  }
);

route(
  "get",
  /^\/articles\/(notes|essays)\/([^/]+)\/versions\/([^/]+)$/,
  (config, match) => {
    const record = articleById(match[1] as ContentRes, match[2]);
    if (!record)
      return fail(config, 404, "NOT_FOUND", "没有这篇内容，可能已被删除");
    const list = versions[`${record.res}:${record.id}`] ?? [];
    const versionId = decodeURIComponent(match[3]);
    const version = list.find(item => item.versionId === versionId);
    if (!version) return fail(config, 404, "NOT_FOUND", "没有这个版本");
    return ok(config, version);
  }
);

route(
  "post",
  /^\/articles\/(notes|essays)\/([^/]+)\/versions\/([^/]+)\/restore$/,
  (config, match) => {
    const record = articleById(match[1] as ContentRes, match[2]);
    if (!record)
      return fail(config, 404, "NOT_FOUND", "没有这篇内容，可能已被删除");
    const body = parseBody(config);
    const conflictResponse = checkRevision(
      config,
      record.revision,
      body.baseRevision
    );
    if (conflictResponse) return conflictResponse;

    const list = versions[`${record.res}:${record.id}`] ?? [];
    const version = list.find(
      item => item.versionId === decodeURIComponent(match[3])
    );
    if (!version) return fail(config, 404, "NOT_FOUND", "没有这个版本");

    // 先把当前工作稿留成版本，再整体换成选定版本
    const preservedVersion = pushVersion(record, "manual");
    record.title = version.title;
    record.summary = version.summary;
    record.category = version.category;
    record.tags = version.tags ? [...version.tags] : null;
    record.date = version.date;
    record.updated = version.updated;
    record.body = version.body;
    record.mood = version.mood ?? null;
    record.place = version.place ?? null;
    record.revision += 1;
    record.updatedAt = new Date().toISOString();
    record.hasUnpublishedChanges =
      record.status === "draft" || hasDiffFromSnapshot(record);
    pushVersion(record, "restore");
    refreshReferenceCounts();
    return ok(config, { article: detailOf(record), preservedVersion });
  }
);

route(
  "get",
  /^\/articles\/(notes|essays)\/([^/]+)\/export$/,
  (config, match, params) => {
    const record = articleById(match[1] as ContentRes, match[2]);
    if (!record)
      return fail(config, 404, "NOT_FOUND", "没有这篇内容，可能已被删除");

    const source =
      params.get("source") === "published" ? "published" : "working";
    const format = params.get("format") === "zip" ? "zip" : "md";
    const snapshot = record.published;

    if (source === "published" && !snapshot) {
      return fail(
        config,
        404,
        "NOT_PUBLISHED",
        "这篇没有线上快照，只能导出工作稿。"
      );
    }

    const title =
      source === "published" && snapshot ? snapshot.title : record.title;
    const summary =
      source === "published" && snapshot ? snapshot.summary : record.summary;
    const body =
      source === "published" && snapshot ? snapshot.body : record.body;
    const category =
      source === "published" && snapshot ? snapshot.category : record.category;
    const date =
      source === "published" && snapshot ? snapshot.date : record.date;
    const tags =
      source === "published" && snapshot ? snapshot.tags : record.tags;
    const updated =
      source === "published" && snapshot ? snapshot.updated : record.updated;
    // 随笔才写心境/地点：导出时保留这些元信息，重新导入后不丢失（方案 §6.3）
    const mood =
      record.res === "essays"
        ? source === "published" && snapshot
          ? snapshot.mood
          : record.mood
        : null;
    const place =
      record.res === "essays"
        ? source === "published" && snapshot
          ? snapshot.place
          : record.place
        : null;

    const front = [
      "---",
      `title: ${title}`,
      `id: ${record.id}`,
      summary ? `summary: ${summary}` : "",
      category ? `category: ${category}` : "",
      tags?.length ? `tags: [${tags.join(", ")}]` : "",
      date ? `date: ${date}` : "",
      updated ? `updated: ${updated}` : "",
      mood ? `mood: ${mood}` : "",
      place ? `place: ${place}` : "",
      "---",
      ""
    ]
      .filter(Boolean)
      .join("\n");

    const markdown = `${front}\n${body}\n`;
    const base = `${record.res}-${record.id}`;

    if (format === "md") {
      return okBlob(
        config,
        new Blob([markdown], { type: "text/markdown;charset=utf-8" }),
        `${base}.md`
      );
    }

    const assetPaths = new Set(assetRefsIn(body));
    const entries = [
      {
        path: `${base}.md`,
        data: new TextEncoder().encode(markdown)
      },
      ...(assetPaths.size
        ? [
            {
              path: "README.txt",
              data: new TextEncoder().encode(
                `这个包由开发替身生成。真实后端会把以下资源一并打包：\n${[...assetPaths].join("\n")}\n`
              )
            }
          ]
        : [])
    ];
    return okBlob(config, createZip(entries), `${base}.zip`);
  }
);

/* ---------- 文件库 ---------- */

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  avif: "image/avif",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  zip: "application/zip",
  md: "text/markdown; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
};

/**
 * 文件序列化：旧字段与新版契约字段一起返回。
 * 前台曾经只认 `src`、后台只发 `publicSrc`，接真后端时"字段名对不上"会直接丢图，
 * 所以两种叫法同时存在，任一侧都能读到。
 */
function fileOut(file: FileItem): FileItem {
  return {
    ...clone(file),
    mime: MIME_BY_EXT[file.ext] ?? "application/octet-stream",
    visible: file.visibility === "public",
    publicUrl:
      file.visibility === "public"
        ? (file.publicSrc ?? publicUrlOf(file))
        : null,
    status: "ready"
  };
}

function fileKindOf(name: string): FileItem["kind"] {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (["png", "jpg", "jpeg", "webp", "gif", "svg", "avif"].includes(ext))
    return "image";
  if (ext === "pdf") return "pdf";
  if (["zip", "rar", "7z", "tar", "gz"].includes(ext)) return "archive";
  if (["doc", "docx", "xls", "xlsx", "ppt", "pptx", "md", "txt"].includes(ext))
    return "doc";
  return "other";
}

route("get", /^\/files$/, (config, _match, params) => {
  const keyword = (params.get("keyword") ?? "").trim();
  const kind = params.get("kind");
  const visibility = params.get("visibility");
  const unused = params.get("unused");
  const sort = params.get("sort");

  const rows = files
    .filter(file => !keyword || equalsAny(file.name, keyword))
    .filter(file => !kind || file.kind === kind)
    .filter(file => !visibility || file.visibility === visibility)
    .filter(file => unused !== "true" || file.referenceCount === 0)
    .sort((a, b) =>
      sort === "size"
        ? b.size - a.size
        : (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "")
    )
    .map(file => fileOut(file));

  return ok(config, paged(rows, params));
});

route("get", /^\/files\/([^/]+)$/, (config, match) => {
  const file = fileById(decodeURIComponent(match[1]));
  if (!file) return fail(config, 404, "NOT_FOUND", "没有这个文件");
  return ok(config, fileOut(file));
});

route("post", /^\/files$/, async config => {
  const form = config.data as unknown as FormData;
  if (!(form instanceof FormData)) {
    return fail(
      config,
      422,
      "VALIDATION_ERROR",
      "上传需要 multipart/form-data"
    );
  }
  const uploaded = form.get("file");
  if (!(uploaded instanceof File)) {
    return fail(config, 422, "VALIDATION_ERROR", "没有收到文件");
  }
  const ext = uploaded.name.split(".").pop()?.toLowerCase() ?? "";
  if (!capabilities.upload.allowedExtensions.includes(ext)) {
    return fail(config, 415, "UNSUPPORTED_TYPE", `不支持 .${ext} 类型的文件`);
  }
  if (uploaded.size > capabilities.upload.maxFileBytes) {
    return fail(
      config,
      413,
      "FILE_TOO_LARGE",
      `文件超过 ${Math.round(capabilities.upload.maxFileBytes / 1024 / 1024)}MB 上限`
    );
  }

  const now = new Date().toISOString();
  const file: FileItem = {
    id: newId("f"),
    name: uploaded.name,
    ext,
    kind: fileKindOf(uploaded.name),
    size: uploaded.size,
    updatedAt: now,
    description: null,
    visibility: "private",
    revision: 1,
    createdAt: now,
    referenceCount: 0,
    publicSrc: null
  };
  files.unshift(file);
  fileBytes.set(file.id, uploaded);
  return ok(config, fileOut(file));
});

route("put", /^\/files\/([^/]+)$/, (config, match) => {
  const file = fileById(decodeURIComponent(match[1]));
  if (!file) return fail(config, 404, "NOT_FOUND", "没有这个文件");
  const body = parseBody(config);
  const conflictResponse = checkRevision(
    config,
    file.revision,
    body.baseRevision
  );
  if (conflictResponse) return conflictResponse;

  if (typeof body.name === "string" && body.name.trim()) {
    file.name = body.name.trim();
    file.ext = file.name.split(".").pop()?.toLowerCase() ?? file.ext;
  }
  if (body.description !== undefined)
    file.description = body.description ?? null;
  if (body.visibility === "public" || body.visibility === "private") {
    file.visibility = body.visibility;
    file.publicSrc = body.visibility === "public" ? publicUrlOf(file) : null;
  }
  file.revision += 1;
  file.updatedAt = new Date().toISOString();
  return ok(config, fileOut(file));
});

route("get", /^\/files\/([^/]+)\/references$/, (config, match) => {
  const file = fileById(decodeURIComponent(match[1]));
  if (!file) return fail(config, 404, "NOT_FOUND", "没有这个文件");
  return ok(config, referencesFor(file.id));
});

route("delete", /^\/files\/([^/]+)$/, (config, match) => {
  const file = fileById(decodeURIComponent(match[1]));
  if (!file) return fail(config, 404, "NOT_FOUND", "没有这个文件");
  const conflictResponse = checkRevision(config, file.revision, undefined);
  if (conflictResponse) return conflictResponse;

  const refs = referencesFor(file.id);
  if (refs.length) {
    return fail(
      config,
      409,
      "FILE_IN_USE",
      `这个文件还被 ${refs.length} 处内容引用，先解除引用再删除。`
    );
  }
  const index = files.indexOf(file);
  files.splice(index, 1);
  fileBytes.delete(file.id);
  return ok(config, { deleted: true });
});

/** 私密资源的鉴权读取：media.ts 直接要 Blob */
route("get", /^\/files\/([^/]+)\/content$/, (config, match) => {
  const file = fileById(decodeURIComponent(match[1]));
  if (!file) return fail(config, 404, "NOT_FOUND", "没有这个文件");
  const blob = fileBytes.get(file.id);
  if (!blob) return fail(config, 404, "NO_CONTENT", "这个文件没有可读取的内容");
  return respond(config, 200, blob, {
    "content-type": blob.type || "application/octet-stream"
  });
});

/* ---------- 书影音 ---------- */

route("get", /^\/shelf$/, (config, _match, params) => {
  const keyword = (params.get("keyword") ?? "").trim();
  const kind = params.get("kind");
  const status = params.get("status");
  const publicationStatus = params.get("publicationStatus");
  const visibility = params.get("visibility");

  const rows = shelf
    .filter(
      item =>
        !keyword || equalsAny(`${item.title} ${item.creator ?? ""}`, keyword)
    )
    .filter(item => !kind || item.kind === kind)
    .filter(item => !status || item.status === status)
    .filter(
      item => !publicationStatus || item.publicationStatus === publicationStatus
    )
    .filter(item => !visibility || item.visibility === visibility)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map(item => clone(item));

  return ok(config, paged(rows, params));
});

route("get", /^\/shelf\/([^/]+)$/, (config, match) => {
  const item = shelf.find(entry => entry.id === decodeURIComponent(match[1]));
  if (!item) return fail(config, 404, "NOT_FOUND", "没有这条记录");
  return ok(config, clone(item));
});

function shelfFromBody(
  body: Record<string, any>,
  base?: ShelfItemAdmin
): ShelfItemAdmin {
  const now = new Date().toISOString();
  return {
    id: base?.id ?? newId("s"),
    kind: body.kind ?? base?.kind ?? "book",
    title: String(body.title ?? base?.title ?? "").trim(),
    creator: body.creator ?? null,
    year: body.year ?? null,
    rating: body.rating ?? null,
    status: body.status ?? base?.status ?? "done",
    date: body.date ?? null,
    tags: body.tags ?? null,
    quote: body.quote ?? null,
    review: body.review ?? null,
    cover: body.cover ?? null,
    link: body.link ?? null,
    publicationStatus: base?.publicationStatus ?? "draft",
    visibility: base?.visibility ?? "private",
    revision: (base?.revision ?? 0) + 1,
    createdAt: base?.createdAt ?? now,
    updatedAt: now,
    coverVisibility: null,
    coverShared: false
  };
}

/**
 * 与后端 sharedWithPrivate 一致：只看"仍未公开、且不是已发布快照"的引用，
 * 并排除条目自身的 cover 引用。仅仅"被引用过"不算共享。
 */
function sharedWithPrivate(
  fileId: string,
  exclude?: { owner: "notes" | "essays" | "shelf"; targetId: string }
): boolean {
  return referencesFor(fileId).some(
    ref =>
      !ref.isPublic &&
      ref.usage !== "published" &&
      !(
        exclude &&
        ref.owner === exclude.owner &&
        ref.targetId === exclude.targetId
      )
  );
}

function withCoverInfo(item: ShelfItemAdmin): ShelfItemAdmin {
  const result = clone(item);
  if (item.cover?.startsWith("asset:")) {
    const file = fileById(item.cover.slice("asset:".length));
    result.coverVisibility = file?.visibility ?? null;
    result.coverShared = file
      ? sharedWithPrivate(file.id, { owner: "shelf", targetId: item.id })
      : false;
    // 公开接口只认这个地址：封面文件没公开时必须是 null，
    // 否则前台会拿到一个需要登录、或者根本不存在于 /uploads/public 的地址。
    result.coverUrl =
      file && file.visibility === "public"
        ? (file.publicSrc ?? publicUrlOf(file))
        : null;
  } else {
    result.coverVisibility = null;
    result.coverShared = false;
    // 站长也可以直接填一个外部图片地址，这种原样透出
    result.coverUrl = item.cover ?? null;
  }
  return result;
}

route("post", /^\/shelf$/, config => {
  const body = parseBody(config);
  if (!String(body.title ?? "").trim()) {
    return fail(config, 422, "VALIDATION_ERROR", "标题不能为空", [
      { loc: ["body", "title"], msg: "不能为空" }
    ]);
  }
  const item = shelfFromBody(body);
  shelf.unshift(item);
  refreshReferenceCounts();
  return ok(config, withCoverInfo(item));
});

route("put", /^\/shelf\/([^/]+)$/, (config, match) => {
  const item = shelf.find(entry => entry.id === decodeURIComponent(match[1]));
  if (!item) return fail(config, 404, "NOT_FOUND", "没有这条记录");
  const body = parseBody(config);
  const conflictResponse = checkRevision(
    config,
    item.revision,
    body.baseRevision
  );
  if (conflictResponse) return conflictResponse;

  const updated = shelfFromBody(body, item);
  Object.assign(item, updated);
  refreshReferenceCounts();
  return ok(config, withCoverInfo(item));
});

route("patch", /^\/shelf\/([^/]+)\/visibility$/, (config, match) => {
  const item = shelf.find(entry => entry.id === decodeURIComponent(match[1]));
  if (!item) return fail(config, 404, "NOT_FOUND", "没有这条记录");
  const body = parseBody(config);
  const conflictResponse = checkRevision(
    config,
    item.revision,
    body.baseRevision
  );
  if (conflictResponse) return conflictResponse;
  if (body.visibility !== "public" && body.visibility !== "private") {
    return fail(
      config,
      422,
      "VALIDATION_ERROR",
      "visibility 只能是 public 或 private"
    );
  }
  const checkError = guardCheck(config, body, {
    action: "visibility",
    targetVisibility: body.visibility as Visibility,
    subjectType: "shelf",
    subjectId: item.id,
    revision: item.revision,
    assetIds:
      item.cover?.startsWith("asset:") &&
      fileById(item.cover.slice("asset:".length))?.visibility === "private"
        ? item.cover.slice("asset:".length)
        : "",
    user: userOf(config)
  });
  if (checkError) return checkError;
  item.visibility = body.visibility;
  item.revision += 1;
  item.updatedAt = new Date().toISOString();
  return ok(config, withCoverInfo(item));
});

route("delete", /^\/shelf\/([^/]+)$/, (config, match) => {
  const item = shelf.find(entry => entry.id === decodeURIComponent(match[1]));
  if (!item) return fail(config, 404, "NOT_FOUND", "没有这条记录");
  const conflictResponse = checkRevision(config, item.revision, undefined);
  if (conflictResponse) return conflictResponse;
  shelf.splice(shelf.indexOf(item), 1);
  refreshReferenceCounts();
  return ok(config, { deleted: true });
});

route("post", /^\/shelf\/([^/]+)\/publication-check$/, (config, match) => {
  const item = shelf.find(entry => entry.id === decodeURIComponent(match[1]));
  if (!item) return fail(config, 404, "NOT_FOUND", "没有这条记录");
  const body = parseBody(config);
  const conflictResponse = checkRevision(
    config,
    item.revision,
    body.baseRevision
  );
  if (conflictResponse) return conflictResponse;

  const checks: PublicationCheckResult["checks"] = [];
  const assetDecisions: AssetDecision[] = [];
  if (!item.title.trim()) {
    checks.push({
      code: "MISSING_TITLE",
      severity: "error",
      message: "标题是空的。"
    });
  }
  if (!item.quote && !item.review) {
    checks.push({
      code: "NO_REVIEW",
      severity: "warning",
      message: "没有短评也没有引用，公开后只是一条书目信息。"
    });
  }
  if (item.cover?.startsWith("asset:")) {
    const file = fileById(item.cover.slice("asset:".length));
    if (!file) {
      checks.push({
        code: "DANGLING_COVER",
        severity: "error",
        message: "封面引用的文件不存在了，换一张或清空封面。"
      });
    } else if (file.visibility === "private") {
      const shared = sharedWithPrivate(file.id, {
        owner: "shelf",
        targetId: item.id
      });
      assetDecisions.push({
        fileId: file.id,
        name: file.name,
        kind: file.kind,
        visibility: file.visibility,
        options: ["keep-private", "copy-public", "make-public"],
        sharedWithPrivate: shared,
        reason: shared
          ? "封面还被其他未公开内容引用，转成公开会一起露出。"
          : "封面是私密资源，公开后访客看不到这张图。"
      });
    }
  }

  const action = body.action === "visibility" ? "visibility" : "publish";
  const targetVisibility =
    action === "visibility"
      ? ((body.targetVisibility as Visibility) ?? item.visibility)
      : ((body.targetVisibility as Visibility) ?? null);
  const coverPrivate =
    item.cover?.startsWith("asset:") &&
    fileById(item.cover.slice("asset:".length))?.visibility === "private";
  return ok(config, {
    checkId: issueCheckId({
      action,
      targetVisibility,
      subjectType: "shelf",
      subjectId: item.id,
      revision: item.revision,
      assetIds: coverPrivate ? item.cover!.slice("asset:".length) : "",
      user: userOf(config)
    }),
    expiresAt: new Date(Date.now() + CHECK_TTL_MS).toISOString(),
    action,
    targetVisibility,
    checks,
    assetDecisions: action === "publish" ? assetDecisions : [],
    canProceed: !checks.some(check => check.severity === "error")
  } satisfies PublicationCheckResult);
});

route("post", /^\/shelf\/([^/]+)\/publish$/, (config, match) => {
  const item = shelf.find(entry => entry.id === decodeURIComponent(match[1]));
  if (!item) return fail(config, 404, "NOT_FOUND", "没有这条记录");
  const body = parseBody(config);
  const conflictResponse = checkRevision(
    config,
    item.revision,
    body.baseRevision
  );
  if (conflictResponse) return conflictResponse;
  const requestedVisibility =
    body.targetVisibility === undefined || body.targetVisibility === null
      ? null
      : (body.targetVisibility as Visibility);
  const decisions = new Map<string, string>(
    (
      (body.assetDecisions ?? []) as Array<{
        fileId: string;
        decision: string;
      }>
    ).map(entry => [entry.fileId, entry.decision])
  );
  const coverFile = item.cover?.startsWith("asset:")
    ? fileById(item.cover.slice("asset:".length))
    : undefined;
  const checkResult = consumeCheck(body.checkId, {
    action: "publish",
    targetVisibility: requestedVisibility,
    subjectType: "shelf",
    subjectId: item.id,
    revision: item.revision,
    assetIds:
      coverFile && coverFile.visibility === "private" ? coverFile.id : "",
    user: userOf(config)
  });
  if (!checkResult.ok) {
    return checkFailedResponse(config, checkResult);
  }

  // 封面的处理与正文里的图片完全同一套规则：
  //   make-public  文件本身转公开，封面仍指向它
  //   copy-public  建一份新 ID 的公开副本，封面改指向副本，原文件继续私密
  //   keep-private 封面保持私密，公开接口拿到的 coverUrl 是 null
  if (coverFile && coverFile.visibility === "private") {
    const decision = decisions.get(coverFile.id);
    if (decision === "make-public") {
      makeFilePublic(coverFile);
    } else if (decision === "copy-public") {
      item.cover = `asset:${copyFileToPublic(coverFile).id}`;
    }
  }

  item.publicationStatus = "published";
  item.visibility = requestedVisibility ?? item.visibility;
  item.revision += 1;
  item.updatedAt = new Date().toISOString();
  refreshReferenceCounts();
  return ok(config, withCoverInfo(item));
});

route("post", /^\/shelf\/([^/]+)\/unpublish$/, (config, match) => {
  const item = shelf.find(entry => entry.id === decodeURIComponent(match[1]));
  if (!item) return fail(config, 404, "NOT_FOUND", "没有这条记录");
  if (item.publicationStatus !== "published") {
    return fail(config, 409, "NOT_PUBLISHED", "这条当前还没有发布。");
  }
  const body = parseBody(config);
  const conflictResponse = checkRevision(
    config,
    item.revision,
    body.baseRevision
  );
  if (conflictResponse) return conflictResponse;
  item.publicationStatus = "draft";
  item.revision += 1;
  item.updatedAt = new Date().toISOString();
  return ok(config, withCoverInfo(item));
});

/* ---------- 留言 ---------- */

function guestbookDetail(item: GuestbookMessage): GuestbookMessage {
  return clone(item);
}

route("get", /^\/guestbook$/, (config, _match, params) => {
  const keyword = (params.get("keyword") ?? "").trim();
  const status = params.get("status");
  const replied = params.get("replied");

  const rows = guestbook
    .filter(item => !keyword || equalsAny(`${item.name} ${item.body}`, keyword))
    .filter(item => !status || item.status === status)
    .filter(item =>
      replied === null ? true : String(!!item.reply) === replied
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(item => ({
      id: item.id,
      name: item.name,
      excerpt: item.body.slice(0, 60),
      status: item.status,
      createdAt: item.createdAt,
      replied: !!item.reply,
      sigil: item.sigil,
      site: item.site
    }));

  return ok(config, paged(rows, params));
});

route("get", /^\/guestbook\/([^/]+)$/, (config, match) => {
  const item = guestbook.find(
    entry => entry.id === decodeURIComponent(match[1])
  );
  if (!item) return fail(config, 404, "NOT_FOUND", "没有这条留言");
  return ok(config, guestbookDetail(item));
});

route("put", /^\/guestbook\/([^/]+)\/reply$/, (config, match) => {
  const item = guestbook.find(
    entry => entry.id === decodeURIComponent(match[1])
  );
  if (!item) return fail(config, 404, "NOT_FOUND", "没有这条留言");
  const body = parseBody(config);
  const conflictResponse = checkRevision(
    config,
    item.revision,
    body.baseRevision
  );
  if (conflictResponse) return conflictResponse;

  const text = String(body.body ?? "").trim();
  if (!text) {
    return fail(config, 422, "VALIDATION_ERROR", "回复不能为空");
  }
  if (charCount(text) > 500) {
    return fail(config, 422, "VALIDATION_ERROR", "回复不能超过 500 字");
  }
  const now = new Date().toISOString();
  item.reply = {
    body: text,
    createdAt: item.reply?.createdAt ?? now,
    updatedAt: item.reply ? now : null
  };
  item.revision += 1;
  return ok(config, guestbookDetail(item));
});

route("delete", /^\/guestbook\/([^/]+)\/reply$/, (config, match) => {
  const item = guestbook.find(
    entry => entry.id === decodeURIComponent(match[1])
  );
  if (!item) return fail(config, 404, "NOT_FOUND", "没有这条留言");
  const conflictResponse = checkRevision(config, item.revision, undefined);
  if (conflictResponse) return conflictResponse;
  item.reply = null;
  item.revision += 1;
  return ok(config, guestbookDetail(item));
});

route("patch", /^\/guestbook\/([^/]+)$/, (config, match) => {
  const item = guestbook.find(
    entry => entry.id === decodeURIComponent(match[1])
  );
  if (!item) return fail(config, 404, "NOT_FOUND", "没有这条留言");
  const body = parseBody(config);
  const conflictResponse = checkRevision(
    config,
    item.revision,
    body.baseRevision
  );
  if (conflictResponse) return conflictResponse;
  if (body.status !== "approved" && body.status !== "hidden") {
    return fail(
      config,
      422,
      "VALIDATION_ERROR",
      "状态只能改成 approved 或 hidden"
    );
  }
  item.status = body.status;
  item.revision += 1;
  return ok(config, guestbookDetail(item));
});

route("delete", /^\/guestbook\/([^/]+)$/, (config, match) => {
  const item = guestbook.find(
    entry => entry.id === decodeURIComponent(match[1])
  );
  if (!item) return fail(config, 404, "NOT_FOUND", "没有这条留言");
  const conflictResponse = checkRevision(config, item.revision, undefined);
  if (conflictResponse) return conflictResponse;
  guestbook.splice(guestbook.indexOf(item), 1);
  return ok(config, { deleted: true });
});

/* ---------- 过滤规则 ---------- */

route("get", /^\/moderation\/rules$/, (config, _match, params) => {
  const keyword = (params.get("keyword") ?? "").trim();
  const enabled = params.get("enabled");

  const rows = rules
    .filter(
      rule => !keyword || equalsAny(`${rule.text} ${rule.category}`, keyword)
    )
    .filter(rule => enabled === null || String(rule.enabled) === enabled)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map(rule => clone(rule));

  return ok(config, paged(rows, params));
});

route("post", /^\/moderation\/rules$/, config => {
  const body = parseBody(config);
  const text = String(body.text ?? "").trim();
  if (!text) {
    return fail(config, 422, "VALIDATION_ERROR", "规则内容不能为空", [
      { loc: ["body", "text"], msg: "不能为空" }
    ]);
  }
  if (rules.some(rule => rule.text === text)) {
    return fail(config, 409, "DUPLICATE_RULE", "已经有一条一样的规则了");
  }
  const now = new Date().toISOString();
  const rule: ModerationRule = {
    id: newId("r"),
    text,
    matchMode: body.matchMode === "exact" ? "exact" : "contains",
    fields:
      Array.isArray(body.fields) && body.fields.length ? body.fields : ["body"],
    category: String(body.category ?? "自定义屏蔽"),
    enabled: body.enabled !== false,
    revision: 1,
    createdAt: now,
    updatedAt: now
  };
  rules.unshift(rule);
  return ok(config, clone(rule));
});

route("put", /^\/moderation\/rules\/([^/]+)$/, (config, match) => {
  const rule = rules.find(entry => entry.id === decodeURIComponent(match[1]));
  if (!rule) return fail(config, 404, "NOT_FOUND", "没有这条规则");
  const body = parseBody(config);
  const conflictResponse = checkRevision(
    config,
    rule.revision,
    body.baseRevision
  );
  if (conflictResponse) return conflictResponse;

  if (typeof body.text === "string") rule.text = body.text.trim();
  if (body.matchMode === "exact" || body.matchMode === "contains") {
    rule.matchMode = body.matchMode;
  }
  if (Array.isArray(body.fields) && body.fields.length)
    rule.fields = body.fields;
  if (typeof body.category === "string" && body.category)
    rule.category = body.category;
  if (typeof body.enabled === "boolean") rule.enabled = body.enabled;
  rule.revision += 1;
  rule.updatedAt = new Date().toISOString();
  return ok(config, clone(rule));
});

route("delete", /^\/moderation\/rules\/([^/]+)$/, (config, match) => {
  const rule = rules.find(entry => entry.id === decodeURIComponent(match[1]));
  if (!rule) return fail(config, 404, "NOT_FOUND", "没有这条规则");
  const conflictResponse = checkRevision(config, rule.revision, undefined);
  if (conflictResponse) return conflictResponse;
  rules.splice(rules.indexOf(rule), 1);
  return ok(config, { deleted: true });
});

route("post", /^\/moderation\/test$/, config => {
  const body = parseBody(config);
  const name = String(body.name ?? "");
  const text = String(body.body ?? "");
  const normalized = {
    name: name.trim().replace(/\s+/g, " "),
    body: text.trim().replace(/\s+/g, " ")
  };

  const matches: Array<{
    ruleId: string;
    text: string;
    matchMode: string;
    field: "name" | "body";
  }> = [];

  for (const rule of rules) {
    if (!rule.enabled) continue;
    for (const field of rule.fields) {
      const haystack = field === "name" ? normalized.name : normalized.body;
      const hit =
        rule.matchMode === "exact"
          ? haystack === rule.text
          : haystack.includes(rule.text);
      if (hit) {
        matches.push({
          ruleId: rule.id,
          text: rule.text,
          matchMode: rule.matchMode,
          field
        });
      }
    }
  }

  return ok(config, {
    allowed: matches.length === 0,
    matches,
    normalized,
    policyVersion: POLICY_VERSION,
    note: "开发替身的匹配只是朴素的包含／相等判断，不代表真实后端的规范化过程。"
  });
});

/* ---------- 导入 ---------- */

route("post", /^\/imports\/preview$/, async config => {
  const form = config.data as unknown as FormData;
  if (!(form instanceof FormData)) {
    return fail(
      config,
      422,
      "VALIDATION_ERROR",
      "导入需要 multipart/form-data"
    );
  }
  const uploaded = form.get("file");
  const type = (
    form.get("type") === "essays" ? "essays" : "notes"
  ) as ContentRes;
  if (!(uploaded instanceof File)) {
    return fail(config, 422, "VALIDATION_ERROR", "没有收到文件");
  }

  const contents = new Map<string, string>();
  const assets: ImportAsset[] = [];
  const warnings: ImportPreview["warnings"] = [];
  const extension = uploaded.name.split(".").pop()?.toLowerCase() ?? "";

  if (extension === "zip") {
    if (uploaded.size > capabilities.import.maxArchiveBytes) {
      return fail(config, 413, "ARCHIVE_TOO_LARGE", "压缩包超过上限");
    }
    const { entries, skipped } = await readZip(await uploaded.arrayBuffer());
    if (skipped.length) {
      warnings.push({
        code: "ENTRY_UNREADABLE",
        severity: "warning",
        message: `有 ${skipped.length} 个条目读不出来（流式写入的 zip 暂不支持），已跳过。`
      });
    }
    for (const entry of entries) {
      const name = entry.path.split("/").pop() ?? entry.path;
      if (/\.(md|markdown)$/i.test(entry.path)) {
        contents.set(entry.path, new TextDecoder().decode(entry.data));
        continue;
      }
      if (entry.path.startsWith("__MACOSX/") || name.startsWith(".")) continue;
      const existing = files.find(file => file.name === name);
      assets.push({
        path: entry.path,
        name,
        kind: fileKindOf(name),
        size: entry.data.length,
        referenced: false,
        state: existing ? "matched" : "unreferenced",
        note: existing ? `文件库里已有同名文件：${existing.name}` : null
      });
    }
  } else if (/\.(md|markdown|txt)$/i.test(uploaded.name)) {
    contents.set(uploaded.name, await uploaded.text());
  } else {
    return fail(
      config,
      415,
      "UNSUPPORTED_TYPE",
      "只接受 .md 或 .zip；.md 直接进入确认步骤，.zip 会展开出候选与资源。"
    );
  }

  if (!contents.size) {
    return fail(config, 422, "NO_CANDIDATE", "这个包里没有找到 Markdown 文件");
  }

  const candidates = [...contents.entries()].map(([path, text]) => ({
    path,
    title: parseMarkdown(text).draft.title || null,
    size: new Blob([text]).size
  }));

  // 正文里出现 asset: 引用就算“被引用”，其余算未引用
  const allText = [...contents.values()].join("\n");
  const referencedNames = new Set(
    assetRefsInPath(allText).map(ref => ref.split("/").pop() ?? ref)
  );
  for (const asset of assets) {
    if (referencedNames.has(asset.name)) {
      asset.referenced = true;
      if (asset.state === "unreferenced") asset.state = "matched";
    }
  }

  const importId = newId("imp");
  const session: ImportSession = {
    type,
    candidates,
    contents,
    assets,
    warnings,
    expiresAt: Date.now() + 30 * 60 * 1000,
    selectedPath: candidates.length === 1 ? candidates[0].path : null
  };
  IMPORTS.set(importId, session);
  return ok(config, previewOf(importId, session));
});

/** 图片引用既可能写 asset:id，也可能写相对路径，两者都当作“被引用” */
function assetRefsInPath(text: string): string[] {
  const found = new Set(assetRefsIn(text));
  const pattern = /!\[[^\]]*\]\(([^)\s]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (!/^https?:/.test(match[1])) found.add(match[1]);
  }
  return [...found];
}

route("post", /^\/imports\/([^/]+)\/select$/, (config, match) => {
  const session = IMPORTS.get(decodeURIComponent(match[1]));
  if (!session)
    return fail(config, 404, "IMPORT_EXPIRED", "这次导入已过期，请重新上传");
  const body = parseBody(config);
  const path = String(body.path ?? "");
  if (!session.contents.has(path)) {
    return fail(config, 404, "NOT_FOUND", "这个候选不在本次导入里");
  }
  session.selectedPath = path;
  return ok(config, previewOf(decodeURIComponent(match[1]), session));
});

route("post", /^\/imports\/([^/]+)\/commit$/, (config, match) => {
  const importId = decodeURIComponent(match[1]);
  const session = IMPORTS.get(importId);
  if (!session)
    return fail(config, 404, "IMPORT_EXPIRED", "这次导入已过期，请重新上传");
  const body = parseBody(config);
  const draft = body.draft as Draft | undefined;
  if (!draft || !String(draft.title ?? "").trim()) {
    return fail(config, 422, "VALIDATION_ERROR", "标题不能为空");
  }

  const now = new Date().toISOString();
  const mode = body.mode === "update" ? "update" : "create";
  let record =
    mode === "update" && body.targetId
      ? articleById(session.type, String(body.targetId))
      : undefined;

  if (mode === "update") {
    if (!record) {
      return fail(config, 404, "NOT_FOUND", "要更新的那篇内容不存在了");
    }
    const conflictResponse = checkRevision(
      config,
      record.revision,
      body.baseRevision
    );
    if (conflictResponse) return conflictResponse;
    record.title = String(draft.title).trim();
    record.summary = draft.summary ?? null;
    record.category = draft.category ?? null;
    record.tags = draft.tags ?? null;
    record.date = draft.date ?? null;
    record.updated = draft.updated ?? null;
    if (session.type === "essays") {
      record.mood = draft.mood ?? null;
      record.place = draft.place ?? null;
    }
    record.body = String(draft.body ?? "");
    record.revision += 1;
    record.updatedAt = now;
    record.hasUnpublishedChanges =
      record.status === "draft" || hasDiffFromSnapshot(record);
  } else {
    // 稳定 ID 优先：frontmatter 里带合法 id 就用它（与新建文章路由一致），
    // 与既有文章撞 ID 时报 409，让站长改用“更新既有内容”；
    // 没有 id 时按标题生成 slug。
    const requestedId = draft.id?.trim() ?? "";
    const id = requestedId
      ? requestedId
      : slugId(String(draft.title), session.type);
    if (requestedId && articleById(session.type, id)) {
      return fail(
        config,
        409,
        "DUPLICATE_ID",
        "这个 ID 已经存在，换一个标题或手工指定 ID"
      );
    }
    record = {
      res: session.type,
      id: requestedId
        ? id
        : articleById(session.type, id)
          ? `${id}-${Date.now().toString(36)}`
          : id,
      title: String(draft.title).trim(),
      summary: draft.summary ?? null,
      category: draft.category ?? null,
      tags: draft.tags ?? null,
      date: draft.date ?? null,
      updated: draft.updated ?? null,
      mood: session.type === "essays" ? (draft.mood ?? null) : null,
      place: session.type === "essays" ? (draft.place ?? null) : null,
      body: String(draft.body ?? ""),
      visibility: "private",
      status: "draft",
      hasUnpublishedChanges: true,
      revision: 1,
      createdAt: now,
      updatedAt: now,
      publishedAt: null,
      publishedRevision: null,
      assets: [],
      published: null
    };
    articles.push(record);
  }

  // 勾选了“一起导入”的未引用资源，按普通上传补进文件库
  const includePaths = Array.isArray(body.includeUnreferencedPaths)
    ? (body.includeUnreferencedPaths as string[])
    : [];
  let createdAssets = 0;
  let linkedAssets = 0;
  for (const asset of session.assets) {
    if (asset.state === "matched") {
      linkedAssets += 1;
      continue;
    }
    if (asset.state === "unreferenced" && includePaths.includes(asset.path)) {
      const file: FileItem = {
        id: newId("f"),
        name: asset.name,
        ext: asset.name.split(".").pop()?.toLowerCase() ?? "",
        kind: asset.kind,
        size: asset.size,
        updatedAt: now,
        description: `由导入「${record.title}」带入`,
        visibility: "private",
        revision: 1,
        createdAt: now,
        referenceCount: 0,
        publicSrc: null
      };
      files.unshift(file);
      fileBytes.set(
        file.id,
        new Blob([`（开发替身占位，${asset.path}）`], { type: "text/plain" })
      );
      createdAssets += 1;
    }
  }

  const preservedVersion = pushVersion(record, "import");
  IMPORTS.delete(importId);
  refreshReferenceCounts();
  return ok(config, {
    articleId: record.id,
    title: record.title,
    createdAssets,
    linkedAssets,
    preservedVersion
  });
});

route("delete", /^\/imports\/([^/]+)$/, (config, match) => {
  IMPORTS.delete(decodeURIComponent(match[1]));
  return ok(config, { deleted: true });
});

/* ------------------------------------------------------------------ *
 * 适配器
 * ------------------------------------------------------------------ */

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export const mockAdapter: AxiosAdapter = async config => {
  const { path, params } = splitUrl(config);
  const method = (config.method ?? "get").toLowerCase();

  // 让加载态真的能看见：替身故意慢一点
  await delay(120 + Math.random() * 220);

  if (path !== "/login" && path !== "/refresh-token" && !tokenValid(config)) {
    return fail(config, 401, "UNAUTHORIZED", "登录状态已失效，请重新登录");
  }

  for (const entry of routes) {
    if (entry.method !== method) continue;
    const match = entry.pattern.exec(path);
    if (!match) continue;
    try {
      return await entry.handler(config, match, params);
    } catch (error) {
      console.error("[mock] 处理请求时出错", path, error);
      return fail(config, 500, "MOCK_ERROR", "开发替身内部出错，请看控制台");
    }
  }

  console.warn("[mock] 未实现的端点", method.toUpperCase(), path);
  return fail(
    config,
    404,
    "MOCK_NOT_IMPLEMENTED",
    `开发替身没有实现 ${method.toUpperCase()} ${path}`
  );
};

/** 供调试面板／测试使用：重置到种子状态 */
export function resetMockState() {
  IMPORTS.clear();
  CHECKS.clear();
}

export const MOCK_SEED_SUMMARY = {
  articles: articles.length,
  files: files.length,
  shelf: shelf.length,
  guestbook: guestbook.length,
  rules: rules.length,
  seededAt: at(0)
};
