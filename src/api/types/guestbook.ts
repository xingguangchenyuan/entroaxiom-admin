/** 留言星符（与公开前台一致） */
export type Sigil =
  | "sun"
  | "moon"
  | "mercury"
  | "venus"
  | "mars"
  | "jupiter"
  | "saturn";

export const SIGILS: readonly Sigil[] = [
  "sun",
  "moon",
  "mercury",
  "venus",
  "mars",
  "jupiter",
  "saturn"
];

/**
 * 管理侧状态：
 * approved 已公开 / blocked 命中过滤规则被拦截 / hidden 被站长隐藏 /
 * pending 仅用于兼容历史数据，正常流程不会产生，界面按“待复核”展示。
 */
export type GuestbookStatus = "approved" | "blocked" | "hidden" | "pending";

/** 列表筛选用的“全部”不放在类型里，界面用一个空值表示 */
export interface GuestbookListQuery {
  page?: number;
  pageSize?: number;
  keyword?: string;
  status?: GuestbookStatus;
  replied?: boolean;
}

export interface GuestbookListItem {
  id: string;
  name: string;
  /** 正文摘要（后端截断）；详情里有完整正文 */
  excerpt: string;
  status: GuestbookStatus;
  createdAt: string;
  /** 是否已有站长回复 */
  replied: boolean;
  sigil: Sigil | null;
  site: string | null;
}

/** 命中过滤规则的证据快照：规则被改／删后仍能解释旧留言为何被拦截 */
export interface ModerationEvidence {
  ruleId: string | null;
  ruleText: string | null;
  field: "name" | "body";
  reason: string;
  policyVersion: string | null;
  matchedAt: string | null;
}

export interface GuestbookReply {
  body: string;
  createdAt: string;
  updatedAt: string | null;
}

export interface GuestbookMessage {
  id: string;
  name: string;
  /** 邮箱仅管理端可见，公开接口不得返回 */
  email: string | null;
  site: string | null;
  /** 完整纯文本正文，界面必须按文本渲染 */
  body: string;
  sigil: Sigil | null;
  status: GuestbookStatus;
  reply: GuestbookReply | null;
  evidence: ModerationEvidence | null;
  /** 只存哈希，管理端只做展示，不用于反查访客 */
  ipHash: string | null;
  createdAt: string;
  revision: number;
}

export interface GuestbookReplyPayload {
  body: string;
  baseRevision: number;
}

export interface GuestbookStatusPayload {
  status: Extract<GuestbookStatus, "approved" | "hidden">;
  baseRevision: number;
}

/** 公开端提交的输入约束，管理端只用于展示与测试，不用于放宽后端校验 */
export const GUESTBOOK_LIMITS = {
  nameMax: 24,
  bodyMin: 2,
  bodyMax: 500,
  emailMax: 120,
  siteMax: 200,
  replyMax: 500
} as const;
