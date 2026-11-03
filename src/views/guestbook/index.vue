<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { ElMessageBox } from "element-plus";
import {
  deleteMessage,
  deleteReply,
  getMessage,
  listMessages,
  patchMessageStatus,
  replyMessage
} from "@/api/guestbook";
import type {
  GuestbookListItem,
  GuestbookListQuery,
  GuestbookMessage,
  GuestbookStatus,
  Sigil
} from "@/api/types";
import { GUESTBOOK_LIMITS } from "@/api/types";
import { usePagedList } from "@/composables/usePagedList";
import { useUnsavedGuard } from "@/composables/useUnsavedGuard";
import { clearDraft, draftKey, loadDraft, saveDraft } from "@/utils/draftVault";
import { formatDateTime } from "@/utils/format";
import { message } from "@/utils/message";
import PageHeader from "@/components/Manager/PageHeader.vue";
import StatusPill from "@/components/Manager/StatusPill.vue";
import EmptyState from "@/components/Manager/EmptyState.vue";

/**
 * 留言与字条。
 *
 * 这个页面有两条硬规矩：
 *  1. **正文一律按纯文本渲染**。留言是访客输入，不用 v-html、不走 Markdown 管线——
 *     这里省掉的每一点“便利”都是少一个注入面。
 *  2. **不做访客追踪**。只有 IP 哈希，界面上写明“仅哈希、不可反查”，
 *     也不提供按 IP 搜索、按时间定位、导出带邮箱这类能力。
 *
 * 被规则拦截的留言（blocked）会带一份命中证据：规则即使后来被改或删掉，
 * 这条旧留言仍能解释“当初为什么被拦”。
 */
const STATUS_LABEL: Record<GuestbookStatus, string> = {
  approved: "已公开",
  blocked: "被拦截",
  hidden: "已隐藏",
  pending: "待复核"
};

const SIGIL_MARK: Record<Sigil, string> = {
  sun: "☉",
  moon: "☽",
  mercury: "☿",
  venus: "♀",
  mars: "♂",
  jupiter: "♃",
  saturn: "♄"
};

const list = usePagedList<GuestbookListItem, GuestbookListQuery>({
  fetcher: query => listMessages(query),
  initialQuery: { keyword: "", status: undefined, replied: undefined },
  pageSize: 20
});

/* ------------------------------ 详情 ------------------------------ */

const drawerOpen = ref(false);
const loading = ref(false);
const detail = ref<GuestbookMessage | null>(null);
const busy = ref(false);

const replyDraft = reactive({ body: "" });
const originalReply = ref("");
const replyDirty = computed(() => replyDraft.body !== originalReply.value);

const guard = useUnsavedGuard({ subject: () => "这条留言的回复" });
watch(replyDirty, value => (value ? guard.markDirty() : guard.markClean()));

/** 回复草稿的暂存键：一条留言一个，避免两条留言的回复互相覆盖 */
const replyVaultKey = computed(() =>
  detail.value ? draftKey("guestbook-reply", detail.value.id) : ""
);

function persistReplyDraft() {
  if (!replyVaultKey.value || !detail.value) return;
  saveDraft(replyVaultKey.value, {
    contentId: detail.value.id,
    baseRevision: String(detail.value.revision),
    savedAt: Date.now(),
    data: { body: replyDraft.body }
  });
}

/** 打开详情时，若本地有未提交的回复草稿，先问一句再决定 */
async function offerReplyDraft() {
  if (!replyVaultKey.value) return;
  const draft = loadDraft<{ body: string }>(replyVaultKey.value);
  if (!draft || !draft.data?.body || draft.data.body === replyDraft.body) {
    if (draft) clearDraft(replyVaultKey.value);
    return;
  }
  try {
    await ElMessageBox.confirm(
      `上次离开时这条回复还有未保存的修改（${formatDateTime(
        draft.savedAt
      )}）。要恢复吗？`,
      "发现本地回复草稿",
      { confirmButtonText: "恢复草稿", cancelButtonText: "丢弃", type: "info" }
    );
    replyDraft.body = draft.data.body;
  } catch {
    clearDraft(replyVaultKey.value);
  }
}

