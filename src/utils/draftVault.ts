import { emitter } from "@/utils/mitt";

/**
 * 未保存草稿的崩溃／误刷新恢复。
 *
 * 只放 sessionStorage：
 *  - 同一标签页内刷新、误关后重开能恢复；
 *  - 关闭标签页即失效，不用清理策略也能自动过期；
 *  - **不含**令牌、不含已发布内容，只有编辑中的字段。
 *
 * 主动退出登录时清空（换账号不该看到上一个人的草稿）；
 * 会话过期时保留，重新登录同一账号后可继续编辑。
 */

const PREFIX = "ea:draft:";
/** 草稿最长保留 12 小时，避免“一周前的半成品”突然冒出来覆盖新编辑 */
const TTL = 12 * 60 * 60 * 1000;
/** 单个草稿上限，超了就放弃持久化（宁可丢恢复能力，也不要写坏 sessionStorage） */
const MAX_BYTES = 2 * 1024 * 1024;

export interface DraftSnapshot<T = unknown> {
  /** 已存在内容的 ID；新建内容为 null */
  contentId: string | null;
  /** 草稿基于哪个 revision 编辑，恢复时用来提示“服务器已有更新版本” */
  baseRevision: string | null;
  savedAt: number;
  data: T;
}

interface StoredDraft<T> extends DraftSnapshot<T> {
  v: 1;
}

/** 存储键：内容 ID 或 `new`（新建内容按业务类型区分，避免两篇文章互相覆盖） */
export function draftKey(kind: string, contentId?: string | null): string {
  return `${PREFIX}${kind}:${contentId || "new"}`;
}

export function saveDraft<T>(key: string, snapshot: DraftSnapshot<T>): boolean {
  try {
    const payload: StoredDraft<T> = { ...snapshot, savedAt: Date.now(), v: 1 };
    const text = JSON.stringify(payload);
    if (text.length > MAX_BYTES) return false;
    sessionStorage.setItem(key, text);
    return true;
  } catch {
    // 配额满 / 隐私模式禁写：恢复能力是加分项，失败不该影响正常编辑
    return false;
  }
}

export function loadDraft<T>(key: string): DraftSnapshot<T> | null {
  try {
    const text = sessionStorage.getItem(key);
    if (!text) return null;
    const parsed = JSON.parse(text) as StoredDraft<T>;
    if (!parsed || parsed.v !== 1 || typeof parsed.savedAt !== "number") {
      sessionStorage.removeItem(key);
      return null;
    }
    if (Date.now() - parsed.savedAt > TTL) {
      sessionStorage.removeItem(key);
      return null;
    }
    return {
      contentId: parsed.contentId ?? null,
      baseRevision: parsed.baseRevision ?? null,
      savedAt: parsed.savedAt,
      data: parsed.data
    };
  } catch {
    return null;
  }
}

export function clearDraft(key: string) {
  try {
    sessionStorage.removeItem(key);
  } catch {
    /* 忽略 */
  }
}

export function clearAllDrafts() {
  try {
    Object.keys(sessionStorage)
      .filter(k => k.startsWith(PREFIX))
      .forEach(k => sessionStorage.removeItem(k));
  } catch {
    /* 忽略 */
  }
}

// 主动退出：清空草稿。会话过期：保留，重新登录后可恢复。
emitter.on("session:cleared", clearAllDrafts);
emitter.on("session:external-logout", clearAllDrafts);
