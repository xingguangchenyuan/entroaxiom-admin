import { http } from "@/utils/http";
import { enc, ifMatch, pagedQuery } from "./query";
import type {
  DeletedResult,
  GuestbookListItem,
  GuestbookListQuery,
  GuestbookMessage,
  GuestbookReplyPayload,
  GuestbookStatusPayload,
  Paged
} from "./types";

/**
 * 留言与字条管理。
 *
 * 安全要点：
 *  - 正文一律按**纯文本**渲染（见 components/Manager/MarkdownView.vue 之外的纯文本路径），
 *    不解析 HTML／Markdown：留言是访客输入，任何富文本都可能变成注入面；
 *  - 邮箱只在详情里展示，列表与导出不带；
 *  - IP 只有哈希，界面标注“仅哈希，不可反查”，不提供任何定位访客的入口。
 *
 * 路径按 §10.7：回复是 PUT `/guestbook/{id}/reply`（覆盖式写入），
 * 状态是 PATCH `/guestbook/{id}` 本身，没有额外的 `/status` 子资源。
 */

export const listMessages = (query: GuestbookListQuery = {}) => {
  return http.get<Paged<GuestbookListItem>>("/guestbook", {
    params: pagedQuery(query)
  });
};

/** 详情：完整正文、邮箱、回复、命中证据 */
export const getMessage = (id: string) => {
  return http.get<GuestbookMessage>(`/guestbook/${enc(id)}`);
};

/** 写入／覆盖站长回复 */
export const replyMessage = (id: string, payload: GuestbookReplyPayload) => {
  return http.put<GuestbookMessage>(`/guestbook/${enc(id)}/reply`, {
    data: payload
  });
};

/** 删除回复（字条仍公开） */
export const deleteReply = (id: string, baseRevision: number) => {
  return http.delete<GuestbookMessage>(`/guestbook/${enc(id)}/reply`, {
    headers: ifMatch(baseRevision)
  });
};

/**
 * 改公开状态：approved 放行 / hidden 隐藏。
 * 不允许把 blocked 直接改成 approved 以外的东西——
 * “解除拦截”就是 approved，是否放行由站长显式决定。
 */
export const patchMessageStatus = (
  id: string,
  payload: GuestbookStatusPayload
) => {
  return http.patch<GuestbookMessage>(`/guestbook/${enc(id)}`, {
    data: payload
  });
};

/** 物理删除（不可恢复；界面上对这条操作单独做二次确认） */
export const deleteMessage = (id: string, baseRevision: number) => {
  return http.delete<DeletedResult>(`/guestbook/${enc(id)}`, {
    headers: ifMatch(baseRevision)
  });
};
