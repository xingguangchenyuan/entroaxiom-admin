/**
 * 文章“可编辑内容”的归一化快照工具（v2 修复方案 R3）。
 *
 * 表单、服务端详情、本地草稿共用同一套归一化与比较规则：脏状态判断
 * 与“草稿是否冗余”用同一标准，避免“标题正文相同、只改了摘要/标签/
 * 日期/随笔心境地点”的草稿被当成无差异清理掉。
 */

export interface EditableArticleSource {
  title: string | null;
  summary: string | null;
  category: string | null;
  tags: readonly string[];
  date: string | null;
  updated: string | null;
  mood: string | null;
  place: string | null;
  body: string | null;
}

/**
 * 归一化规则：
 * - 可选文本字段按 null/空串/缺失统一成空串再 trim；
 * - 标签数组逐项 trim 并去掉空项，**不排序**（沿用现有产品语义）；
 * - body 是 Markdown 正文，**绝不 trim**（trim 会改变实际正文）；
 * - 随笔才把 mood/place 纳入差异，笔记一律视为空；
 * - revision/updatedAt/权限/发布状态不属于可编辑内容差异。
 */
export function editableArticleSnapshot(
  source: EditableArticleSource,
  isEssay: boolean
): string {
  return JSON.stringify({
    title: (source.title ?? "").trim(),
    summary: (source.summary ?? "").trim(),
    category: (source.category ?? "").trim(),
    tags: [...(source.tags ?? [])].map(tag => tag.trim()).filter(Boolean),
    date: source.date ?? "",
    updated: source.updated ?? "",
    mood: isEssay ? (source.mood ?? "").trim() : "",
    place: isEssay ? (source.place ?? "").trim() : "",
    body: source.body ?? ""
  });
}
