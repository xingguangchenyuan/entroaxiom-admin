import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";
import "dayjs/locale/zh-cn";

dayjs.extend(relativeTime);
dayjs.locale("zh-cn");

/**
 * 展示格式化。集中在一处，避免每个页面各写一份“KB 还是 KiB”“时间显示到分钟还是秒”。
 */

/** 字节数 → 人类可读；0 显示 0 B，未知显示 — */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return "—";
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(
    Math.floor(Math.log(Math.abs(bytes)) / Math.log(1024)),
    units.length - 1
  );
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/** ISO → 2026-10-30 22:14 */
export function formatDateTime(
  value: string | number | Date | null | undefined
): string {
  if (!value) return "—";
  const date = dayjs(value);
  return date.isValid() ? date.format("YYYY-MM-DD HH:mm") : String(value);
}

/** ISO → 2026-10-30 */
export function formatDate(
  value: string | number | Date | null | undefined
): string {
  if (!value) return "—";
  const date = dayjs(value);
  return date.isValid() ? date.format("YYYY-MM-DD") : String(value);
}

/** ISO → “3 小时前”；无效值原样返回 */
export function fromNow(
  value: string | number | Date | null | undefined
): string {
  if (!value) return "—";
  const date = dayjs(value);
  return date.isValid() ? date.fromNow() : String(value);
}

/** 今天的日期 YYYY-MM-DD（新建内容时作为默认写作日期） */
export function today(): string {
  return dayjs().format("YYYY-MM-DD");
}
