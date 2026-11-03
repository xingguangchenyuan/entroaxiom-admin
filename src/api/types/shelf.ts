import type { AssetDecisionOption } from "./content";
import type { ShelfPublicationStatus, Visibility } from "./common";

/** 消费类型 */
export type ShelfKind = "book" | "film" | "music";
/** 消费状态（公开接口的 status 一直是这三个值） */
export type ShelfConsumeStatus = "done" | "doing" | "want";

export const SHELF_KINDS: readonly ShelfKind[] = ["book", "film", "music"];
export const SHELF_CONSUME_STATUS: readonly ShelfConsumeStatus[] = [
  "done",
  "doing",
  "want"
];

/** 书影音可编辑字段（与公开前台保持一致） */
export interface ShelfItemDraft {
  id: string;
  kind: ShelfKind;
  title: string;
  creator: string | null;
  year: number | null;
  /** 0–5，允许 .5 */
  rating: number | null;
  /** 消费状态 —— 不是发布状态 */
  status: ShelfConsumeStatus;
  /** 标记日期 YYYY-MM-DD */
  date: string | null;
  tags: string[] | null;
  quote: string | null;
  /** 短评，纯文本，空行分段 */
  review: string | null;
  /**
   * 封面：`asset:<fileId>` 表示走文件库鉴权资源，http(s) 表示外部地址，null 表示无封面。
   * 不把私密资源拼成公开直链。
   */
  cover: string | null;
  /** 外链（豆瓣等），只允许 http／https */
  link: string | null;
}

/** 管理视图：额外带发布状态、权限与并发信息 */
export interface ShelfItemAdmin extends ShelfItemDraft {
  publicationStatus: ShelfPublicationStatus;
  visibility: Visibility;
  revision: number;
  createdAt: string;
  updatedAt: string;
  /** 封面资源自身的权限，用于发布前检查；cover 不是 asset 引用时为 null */
  coverVisibility: Visibility | null;
  /** 封面被其他内容共享引用 */
  coverShared: boolean;
  /**
   * 公开接口可直接使用的封面地址（`/uploads/public/...` 或外部 http 链接）。
   * 封面文件仍是私密、或条目尚未发布时为 null——前台应当据此不渲染图片，
   * 而不是拿 `asset:` 引用去请求。
   */
  coverUrl?: string | null;
}

export interface ShelfListQuery {
  page?: number;
  pageSize?: number;
  keyword?: string;
  kind?: ShelfKind;
  status?: ShelfConsumeStatus;
  publicationStatus?: ShelfPublicationStatus;
  visibility?: Visibility;
}

export interface ShelfSavePayload extends ShelfItemDraft {
  baseRevision: number;
}

export interface ShelfPublishRequest {
  baseRevision: number;
  checkId: string;
  targetVisibility?: Visibility | null;
  /**
   * 站长对私密封面的处理决定。
   * 封面与文章正文里的资源走同一套规则（keep-private / copy-public / make-public），
   * 漏传会让发布后的条目带着一张访客看不到的封面。
   */
  assetDecisions?: Array<{ fileId: string; decision: AssetDecisionOption }>;
  confirmed: true;
}

export interface ShelfRestoreState {
  deleted: true;
}
