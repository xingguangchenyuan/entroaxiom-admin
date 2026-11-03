import { http } from "@/utils/http";
import { enc, ifMatch, pagedQuery } from "./query";
import type {
  DeletedResult,
  ModerationRule,
  ModerationTestPayload,
  ModerationTestResult,
  Paged,
  RuleListQuery,
  RuleSavePayload,
  RuleUpdatePayload
} from "./types";

/**
 * 留言过滤规则（敏感词）。
 *
 * 这是“管理工具”，不是平台级审核系统：词库来自站长自己维护，
 * 界面文案不能声称能过滤全部违禁内容，也不提供“保证拦截”的承诺。
 * 规则只做 contains／exact 两种匹配，不支持任意正则（避免灾难性回溯与误伤）。
 */

export const listRules = (query: RuleListQuery = {}) => {
  return http.get<Paged<ModerationRule>>("/moderation/rules", {
    params: pagedQuery(query)
  });
};

export const createRule = (payload: RuleSavePayload) => {
  return http.post<ModerationRule>("/moderation/rules", { data: payload });
};

/** 整体更新（含启用状态），需要 baseRevision */
export const updateRule = (id: string, payload: RuleUpdatePayload) => {
  return http.put<ModerationRule>(`/moderation/rules/${enc(id)}`, {
    data: payload
  });
};

/**
 * 只切换启用状态。
 * 契约里启停也走 PUT（§10.7 没有单独的 PATCH 子资源），
 * 所以这里仍是 PUT，只带 enabled + baseRevision，其余字段由后端保留。
 */
export const toggleRule = (
  id: string,
  payload: { enabled: boolean; baseRevision: number }
) => {
  return http.put<ModerationRule>(`/moderation/rules/${enc(id)}`, {
    data: payload
  });
};

export const deleteRule = (id: string, baseRevision: number) => {
  return http.delete<DeletedResult>(`/moderation/rules/${enc(id)}`, {
    headers: ifMatch(baseRevision)
  });
};

/**
 * 用样例测试规则。
 * 只是“模拟一次公开提交会怎样”，不创建真实留言，也不影响线上数据。
 * 结果里的 `allowed` 与 `matches` 完全来自后端，前端不自己算匹配。
 */
export const testRules = (payload: ModerationTestPayload) => {
  return http.post<ModerationTestResult>("/moderation/test", { data: payload });
};
