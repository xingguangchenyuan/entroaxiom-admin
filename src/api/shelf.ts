import { http } from "@/utils/http";
import { enc, ifMatch, pagedQuery } from "./query";
import type {
  DeletedResult,
  Paged,
  PublicationCheckResult,
  ShelfItemAdmin,
  ShelfItemDraft,
  ShelfListQuery,
  ShelfPublishRequest,
  ShelfSavePayload,
  Visibility
} from "./types";

/**
 * 书影音接口。
 *
 * 两个状态必须分清（方案里反复强调的坑）：
 *  - `status`：消费状态 done／doing／want，是给前台渲染用的内容字段；
 *  - `publicationStatus`：发布状态 draft／published，是管理侧的控制字段。
 * 前端的筛选、按钮、提示都按这两个维度分别处理，不要用一个字段兼职。
 *
 * 发布／撤回／改权限都是独立子资源（§10.6），普通 PUT 只改元信息与消费状态；
 * 已发布条目保存时后端仍要重验封面权限，所以发布过的条目保存也要能接 409。
 */

export const listShelf = (query: ShelfListQuery = {}) => {
  return http.get<Paged<ShelfItemAdmin>>("/shelf", {
    params: pagedQuery(query)
  });
};

export const getShelfItem = (id: string) => {
  return http.get<ShelfItemAdmin>(`/shelf/${enc(id)}`);
};

/** 新建条目：只建工作条目，不发布 */
export const createShelfItem = (payload: ShelfItemDraft) => {
  return http.post<ShelfItemAdmin>("/shelf", { data: payload });
};

/** 保存：baseRevision 不一致时 409，界面走冲突处理 */
export const saveShelfItem = (id: string, payload: ShelfSavePayload) => {
  return http.put<ShelfItemAdmin>(`/shelf/${enc(id)}`, { data: payload });
};

/** 只改可见范围 */
export const patchShelfVisibility = (
  id: string,
  payload: { visibility: Visibility; baseRevision: number; checkId: string }
) => {
  return http.patch<ShelfItemAdmin>(`/shelf/${enc(id)}/visibility`, {
    data: payload
  });
};

/**
 * 删除条目。
 * 语义是“从工作列表移除”：后端应保留发布快照或转成下架状态，
 * 前台不出现该条目，管理端明确提示“前台将不再展示”，避免误删数据。
 */
export const deleteShelfItem = (id: string, baseRevision: number) => {
  return http.delete<DeletedResult>(`/shelf/${enc(id)}`, {
    headers: ifMatch(baseRevision)
  });
};

/** 发布前预检（封面是私密资源时需要决策） */
export const checkShelfPublication = (
  id: string,
  body: {
    action: "publish" | "visibility";
    baseRevision: number;
    targetVisibility?: Visibility | null;
  }
) => {
  return http.post<PublicationCheckResult>(
    `/shelf/${enc(id)}/publication-check`,
    { data: body }
  );
};

/** 发布 */
export const publishShelfItem = (id: string, body: ShelfPublishRequest) => {
  return http.post<ShelfItemAdmin>(`/shelf/${enc(id)}/publish`, { data: body });
};

/** 撤回发布：条目留在管理端，前台不再展示 */
export const unpublishShelfItem = (
  id: string,
  body: { baseRevision: number }
) => {
  return http.post<ShelfItemAdmin>(`/shelf/${enc(id)}/unpublish`, {
    data: body
  });
};
