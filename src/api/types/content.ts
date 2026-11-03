import type { PublicationStatus, Visibility } from "./common";
import type { ArticleAsset, FileKind, UploadCapabilities } from "./file";

/** 文章资源类型：随笔与学习笔记共用一条实现，只有 mood／place 只在随笔出现 */
export type ContentRes = "notes" | "essays";

export const CONTENT_RES: readonly ContentRes[] = ["notes", "essays"];

/** 把路由参数收窄成 ContentRes；不是这两个值一律返回 null */
export function asContentRes(value: unknown): ContentRes | null {
  return value === "notes" || value === "essays" ? value : null;
}

/** 前台公开字段的语义（管理端复用，只是多带了元信息） */
export interface ArticleMeta {
  title: string;
  summary: string | null;
  category: string | null;
  tags: string[] | null;
  /** 写作日期 YYYY-MM-DD */
  date: string | null;
  /** 前台公开字段“更新日期”，与内部 updatedAt 不是一回事 */
  updated: string | null;
}

/** 编辑表单／写入载荷的可编辑部分 */
export interface ArticleDraft extends ArticleMeta {
  id: string;
  body: string;
  /** 仅随笔 */
  mood?: string | null;
  /** 仅随笔 */
  place?: string | null;
}

/** 列表行：不含正文 */
export interface ArticleListItem {
  id: string;
  title: string;
  summary: string | null;
  category: string | null;
  tags: string[] | null;
  date: string | null;
  updated: string | null;
  visibility: Visibility;
  status: PublicationStatus;
  /** 工作稿与发布快照的可发布内容是否不同（不能只看 updatedAt） */
  hasUnpublishedChanges: boolean;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
  publishedRevision: number | null;
  mood?: string | null;
  place?: string | null;
  /** 正文字符数（Unicode 码点）；后端未提供时为 null */
  charCount?: number | null;
}

/** 详情：工作稿完整字段 + 并发与发布元信息 */
export interface ArticleDetail extends ArticleDraft {
  visibility: Visibility;
  status: PublicationStatus;
  hasUnpublishedChanges: boolean;
  /** 乐观锁版本，写入时必须带回 baseRevision */
  revision: number;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
  publishedRevision: number | null;
  assets: ArticleAsset[];
}

/** 列表筛选条件（值都为 null／空时不下发） */
export interface ArticleListQuery {
  page?: number;
  pageSize?: number;
  keyword?: string;
  status?: PublicationStatus;
  visibility?: Visibility;
  category?: string;
  tag?: string;
  hasUnpublishedChanges?: boolean;
}

/** 保存工作稿的写入载荷 */
export interface ArticleSavePayload extends ArticleDraft {
  baseRevision: number;
  /** manual：生成历史版本；auto：只更新工作稿 */
  saveMode: "manual" | "auto";
}

/** 新建载荷：不含 revision */
export type ArticleCreatePayload = ArticleDraft;

/* ------------------------------------------------------------------ *
 * 历史版本
 * ------------------------------------------------------------------ */

/** 版本来源：后台保存 / 发布 / 导入 / 历史恢复 */
export type VersionSource = "manual" | "publish" | "import" | "restore";

export interface ArticleVersionSummary {
  versionId: string;
  version: number;
  source: VersionSource;
  createdAt: string;
  title: string;
  summary: string | null;
  /** 正文字节数，用于并排预览时提示体量差异 */
  size: number | null;
}

/** 只读历史快照：可恢复的元信息 + 正文 */
export interface ArticleVersion extends ArticleMeta {
  versionId: string;
  version: number;
  source: VersionSource;
  createdAt: string;
  body: string;
  mood?: string | null;
  place?: string | null;
}

/** 历史恢复回执：恢复只形成新工作稿，不动线上快照与当前权限 */
export interface RestoreVersionResult {
  article: ArticleDetail;
  /** 被替换的当前工作稿已保留成的版本号 */
  preservedVersion: string;
}

/* ------------------------------------------------------------------ *
 * 发布 / 可见范围预检
 * ------------------------------------------------------------------ */

export type CheckSeverity = "info" | "warning" | "error";

