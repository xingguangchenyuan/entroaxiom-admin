import { http } from "@/utils/http";
import { buildQuery, enc, ifMatch, pagedQuery } from "./query";
import type {
  ArticleCreatePayload,
  ArticleDetail,
  ArticleListItem,
  ArticleListQuery,
  ArticleSavePayload,
  ArticleVersion,
  ArticleVersionSummary,
  ContentOptions,
  ContentRes,
  DashboardResult,
  Paged,
  PublicationCheckRequest,
  PublicationCheckResult,
  PublishRequest,
  PublishedArticleView,
  RestoreVersionResult,
  Visibility
} from "./types";

/**
 * 文章（学习笔记 / 随笔）接口。
 *
 * 这两类内容的字段、版本、发布、资源检查完全同构，所以只实现一套，
 * 用路径里的 `res` 区分；界面上的差异只在随笔多出 mood／place 两个字段。
 *
 * 路径与语义严格按 ENTROAXIOM-后台功能实施方案 §10.3：
 *  - 预检是 `/publication-check`，不是泛泛的 `/check`；
 *  - 可见范围是独立子资源 `/visibility`，普通保存不允许顺手改权限；
 *  - 撤回发布是独立动作 `/unpublish`，不能用“保存 publicationStatus”冒充；
 *  - 删除用 `If-Match` 带 revision，因为 DELETE 不适合请求体。
 *
 * 路径参数统一走 `enc()`，避免 ID 里的字符影响路由。
 */

const base = (res: ContentRes) => `/articles/${res}`;

/** 列表（不含正文） */
export const listArticles = (res: ContentRes, query: ArticleListQuery = {}) => {
  return http.get<Paged<ArticleListItem>>(base(res), {
    params: pagedQuery(query)
  });
};

/** 详情：工作稿 + 并发版本号 + 资源清单 */
export const getArticle = (res: ContentRes, id: string) => {
  return http.get<ArticleDetail>(`${base(res)}/${enc(id)}`);
};

/** 新建：只创建工作稿，不发布；权限固定为 private，改权限走独立接口 */
export const createArticle = (
  res: ContentRes,
  payload: ArticleCreatePayload
) => {
  return http.post<ArticleDetail>(base(res), { data: payload });
};

/**
 * 保存工作稿。
 * `baseRevision` 是乐观锁：不一致时后端返回 409 + REVISION_CONFLICT，
 * 界面必须让站长选择“用我的覆盖／放弃我的／对比后合并”，不能自动重试覆盖别人。
 * `saveMode=auto` 只更新工作稿，不生成历史版本；`manual` 才留档。
 */
export const saveArticle = (
  res: ContentRes,
  id: string,
  payload: ArticleSavePayload
) => {
  return http.put<ArticleDetail>(`${base(res)}/${enc(id)}`, { data: payload });
};

/** 只改可见范围（独立子资源；服务端原子完成资源检查） */
export const patchArticleVisibility = (
  res: ContentRes,
  id: string,
  payload: { visibility: Visibility; baseRevision: number; checkId: string }
) => {
  return http.patch<ArticleDetail>(`${base(res)}/${enc(id)}/visibility`, {
    data: payload
  });
};

/**
 * 发布前预检 / 可见范围变更预检。
 * 返回 checkId 与需要站长决策的私密资源；`canProceed` 只信后端，
 * 预检不是“前端自检通过就能发布”的替代品。
 */
export const checkArticlePublication = (
  res: ContentRes,
  id: string,
  body: PublicationCheckRequest
) => {
  return http.post<PublicationCheckResult>(
    `${base(res)}/${enc(id)}/publication-check`,
    { data: body }
  );
};

/**
 * 发布：后端原子完成校验 + 生成快照。
 * 一定要带 checkId：它是“站长已经看过这份预检结果”的凭据，过期或资源变化后必须重新预检。
 */
export const publishArticle = (
  res: ContentRes,
  id: string,
  body: PublishRequest
) => {
  return http.post<ArticleDetail>(`${base(res)}/${enc(id)}/publish`, {
    data: body
  });
};

/** 撤回发布：保留工作稿，只撤掉线上公开入口 */
export const unpublishArticle = (
  res: ContentRes,
  id: string,
  body: { baseRevision: number }
) => {
  return http.post<ArticleDetail>(`${base(res)}/${enc(id)}/unpublish`, {
    data: body
  });
};

/** 只读查看当前发布快照（不是工作稿） */
export const getPublishedView = (res: ContentRes, id: string) => {
  return http.get<PublishedArticleView>(`${base(res)}/${enc(id)}/published`);
};

/**
 * 删除文章（含公开入口）。
 * 不会连带硬删除仍被引用的文件——那是文件库自己的引用保护。
 */
export const deleteArticle = (
  res: ContentRes,
  id: string,
  revision: number
) => {
  return http.delete<{ deleted: true }>(`${base(res)}/${enc(id)}`, {
    headers: ifMatch(revision)
  });
};

/** 历史版本列表（不含正文，只够做列表与对比摘要） */
export const listVersions = (
  res: ContentRes,
  id: string,
  query: { page?: number; pageSize?: number } = {}
) => {
  return http.get<ArticleVersionSummary[]>(`${base(res)}/${enc(id)}/versions`, {
    params: pagedQuery(query)
  });
};

/** 单个历史版本的完整快照 */
export const getVersion = (res: ContentRes, id: string, versionId: string) => {
  return http.get<ArticleVersion>(
    `${base(res)}/${enc(id)}/versions/${enc(versionId)}`
  );
};

/**
 * 恢复历史版本。
 * 语义是“用这个版本的内容生成一份新的工作稿”，不会直接改线上快照，
 * 因此恢复后仍要走一次发布流程；当前工作稿会被保留成一个新版本。
 */
export const restoreVersion = (
  res: ContentRes,
  id: string,
  versionId: string,
  payload: { baseRevision: number }
) => {
  return http.post<RestoreVersionResult>(
    `${base(res)}/${enc(id)}/versions/${enc(versionId)}/restore`,
    { data: payload }
  );
};

/**
 * 导出单篇（工作稿或发布快照），返回二进制。
 * 导出走 blob，不能按 JSON 信封解析——否则会把 zip 当成错误信息。
 */
export const exportArticle = (
  res: ContentRes,
  id: string,
  options: { source: "working" | "published"; format: "md" | "zip" }
) => {
  return http.blob(`${base(res)}/${enc(id)}/export`, {
    params: buildQuery(options)
  });
};

/** 分类与标签候选（来自现有内容，不是写死的字典） */
export const getContentOptions = (res?: ContentRes) => {
  return http.get<ContentOptions>("/content-options", {
    params: buildQuery({ type: res }),
    silent: true
  });
};

/** 概览页数据 */
export const getDashboard = () => {
  return http.get<DashboardResult>("/dashboard");
};
