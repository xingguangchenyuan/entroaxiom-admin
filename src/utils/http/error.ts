/**
 * 请求错误的统一整理（纯函数 + 一个错误类，不依赖 Vue / axios，便于单测）。
 *
 * 后端约定的失败响应：{ success: false, data: null, error: { code, message, details? } }（见 docs/ADMIN_API.md）。
 * 这里把四种失败统一成 ApiError：
 *  1. HTTP 状态码异常（401 / 403 / 404 / 409 / 422 / 429 / 5xx ...），优先用后端 error.message；
 *  2. HTTP 200 但 success === false；
 *  3. 网络中断 / 超时（没有响应）；
 *  4. 二进制请求（responseType: "blob"）失败时，错误体是 Blob 里的 JSON —— 必须先解码再判断，
 *     否则会把一段 JSON 当成图片或附件保存下来。
 */

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  /** 兼容模板里其他地方对 `isCancelRequest` 的判断 */
  readonly isCancelRequest = false;

  constructor(
    message: string,
    status: number,
    code: string,
    details?: unknown
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** axios 错误的最小结构（不直接依赖 axios 类型） */
export interface RawRequestError {
  code?: string;
  message?: string;
  response?: { status: number; data?: unknown; headers?: unknown };
}

interface ErrorBody {
  success?: boolean;
  error?: { code?: unknown; message?: unknown; details?: unknown } | null;
}

const STATUS_TEXT: Record<number, string> = {
  400: "请求参数不正确",
  401: "登录已失效，请重新登录",
  403: "没有权限执行此操作",
  404: "请求的内容不存在",
  409: "内容冲突，请刷新后重试",
  413: "上传的文件太大",
  422: "提交的内容不合法",
  429: "操作太频繁，请稍后再试"
};

export function statusText(status: number): string {
  if (STATUS_TEXT[status]) return STATUS_TEXT[status];
  if (status >= 500) return "服务器出错了，请稍后再试";
  return `请求失败（${status}）`;
}

/**
 * 成功响应脱壳。
 *
 * 后端统一信封 `{ success, data, error }`（方案 §10.5），业务层只关心 `data`：
 * 每个 api 函数都写一遍 `.data` 既啰嗦又容易漏，所以在这里统一脱一次。
 *  - `success === true` 且有 `data` 字段 → 返回 `data`；
 *  - 没有信封（后端直出载荷）或只有 `{ success: true }` 的回执 → 原样返回。
 */
export function unwrapEnvelope(data: unknown): unknown {
  const body = asBody(data) as { success?: unknown; data?: unknown };
  if (!body || typeof body !== "object") return data;
  if (
    body.success === true &&
    Object.prototype.hasOwnProperty.call(body, "data")
  ) {
    return body.data;
  }
  return data;
}

const asBody = (data: unknown): ErrorBody | undefined =>
  data && typeof data === "object" ? (data as ErrorBody) : undefined;

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v : undefined;

const isBlob = (v: unknown): v is Blob =>
  typeof Blob !== "undefined" && v instanceof Blob;

/** 错误响应体是不是 JSON（有些后端会用 application/octet-stream 回错误） */
function looksLikeJson(text: string): boolean {
  const head = text.trimStart().slice(0, 1);
  return head === "{" || head === "[";
}

/**
 * 把可能是 Blob 的响应体解析成对象。
 * 二进制接口（导出、下载、图片读取）在失败时同样走信封，必须解码 JSON 错误。
 */
async function parseBody(data: unknown): Promise<unknown> {
  if (!isBlob(data)) return data;
  // 只读一次；很小的错误体，不会把 20 MiB 的附件读进内存
  if (data.size > 512 * 1024) return undefined;
  try {
    const text = await data.text();
    if (!looksLikeJson(text)) return undefined;
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** 同步版：仅用于确定不是 Blob 的普通 JSON 响应 */
export function toApiError(err: RawRequestError): ApiError {
  const res = err.response;
  if (!res) {
    const timeout = err.code === "ECONNABORTED" || err.code === "ETIMEDOUT";
    return new ApiError(
      timeout ? "请求超时，请稍后再试" : "无法连接服务器，请检查网络",
      0,
      timeout ? "TIMEOUT" : "NETWORK_ERROR"
    );
  }
  const body = asBody(res.data);
  return new ApiError(
    str(body?.error?.message) ?? statusText(res.status),
    res.status,
    str(body?.error?.code) ?? `HTTP_${res.status}`,
    body?.error?.details
  );
}

/** 异步版：能解码 Blob 里的 JSON 错误，二进制接口都用这个 */
export async function toApiErrorAsync(err: RawRequestError): Promise<ApiError> {
  const res = err.response;
  if (!res) return toApiError(err);
  const body = asBody(await parseBody(res.data));
  return new ApiError(
    str(body?.error?.message) ?? statusText(res.status),
    res.status,
    str(body?.error?.code) ?? `HTTP_${res.status}`,
    body?.error?.details
  );
}

/** HTTP 200 但 success === false 时，把响应体整理成 ApiError；成功响应返回 undefined */
export function envelopeError(
  data: unknown,
  status = 200
): ApiError | undefined {
  const body = asBody(data);
  if (!body || body.success !== false) return undefined;
  return new ApiError(
    str(body.error?.message) ?? "操作失败",
    status,
    str(body.error?.code) ?? "FAILED",
    body.error?.details
  );
}

/** 登录、刷新令牌这类请求的 401 是“凭证不对”，不应该当成“会话过期”去清登录状态 */
const AUTH_URLS = ["/login", "/refresh-token"];
export const isAuthUrl = (url?: string): boolean =>
  !!url && AUTH_URLS.some(u => url.split("?")[0].endsWith(u));

/** 从 error.details 里取出 `{ loc: ["body","title"], msg }` 形式的字段错误 */
export interface FieldError {
  loc: Array<string | number>;
  msg: string;
}

export function fieldErrors(err: unknown): FieldError[] {
  const details = (err as { details?: unknown })?.details;
  if (!Array.isArray(details)) return [];
  return details.filter(
    (d): d is FieldError =>
      !!d &&
      typeof d === "object" &&
      Array.isArray((d as FieldError).loc) &&
      typeof (d as FieldError).msg === "string"
  );
}

/**
 * 取出某个字段的错误文案。
 * 兼容 `["body", "title"]` 与 `["query", "page"]` 这类前缀。
 */
export function fieldErrorOf(err: unknown, field: string): string | undefined {
  const hit = fieldErrors(err).find(d => d.loc[d.loc.length - 1] === field);
  return hit?.msg;
}

/** 判断是不是并发冲突（409 / REVISION_CONFLICT） */
export function isRevisionConflict(err: unknown): boolean {
  const e = err as { status?: number; code?: string };
  return e?.status === 409 || e?.code === "REVISION_CONFLICT";
}
