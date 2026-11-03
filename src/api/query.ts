/**
 * 查询参数整理。
 * 约定：管理接口的 JSON 字段与查询参数统一用 camelCase（见 docs/ADMIN_API.md）。
 *
 * 空值不下发很重要：`?keyword=` 与“没有 keyword”在后端往往是两种语义，
 * 前者会变成“精确匹配空字符串”，后者才是“不过滤”。
 */

type Scalar = string | number | boolean;
export type QueryValue = Scalar | Scalar[] | null | undefined;

export function buildQuery(input: Record<string, QueryValue>) {
  const out: Record<string, Scalar | Scalar[]> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null) continue;
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (!trimmed) continue;
      out[key] = trimmed;
      continue;
    }
    if (Array.isArray(value)) {
      const items = value.filter(
        v => v !== undefined && v !== null && String(v).trim() !== ""
      );
      if (items.length) out[key] = items;
      continue;
    }
    // 0 和 false 是有意义的筛选值，不能当空值丢掉
    out[key] = value;
  }
  return out;
}

/**
 * 分页查询：内部一律用 `pageSize`，下发时转成契约里的 `page_size`。
 *
 * 后端契约（见 ENTROAXIOM-后台功能实施方案 §10.3、§10.5）写的是 `page_size`，
 * 而 TS 里坚持 camelCase 更顺手，所以转换只发生在这一处，不要散落到各个 api 文件里。
 */
export function pagedQuery<T extends { pageSize?: number | null }>(query: T) {
  const { pageSize, ...rest } = query as Record<string, QueryValue> & {
    pageSize?: number | null;
  };
  return buildQuery({ ...rest, page_size: pageSize ?? undefined });
}

/** 统一编码路径参数，避免 ID 里的特殊字符破坏路由 */
export const enc = (value: string) => encodeURIComponent(value);

/**
 * DELETE 等不适合带请求体的操作，并发前提走 `If-Match`。
 * 序列化格式在 docs/ADMIN_API.md 里固定为不带引号的十进制 revision，
 * 后端要按同一格式解析，不要自行加弱校验前缀。
 */
export const ifMatch = (revision: number): Record<string, string> => ({
  "If-Match": String(revision)
});
