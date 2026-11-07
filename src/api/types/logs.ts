/**
 * 日志中心的类型。形状与后端 `src/services/logs.ts` 一一对应。
 *
 * 两条约定：
 *  1. 日志来源（source）只带 id/label/kind，**不带服务器上的真实路径**——
 *     浏览器端不需要知道 `/var/log/nginx/access.log` 在哪，知道了也只是信息泄露。
 *  2. 所有字段都可能为 null：nginx 的访问行没有 level，程序日志的合并行不一定有 status。
 *     页面渲染要按「可能是未知」处理，不要假设一定有值。
 */

export type LogKind = "access" | "error" | "app" | "backup";

export type LogLevel = "debug" | "info" | "warn" | "error";

/** 可读的日志来源（下拉框用） */
export interface LogSource {
  id: string;
  label: string;
  kind: LogKind;
}

/** 一行日志。程序日志的 incoming / completed 两行会在后端合并成一条。 */
export interface LogEntry {
  id: string;
  source: string;
  sourceLabel: string;
  kind: LogKind;
  time: string | null;
  level: LogLevel | null;
  status: number | null;
  method: string | null;
  path: string | null;
  ip: string | null;
  message: string;
  detail: string;
  /** 命中扫描器特征路径或拦截类状态码 */
  suspect: boolean;
}

/** 查询参数：只回传用户真正设置了的那几项，空值交给 buildQuery 丢掉 */
export interface LogQuery {
  source?: string;
  /** 每个来源取尾部多少行（后端限制 20..2000） */
  tail?: number;
  keyword?: string;
  level?: LogLevel;
  status?: number;
  suspect?: boolean;
}

/**
 * 一页日志。
 * `total` 是**过滤后**的命中条数，`items` 只返回尾部 `tail` 条；
 * `truncated` 表示读文件时只读了最后 512KB，更早的记录没有进入统计。
 */
export interface LogPage {
  items: LogEntry[];
  total: number;
  truncated: boolean;
  generatedAt: string;
  sources: LogSource[];
}

/** 聚合桶：某个 IP / 路径 / 状态码在窗口内出现的次数 */
export interface SecurityBucket {
  key: string;
  count: number;
  lastSeen: string | null;
  sample: string;
}

/** 近 N 小时的攻击面概览 */
export interface SecuritySummary {
  hours: number;
  total: number;
  ips: SecurityBucket[];
  paths: SecurityBucket[];
  statuses: SecurityBucket[];
  recent: LogEntry[];
}

/** Cloudflare 防火墙事件（走 GraphQL 拉取，后端缓存 10 分钟） */
export interface CloudflareEvent {
  action: string;
  datetime: string | null;
  clientIP: string | null;
  path: string | null;
  userAgent: string | null;
  ruleId: string | null;
  count: number;
}

export interface CloudflareView {
  /** 服务器上有没有配 CLOUDFLARE_API_TOKEN；没有时 events 为空、note 说明原因 */
  configured: boolean;
  note: string;
  hours: number;
  events: CloudflareEvent[];
  totals: { blocked: number; challenged: number; other: number };
}

/** 日志级别 → 界面标签与颜色 */
export const LOG_LEVEL_LABEL: Record<LogLevel, string> = {
  debug: "调试",
  info: "信息",
  warn: "警告",
  error: "错误"
};

/** 日志类别 → 界面标签 */
export const LOG_KIND_LABEL: Record<LogKind, string> = {
  access: "访问",
  error: "Web 错误",
  app: "程序",
  backup: "备份"
};

/** 攻击面窗口选项（小时） */
export const SECURITY_WINDOWS = [1, 6, 12, 24, 72, 168] as const;
