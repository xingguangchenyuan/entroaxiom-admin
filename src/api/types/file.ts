import type { Visibility } from "./common";

/** 文件大类；后端返回未知值时前端按 other 处理 */
export type FileKind = "image" | "pdf" | "archive" | "doc" | "other";

/** 文件列表／详情的管理视图（前台公开字段的子集 + 管理元信息） */
export interface FileItem {
  id: string;
  /** 展示名称（可改），不是服务器存储路径 */
  name: string;
  /** 扩展名，不含点 */
  ext: string;
  kind: FileKind;
  /** 字节 */
  size: number;
  /** 最近更新时间（ISO 8601）。前台公开字段沿用这个名字 */
  updatedAt: string | null;
  description: string | null;
  visibility: Visibility;
  revision: number;
  createdAt: string;
  referenceCount: number;
  /**
   * 公开可访问地址；私密文件必须为 null。
   * 千万不要把需要 Bearer 的地址塞进这个字段：<img> 不会带 Authorization。
   */
  publicSrc: string | null;
  /**
   * 新版契约的等价字段。前后台曾经各叫一套（publicSrc / publicUrl、visibility / visible），
   * 接上真后端时字段名对不上就会静默丢图，所以序列化时两套一起给。
   */
  mime?: string | null;
  visible?: boolean;
  publicUrl?: string | null;
  status?: "ready" | "processing" | "failed";
}

/** 文件列表筛选 */
export interface FileListQuery {
  page?: number;
  pageSize?: number;
  keyword?: string;
  kind?: FileKind;
  visibility?: Visibility;
  /** 只看未被引用的文件（用于清理） */
  unused?: boolean;
  /** 按大小排序方向，清理磁盘时常用 */
  sort?: "recent" | "size";
}

/** 文件元信息更新（名称、说明、可见范围）；改可见范围要用 baseRevision 防并发覆盖 */
export interface FileUpdatePayload {
  name?: string;
  description?: string | null;
  visibility?: Visibility;
  baseRevision: number;
}

/** 引用位置：当前工作稿 / 发布快照 / 历史版本 / 书影音封面 */
export type FileRefUsage = "working" | "published" | "version" | "cover";

/** 引用方资源类型；articles 用 notes/essays，书影音用 shelf */
export type FileRefOwner = "notes" | "essays" | "shelf";

export interface FileReference {
  usage: FileRefUsage;
  owner: FileRefOwner;
  targetId: string;
  title: string;
  /** 仅历史版本引用时有值 */
  version: number | null;
  /** 该引用当前是否出现在公开站点上 */
  isPublic: boolean;
}

/** 文章详情里带出的资源引用（发布检查与阅读页资源面板用） */
export interface ArticleAsset {
  fileId: string;
  name: string;
  kind: FileKind;
  size: number;
  /** 资源自身权限；为 null 表示后端尚未返回，界面按“未知”处理 */
  visibility: Visibility | null;
  /** 出现位置：working / published / version */
  usages: FileRefUsage[];
  /**
   * 已公开资源的直链；私密或未公开时为 null。
   * 私密资源只能走鉴权读取，别把这个字段当成“总能用的图片地址”。
   */
  publicSrc?: string | null;
}

/** 上传所需的能力限制（由 GET /capabilities 返回，界面读取而不是写死） */
export interface UploadCapabilities {
  maxFileBytes: number;
  /** 允许的大类 */
  allowedKinds: FileKind[];
  /** 允许的扩展名（小写，不含点） */
  allowedExtensions: string[];
  /** 同时上传数量上限 */
  maxConcurrent: number;
}