async function openDetail(row: GuestbookListItem) {
  drawerOpen.value = true;
  loading.value = true;
  try {
    const data = await getMessage(row.id);
    applyDetail(data);
    await offerReplyDraft();
  } catch (error) {
    message((error as Error)?.message ?? "留言读取失败", { type: "error" });
    drawerOpen.value = false;
  } finally {
    loading.value = false;
  }
}

function applyDetail(data: GuestbookMessage) {
  detail.value = data;
  replyDraft.body = data.reply?.body ?? "";
  originalReply.value = replyDraft.body;
  guard.markClean();
}

/**
 * 关抽屉：有未保存回复时先问一次。
 * 返回是否真的关掉了——抽屉的 before-close 要据此决定是否放行。
 */
async function closeDrawer(): Promise<boolean> {
  if (replyDirty.value) {
    const ok = await guard.confirmLeave();
    if (!ok) return false;
    // 守卫承诺“暂存草稿并离开”，那就真的存下来再走
    persistReplyDraft();
  }
  drawerOpen.value = false;
  return true;
}

async function reloadDetail() {
  if (!detail.value) return;
  const data = await getMessage(detail.value.id);
  applyDetail(data);
}

const conflictHint = ref("");
function handleError(error: unknown, fallback: string) {
  const err = error as { code?: string; message?: string };
  if (err?.code === "REVISION_CONFLICT") {
    conflictHint.value = "这条留言刚被别处改过，已重新载入最新内容。";
    reloadDetail().catch(() => undefined);
    message("内容已更新，请基于最新版本重试", { type: "warning" });
    return;
  }
  message(err?.message ?? fallback, { type: "error" });
}

/* ------------------------------ 回复 ------------------------------ */

const replyLength = computed(() => Array.from(replyDraft.body).length);
const replyTooLong = computed(
  () => replyLength.value > GUESTBOOK_LIMITS.replyMax
);

async function saveReply() {
  if (!detail.value) return;
  const body = replyDraft.body.trim();
  if (!body) {
    message("回复内容不能为空；要撤销回复请用「删除回复」", {
      type: "warning"
    });
    return;
  }
  if (replyTooLong.value) {
    message(`回复最多 ${GUESTBOOK_LIMITS.replyMax} 字`, { type: "warning" });
    return;
  }
  busy.value = true;
  try {
    const data = await replyMessage(detail.value.id, {
      body,
      baseRevision: detail.value.revision
    });
    applyDetail(data);
    if (replyVaultKey.value) clearDraft(replyVaultKey.value);
    await list.load();
    message("回复已保存", { type: "success" });
  } catch (error) {
    handleError(error, "回复保存失败");
  } finally {
    busy.value = false;
  }
}

async function removeReply() {
  if (!detail.value?.reply) return;
  try {
    await ElMessageBox.confirm(
      "删除回复后留言仍然公开展示，只是不再有站长回答。",
      "删除回复",
      { type: "warning", confirmButtonText: "删除", cancelButtonText: "取消" }
    );
  } catch {
    return;
  }
  busy.value = true;
  try {
    const data = await deleteReply(detail.value.id, detail.value.revision);
    applyDetail(data);
    await list.load();
    message("回复已删除", { type: "success" });
  } catch (error) {
    handleError(error, "删除回复失败");
  } finally {
    busy.value = false;
  }
}

/* ------------------------------ 状态与删除 ------------------------------ */

async function setStatus(status: "approved" | "hidden") {
  if (!detail.value) return;
  if (detail.value.status === status) return;
  busy.value = true;
  try {
    const data = await patchMessageStatus(detail.value.id, {
      status,
      baseRevision: detail.value.revision
    });
    applyDetail(data);
    await list.load();
    message(
      status === "approved" ? "已放行，前台可见" : "已隐藏，前台不再展示",
      {
        type: "success"
      }
    );
  } catch (error) {
    handleError(error, "状态修改失败");
  } finally {
    busy.value = false;
  }
}