export interface PublicationCheckItem {
  /** 规则码，例如 MISSING_SUMMARY / PRIVATE_ASSET / DANGLING_REF */
  code: string;
  severity: CheckSeverity;
  message: string;
  fileIds?: string[] | null;
}

/** 发布时对单个私密资源可做的选择 */
export type AssetDecisionOption =
  | "keep-private"
  | "copy-public"
  | "make-public";

export interface AssetDecision {
  fileId: string;
  name: string;
  kind: FileKind;
  visibility: Visibility;
  /** 后端允许的处理方式；前端只展示后端给出的选项 */
  options: AssetDecisionOption[];
  /** 该资源同时被其他私密内容引用，转公开有风险 */
  sharedWithPrivate: boolean;
  reason: string | null;
}

export type PublicationAction = "publish" | "visibility";

export interface PublicationCheckRequest {
  action: PublicationAction;
  baseRevision: number;
  targetVisibility?: Visibility | null;
}

export interface PublicationCheckResult {
  /** 预检标识，发布时带回；过期或资源变化后必须重新预检 */
  checkId: string;
  expiresAt: string;
  action: PublicationAction;
  targetVisibility: Visibility | null;
  checks: PublicationCheckItem[];
  assetDecisions: AssetDecision[];
  /** 后端判断是否可以继续；前端只据此启用“确认发布”，不自行放行 */
  canProceed: boolean;
}

/** 发布请求：原子完成校验 + 生成快照（可选同时改可见范围） */
export interface PublishRequest {
  baseRevision: number;
  checkId: string;
  /** 站长对每个需要决策的资源的选择；未列出的按保持私密处理 */
  assetDecisions?: Array<{ fileId: string; decision: AssetDecisionOption }>;
  targetVisibility?: Visibility | null;
  /** 站长已在界面上确认了检查结果 */
  confirmed: true;
}

/* ------------------------------------------------------------------ *
 * 公开快照 / 选项 / 概览 / 能力
 * ------------------------------------------------------------------ */

/** 管理员只读查看当前发布快照 */
export interface PublishedArticleView extends ArticleMeta {
  id: string;
  body: string;
  visibility: Visibility;
  publishedAt: string;
  publishedRevision: number;
  mood?: string | null;
  place?: string | null;
  assets: ArticleAsset[];
}

export interface ContentOptions {
  categories: string[];
  tags: string[];
}

export interface StorageUsage {
  usedBytes: number;
  totalBytes: number;
}

export interface RecentDraft {
  res: ContentRes;
  id: string;
  title: string;
  updatedAt: string;
  status: PublicationStatus;
  hasUnpublishedChanges: boolean;
}

export interface DashboardStats {
  essays: number;
  notes: number;
  shelf: number;
  files: number;
  /** 已拦截（blocked）的留言数 */
  blockedGuestbook: number;
  /** 可选：历史兼容的待复核数量，没有就不显示 */
  pendingGuestbook?: number | null;
}

export interface DashboardResult {
  stats: DashboardStats;
  recentDrafts: RecentDraft[];
  /** 磁盘用量；后端没提供真实数据时必须为 null，界面显示“暂不可用” */
  storage: StorageUsage | null;
}

export interface ImportCapabilities {
  maxArchiveBytes: number;
  maxExpandedBytes: number;
  maxEntries: number;
}

export interface ContentCapabilities {
  maxBodyBytes: number;
  versionRetention: number;
  maxTitleChars: number;
  maxSummaryChars: number;
  /** 字符计数口径说明，例如“按 Unicode 码点” */
  charCounting: string;
}

export interface FeatureFlags {
  importZip: boolean;
  exportZip: boolean;
  versionRestore: boolean;
  moderationTest: boolean;
  /** 后端是否已实现 POST /logout 的服务端撤销 */
  serverLogout: boolean;
  /** 是否有服务端媒体鉴权读取（GET /files/{id}/content） */
  authenticatedMedia: boolean;
}

export interface Capabilities {
  upload: UploadCapabilities;
  import: ImportCapabilities;
  content: ContentCapabilities;
  features: FeatureFlags;
  /** 过滤策略版本；仅用于展示，不代表前端能判定审核结果 */
  policyVersion?: string | null;
}
