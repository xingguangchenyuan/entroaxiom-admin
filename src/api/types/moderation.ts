/** 匹配方式：首版只有“包含”和“完全相同”，不开放任意正则 */
export type MatchMode = "contains" | "exact";
/** 作用字段：昵称、正文；不对访客邮箱做敏感词展示 */
export type RuleField = "name" | "body";

export const MATCH_MODES: readonly MatchMode[] = ["contains", "exact"];
export const RULE_FIELDS: readonly RuleField[] = ["name", "body"];

/** 分类只是管理标签，不宣称是通用违禁词全集 */
export const DEFAULT_RULE_CATEGORIES = ["辱骂", "自定义屏蔽"] as const;

export interface ModerationRule {
  id: string;
  /** 词／短语；规范化后为空视为非法 */
  text: string;
  matchMode: MatchMode;
  fields: RuleField[];
  category: string;
  enabled: boolean;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface RuleListQuery {
  page?: number;
  pageSize?: number;
  keyword?: string;
  enabled?: boolean;
}

export interface RuleSavePayload {
  text: string;
  matchMode: MatchMode;
  fields: RuleField[];
  category: string;
  enabled: boolean;
}

export interface RuleUpdatePayload extends RuleSavePayload {
  baseRevision: number;
}

/** 命中项：测试接口返回，让站长能核对是哪条规则、作用在哪个字段 */
export interface RuleMatch {
  ruleId: string;
  text: string;
  matchMode: MatchMode;
  field: RuleField;
}

/** 规范化结果：只是后端过程的展示，不代表前端算出的结论 */
export interface NormalizedSample {
  name: string;
  body: string;
}

export interface ModerationTestResult {
  allowed: boolean;
  matches: RuleMatch[];
  normalized: NormalizedSample;
  policyVersion: string | null;
  /** 测试不创建真实留言，这里只是后端额外说明（可选） */
  note?: string | null;
}

export interface ModerationTestPayload {
  name: string;
  body: string;
}