async function removeMessage() {
  if (!detail.value) return;
  try {
    await ElMessageBox.confirm(
      "这是物理删除，留言与回复都会永久消失，无法恢复。",
      "彻底删除留言",
      {
        type: "error",
        confirmButtonText: "永久删除",
        cancelButtonText: "取消",
        confirmButtonClass: "el-button--danger"
      }
    );
  } catch {
    return;
  }
  busy.value = true;
  try {
    await deleteMessage(detail.value.id, detail.value.revision);
    message("已删除", { type: "success" });
    drawerOpen.value = false;
    list.loadAfterRemove();
  } catch (error) {
    handleError(error, "删除失败");
  } finally {
    busy.value = false;
  }
}

/** 列表行上的快速放行／隐藏：列表项没有 revision，先取详情再改，避免乐观更新 */
async function quickStatus(
  row: GuestbookListItem,
  status: "approved" | "hidden"
) {
  busy.value = true;
  try {
    const data = await getMessage(row.id);
    const updated = await patchMessageStatus(row.id, {
      status,
      baseRevision: data.revision
    });
    if (detail.value?.id === updated.id) applyDetail(updated);
    await list.load();
    message(status === "approved" ? "已放行" : "已隐藏", { type: "success" });
  } catch (error) {
    handleError(error, "状态修改失败");
  } finally {
    busy.value = false;
  }
}

const bodyLength = computed(() =>
  detail.value ? Array.from(detail.value.body).length : 0
);

watch(drawerOpen, visible => {
  if (!visible) guard.markClean();
});

list.load();
</script>

