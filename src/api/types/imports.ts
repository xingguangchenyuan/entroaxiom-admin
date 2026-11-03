import type { ArticleDraft, ArticleMeta, ContentRes } from "./content";
import type { FileKind } from "./file";

/** ZIP 里的候选 Markdown；纯 .md 时只有一个候选 */
export interface ImportCandidate {
  path: string;
  /** 从 frontmatter 或文件名推测的标题 */
  title: string | null;
  size: number;
}

/** 包内资源与正文引用的映射状态 */
export type ImportAssetState =
  | "matched"
  | "unreferenced"
  | "missing"
  | "ambiguous"
  | "unsupported";

export interface ImportAsset {
  /** 包内相对路径（已规范化） */
  path: string;
  name: string;
  kind: FileKind;
  size: number;
  /** 是否被选中正文引用 */
  referenced: boolean;
  state: ImportAssetState;
  /** 命中多个候选时的候选路径，要求站长选择 */
  candidates?: string[];
  /** 说明文本，例如“包内未找到该文件” */
  note?: string | null;
}

export interface ImportWarning {
  code: string;
  severity: "info" | "warning" | "error";
  message: string;
  path?: string | null;
}

/** 同类型 ID 冲突候选：更新目标必须由站长明确选择 */
export interface ImportConflict {
  id: string;
  title: string;
  updatedAt: string;
  revision: number;
}

export interface ImportPreview {
  importId: string;
  expiresAt: string;
  type: ContentRes;
  candidates: ImportCandidate[];
  /** ZIP 多篇时为空，需先调用 select */
  selectedPath: string | null;
  /** 预检出的正文与元信息；selectedPath 为空时可能为 null */
  draft: ArticleDraft | null;
  /** frontmatter 里前端不认识、不会下发的字段名 */
  unknownFrontmatter: string[];
  assets: ImportAsset[];
  warnings: ImportWarning[];
  conflicts: ImportConflict[];
  /** 后端判断是否可以提交；false 时界面给出原因而不是禁用按钮不解释 */
  committable: boolean;
  /** 正文引用的资源中，包内缺失的数量（摘要用） */
  missingCount: number;
}

export type ImportCommitMode = "create" | "update";

export interface ImportCommitPayload {
  mode: ImportCommitMode;
  /** update 时必填 */
  targetId?: string;
  /** update 时必填 */
  baseRevision?: number;
  /** 站长在预检结果上修正过的元信息与正文 */
  draft: Pick<
    ArticleDraft,
    "id" | "title" | "summary" | "category" | "tags" | "date" | "body"
  > &
    Partial<Pick<ArticleMeta, "updated">> & {
      mood?: string | null;
      place?: string | null;
    };
  /** 未被正文引用的包内文件默认不导入；站长显式勾选才带上 */
  includeUnreferencedPaths: string[];
}

export interface ImportCommitResult {
  /** 导入成功后的目标文章（工作稿） */
  articleId: string;
  title: string;
  createdAssets: number;
  linkedAssets: number;
  /** 更新导入时被保护下来的原工作稿版本 */
  preservedVersion: string | null;
}
