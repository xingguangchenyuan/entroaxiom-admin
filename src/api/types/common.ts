/**
 * 管理接口共用的类型：信封、分页、字段错误、枚举。
 * 契约以 docs/ADMIN_API.md 为准；这里只表达前端实际使用的形状。
 */

/** 后端统一信封（成功与失败都带 success 字段） */
export interface Envelope<T> {
  success: boolean;
  data: T;
  error: ApiErrorBody | null;
}

/** 失败时的 error 对象；message 会原样展示给站长 */
export interface ApiErrorBody {
  code: string;
  message: string;
  details?: FieldError[] | null;
}

/** FastAPI 风格的字段错误：loc 形如 ["body", "title"] */
export interface FieldError {
  loc: Array<string | number>;
  msg: string;
}

/** 列表查询参数；空值不要发空字符串，交给 buildQuery 过滤 */
export interface PageQuery {
  page?: number;
  pageSize?: number;
  keyword?: string;
}

/** 分页结果；total 是全部匹配项总数，不是当前页长度 */
export interface Paged<T> {
  items: T[];
  total: number;
}

/** 删除成功回执（契约建议返回 200 + { deleted: true }） */
export interface DeletedResult {
  deleted: true;
}

/** 内容可见范围（权限维度，与发布状态分开） */
export type Visibility = "public" | "private";

/** 文章发布状态：由是否存在活动发布快照决定 */
export type PublicationStatus = "draft" | "published";

/** 书影音发布状态：刻意与消费状态 status 分开，避免字段冲突 */
export type ShelfPublicationStatus = PublicationStatus;

/** 乐观锁冲突时后端返回的 error.code */
export const REVISION_CONFLICT = "REVISION_CONFLICT";
/** 文件仍被引用、不能硬删除时后端返回的 error.code */
export const FILE_IN_USE = "FILE_IN_USE";
/** 公开留言命中过滤规则时后端返回的 error.code */
export const CONTENT_REJECTED = "CONTENT_REJECTED";