<template>
  <div class="ws-page">
    <PageHeader
      eyebrow="Guestbook"
      title="留言与字条"
      subtitle="访客留下的星符与字句。正文按纯文本展示，不解析任何标签；邮箱只有你能看到，IP 只有哈希。"
    />

    <section class="ws-panel">
      <div class="ws-toolbar">
        <el-input
          v-model="list.query.keyword"
          size="small"
          clearable
          placeholder="搜称呼或正文"
          style="max-width: 220px"
          @keyup.enter="list.search()"
          @clear="list.search()"
        />
        <el-select
          v-model="list.query.status"
          size="small"
          clearable
          placeholder="全部状态"
          style="width: 130px"
          @change="list.search()"
        >
          <el-option label="已公开" value="approved" />
          <el-option label="被拦截" value="blocked" />
          <el-option label="已隐藏" value="hidden" />
          <el-option label="待复核" value="pending" />
        </el-select>
        <el-select
          v-model="list.query.replied"
          size="small"
          clearable
          placeholder="回复情况"
          style="width: 130px"
          @change="list.search()"
        >
          <el-option label="已回复" :value="true" />
          <el-option label="未回复" :value="false" />
        </el-select>
        <span class="ws-toolbar__spacer" />
        <span class="ws-hint">共 {{ list.total.value }} 条</span>
      </div>

      <el-table
        v-loading="list.loading.value"
        :data="list.items.value"
        size="small"
        row-key="id"
        class="ws-table"
      >
        <el-table-column label="星符" width="60" align="center">
          <template #default="{ row }">
            <span class="gb-sigil">{{
              row.sigil ? SIGIL_MARK[row.sigil as Sigil] : "—"
            }}</span>
          </template>
        </el-table-column>
        <el-table-column label="留言" min-width="320">
          <template #default="{ row }">
            <p class="ws-cell-title">{{ row.name }}</p>
            <p class="ws-cell-sub gb-excerpt">{{ row.excerpt }}</p>
            <p v-if="row.site" class="ws-hint gb-site">{{ row.site }}</p>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="130">
          <template #default="{ row }">
            <StatusPill :value="row.status" kind="guestbook" />
            <span v-if="row.replied" class="ws-pill ws-pill--mute gb-replied"
              >已回复</span
            >
          </template>
        </el-table-column>
        <el-table-column label="时间" width="150">
          <template #default="{ row }">
            <span class="ws-hint">{{ formatDateTime(row.createdAt) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="210" fixed="right">
          <template #default="{ row }">
            <el-button link size="small" @click="openDetail(row)"
              >查看</el-button
            >
            <el-button
              v-if="row.status !== 'approved'"
              link
              size="small"
              :disabled="busy"
              @click="quickStatus(row, 'approved')"
            >
              放行
            </el-button>
            <el-button
              v-if="row.status === 'approved'"
              link
              size="small"
              :disabled="busy"
              @click="quickStatus(row, 'hidden')"
            >
              隐藏
            </el-button>
          </template>
        </el-table-column>
        <template #empty>
          <EmptyState
            v-if="list.isFiltered.value"
            glyph="⌕"
            title="没有符合筛选的留言"
            description="换个关键词或状态，也可以清空筛选看全部。"
            action-text="清空筛选"
            @action="list.reset"
          />
          <EmptyState
            v-else
            glyph="❞"
            title="还没有留言"
            description="访客在前台写下第一句时，会出现在这里。"
          />
        </template>
      </el-table>

      <div class="ws-pager">
        <el-pagination
          v-model:current-page="list.page.value"
          v-model:page-size="list.pageSize.value"
          :total="list.total.value"
          :page-sizes="[10, 20, 50]"
          layout="total, sizes, prev, pager, next"
          size="small"
          background
          @current-change="list.setPage"
          @size-change="list.search()"
        />
      </div>
    </section>

    <el-drawer
      :model-value="drawerOpen"
      title="留言详情"
      size="min(96vw, 640px)"
      :before-close="
        done => closeDrawer().then(ok => (ok ? done() : undefined))
      "
    >
      <div v-loading="loading" class="gb-detail">
        <template v-if="detail">
          <div class="gb-detail__head">
            <span class="gb-sigil gb-sigil--lg">
              {{ detail.sigil ? SIGIL_MARK[detail.sigil] : "·" }}
            </span>
            <div>
              <p class="gb-detail__name">{{ detail.name }}</p>
              <p class="ws-hint">
                {{ formatDateTime(detail.createdAt) }} · 正文
                {{ bodyLength }} 字
              </p>
            </div>
            <span class="ws-toolbar__spacer" />
            <StatusPill :value="detail.status" kind="guestbook" />
          </div>

          <!-- 纯文本：white-space: pre-wrap 保留换行，绝不用 v-html -->
          <div class="gb-body">{{ detail.body }}</div>

          <dl class="gb-meta">
            <div v-if="detail.email">
              <dt>邮箱</dt>
              <dd>{{ detail.email }}</dd>
            </div>
            <div v-if="detail.site">
              <dt>站点</dt>
              <dd>
                <a
                  v-if="/^https?:\/\//i.test(detail.site)"
                  :href="detail.site"
                  target="_blank"
                  rel="noopener noreferrer nofollow"
                  >{{ detail.site }}</a
                >
                <span v-else>{{ detail.site }}</span>
              </dd>
            </div>
            <div v-if="detail.ipHash">
              <dt>IP 哈希</dt>
              <dd class="ws-mono">{{ detail.ipHash.slice(0, 16) }}…</dd>
              <dd class="ws-hint">仅哈希、不可反查，也不用于定位访客。</dd>
            </div>
          </dl>

          <div v-if="detail.evidence" class="gb-evidence">
            <p class="gb-evidence__title">命中过滤规则</p>
            <p class="ws-hint">
              {{ detail.evidence.reason }} · 字段：{{
                detail.evidence.field === "name" ? "称呼" : "正文"
              }}
              <template v-if="detail.evidence.matchedAt">
                · {{ formatDateTime(detail.evidence.matchedAt) }}
              </template>
            </p>
            <p
              v-if="detail.evidence.ruleText"
              class="gb-evidence__rule ws-mono"
            >
              {{ detail.evidence.ruleText }}
            </p>
            <p v-else class="ws-hint">规则已被删除，仅保留当时的匹配内容。</p>
            <p class="ws-hint">放行后这条会按正常留言公开展示。</p>
          </div>

          <div class="gb-reply">
            <div class="gb-reply__head">
              <p class="gb-reply__title">站长回复</p>
              <span v-if="detail.reply" class="ws-hint">
                更新于
                {{
                  formatDateTime(
                    detail.reply.updatedAt ?? detail.reply.createdAt
                  )
                }}
              </span>
            </div>
            <el-input
              v-model="replyDraft.body"
              type="textarea"
              :rows="5"
              :maxlength="GUESTBOOK_LIMITS.replyMax"
              show-word-limit
              placeholder="回复会公开展示在留言下方，同样按纯文本渲染。"
            />
            <p v-if="replyTooLong" class="ws-hint ws-hint--warn">
              超出 {{ GUESTBOOK_LIMITS.replyMax }} 字上限，请精简后再保存。
            </p>
            <div class="gb-reply__ops">
              <el-button
                size="small"
                :loading="busy"
                :disabled="!replyDirty || replyTooLong"
                @click="saveReply"
              >
                保存回复
              </el-button>
              <el-button
                v-if="detail.reply"
                size="small"
                :disabled="busy"
                @click="removeReply"
              >
                删除回复
              </el-button>
              <span class="ws-toolbar__spacer" />
              <span v-if="replyDirty" class="ws-hint">有未保存的修改</span>
            </div>
          </div>

          <p v-if="conflictHint" class="ws-hint ws-hint--warn">
            {{ conflictHint }}
          </p>

          <div class="gb-actions">
            <el-button
              size="small"
              :disabled="busy || detail.status === 'approved'"
              @click="setStatus('approved')"
            >
              放行并公开
            </el-button>
            <el-button
              size="small"
              :disabled="busy || detail.status === 'hidden'"
              @click="setStatus('hidden')"
            >
              隐藏
            </el-button>
            <span class="ws-toolbar__spacer" />
            <el-button
              size="small"
              type="danger"
              plain
              :disabled="busy"
              @click="removeMessage"
            >
              彻底删除
            </el-button>
          </div>
        </template>
      </div>
    </el-drawer>
  </div>
</template>

<style scoped>
.gb-sigil {
  font-size: 16px;
  color: var(--sol);
}

.gb-sigil--lg {
  font-size: 24px;
  line-height: 1;
}

.gb-excerpt {
  display: -webkit-box;
  overflow: hidden;
  -webkit-line-clamp: 2;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
  -webkit-box-orient: vertical;
}

.gb-site {
  margin: 2px 0 0;
  word-break: break-all;
}

.gb-replied {
  margin-left: 4px;
}

.gb-detail {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.gb-detail__head {
  display: flex;
  gap: 10px;
  align-items: center;
}

.gb-detail__name {
  margin: 0;
  font-family: var(--font-display);
  font-size: 16px;
  color: var(--bone);
}

.gb-body {
  padding: 14px 16px;
  font-size: 13px;
  line-height: 1.85;
  color: var(--bone);
  overflow-wrap: anywhere;
  white-space: pre-wrap;
  background: rgb(239 232 218 / 3%);
  border: 1px solid var(--line);
  border-radius: 10px;
}

.gb-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 12px 24px;
  margin: 0;
}

.gb-meta dt {
  font-size: 11px;
  color: var(--ash);
  text-transform: uppercase;
  letter-spacing: 0.08em;
}

.gb-meta dd {
  margin: 2px 0 0;
  font-size: 12px;
  color: var(--bone);
  word-break: break-all;
}

.gb-evidence {
  padding: 12px 14px;
  background: rgb(214 122 84 / 6%);
  border: 1px solid var(--ember);
  border-radius: 10px;
}

.gb-evidence__title {
  margin: 0 0 4px;
  font-size: 12px;
  color: var(--ember);
  letter-spacing: 0.06em;
}

.gb-evidence__rule {
  padding: 8px 10px;
  margin: 6px 0 0;
  font-size: 12px;
  word-break: break-all;
  white-space: pre-wrap;
  background: rgb(3 4 10 / 50%);
  border-radius: 6px;
}

.gb-reply {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-top: 12px;
  border-top: 1px solid var(--line);
}

.gb-reply__head {
  display: flex;
  gap: 10px;
  align-items: baseline;
}

.gb-reply__title {
  margin: 0;
  font-size: 12px;
  color: var(--ash);
  text-transform: uppercase;
  letter-spacing: 0.08em;
}

.gb-reply__ops,
.gb-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}

.gb-actions {
  padding-top: 12px;
  border-top: 1px solid var(--line);
}
</style>
