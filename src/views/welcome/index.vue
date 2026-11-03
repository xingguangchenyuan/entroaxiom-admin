<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { getDashboard } from "@/api/content";
import { useCapabilitiesStore } from "@/store/modules/capabilities";
import type { DashboardResult, RecentDraft } from "@/api/types";
import PageHeader from "@/components/Manager/PageHeader.vue";
import StatusPill from "@/components/Manager/StatusPill.vue";
import EmptyState from "@/components/Manager/EmptyState.vue";

/**
 * 概览。
 *
 * 只回答三个问题：
 *  1. 现在有多少内容、其中多少还没发布？
 *  2. 有没有需要我处理的东西（被拦截的留言、有改动没发布的稿子）？
 *  3. 从哪里开始今天的活？
 *
 * 不做“看起来很美但没用”的图表：管理后台的首页是工作台，不是仪表盘样板间。
 */
const router = useRouter();
const capabilities = useCapabilitiesStore();

const loading = ref(true);
const errorText = ref("");
const data = ref<DashboardResult | null>(null);

const stats = computed(() => data.value?.stats);
const recent = computed(() => data.value?.recentDrafts ?? []);

const RES_LABEL: Record<string, string> = { essays: "随笔", notes: "笔记" };

const storageText = computed(() => {
  const storage = data.value?.storage;
  if (!storage || !storage.totalBytes) return null;
  const used = formatBytes(storage.usedBytes);
  const total = formatBytes(storage.totalBytes);
  const percent = Math.min(
    100,
    Math.round((storage.usedBytes / storage.totalBytes) * 100)
  );
  return { used, total, percent };
});

function formatBytes(bytes: number | null | undefined): string {
  if (!bytes && bytes !== 0) return "—";
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1
  );
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

async function load() {
  loading.value = true;
  errorText.value = "";
  try {
    data.value = await getDashboard();
  } catch (error) {
    errorText.value = (error as Error)?.message ?? "概览数据读取失败";
  } finally {
    loading.value = false;
  }
}

function openDraft(draft: RecentDraft) {
  router.push(`/content/${draft.res}/${draft.id}`);
}

onMounted(() => {
  capabilities.ensure();
  load();
});
</script>

<template>
  <div class="ws-page">
    <PageHeader
      eyebrow="Observatory Console"
      title="工作台"
      description="这里是这站的编辑台。左边是内容与资源，今天的待办在下面。"
    >
      <template #actions>
        <el-button size="small" @click="load">刷新</el-button>
        <el-button size="small" @click="router.push('/content/essays/new')">
          写随笔
        </el-button>
        <el-button
          size="small"
          type="primary"
          @click="router.push('/content/notes/new')"
        >
          写笔记
        </el-button>
      </template>
    </PageHeader>

    <p
      v-if="!capabilities.authoritative && capabilities.loaded"
      class="ws-hint ws-hint--warn"
    >
      服务端限制值暂不可用（{{ capabilities.error || "未返回能力信息" }}），
      界面按保守默认值处理：上传上限
      {{ formatBytes(capabilities.maxFileBytes) }}。
    </p>

    <el-skeleton v-if="loading" :rows="6" animated />

    <div v-else-if="errorText" class="ws-panel">
      <div class="ws-panel__body">
        <p class="ws-hint ws-hint--danger">{{ errorText }}</p>
        <el-button size="small" @click="load">重试</el-button>
      </div>
    </div>

    <template v-else>
      <section class="ws-stats">
        <article class="ws-stat">
          <p class="ws-stat__label">随笔</p>
          <p class="ws-stat__value">{{ stats?.essays ?? 0 }}</p>
          <p class="ws-stat__hint">公开文章，含未发布草稿</p>
        </article>
        <article class="ws-stat">
          <p class="ws-stat__label">笔记</p>
          <p class="ws-stat__value">{{ stats?.notes ?? 0 }}</p>
          <p class="ws-stat__hint">学习笔记，与随笔同一套编辑流程</p>
        </article>
        <article class="ws-stat">
          <p class="ws-stat__label">书影音</p>
          <p class="ws-stat__value">{{ stats?.shelf ?? 0 }}</p>
          <p class="ws-stat__hint">已记录条目</p>
        </article>
        <article class="ws-stat">
          <p class="ws-stat__label">文件</p>
          <p class="ws-stat__value">{{ stats?.files ?? 0 }}</p>
          <p class="ws-stat__hint">
            磁盘用量
            <template v-if="storageText"
              >：{{ storageText.used }} / {{ storageText.total }}</template
            >
            <template v-else>：暂不可用</template>
          </p>
        </article>
        <article class="ws-stat">
          <p class="ws-stat__label">拦截的留言</p>
          <p class="ws-stat__value">{{ stats?.blockedGuestbook ?? 0 }}</p>
          <p class="ws-stat__hint">
            <el-button
              v-if="(stats?.blockedGuestbook ?? 0) > 0"
              link
              size="small"
              @click="router.push('/guestbook')"
            >
              去处理
            </el-button>
            <span v-else>没有命中过滤规则的留言</span>
          </p>
        </article>
      </section>

      <section class="ws-panel">
        <div class="ws-panel__head">
          <span class="ws-panel__title">最近在写的</span>
          <el-button link size="small" @click="router.push('/content/essays')">
            全部内容
          </el-button>
        </div>
        <div v-if="recent.length" class="ws-panel__body recent">
          <button
            v-for="draft in recent"
            :key="`${draft.res}-${draft.id}`"
            type="button"
            class="recent__row"
            @click="openDraft(draft)"
          >
            <span class="recent__kind ws-mono">{{
              RES_LABEL[draft.res] ?? draft.res
            }}</span>
            <span class="recent__title">{{ draft.title || "（未命名）" }}</span>
            <span class="recent__flags">
              <StatusPill :value="draft.status" />
              <StatusPill
                v-if="draft.hasUnpublishedChanges"
                value="dirty"
                label="有未发布改动"
                kind="plain"
              />
            </span>
            <span class="recent__time ws-mono">{{ draft.updatedAt }}</span>
          </button>
        </div>
        <EmptyState
          v-else
          glyph="✎"
          title="还没有内容"
          description="从一篇随笔或一条笔记开始。写下来的东西会先存在工作稿里，发布后才出现在前台。"
          action-text="写第一篇"
          @action="router.push('/content/essays/new')"
        />
      </section>

      <section class="ws-panel">
        <div class="ws-panel__head">
          <span class="ws-panel__title">常用的地方</span>
        </div>
        <div class="ws-panel__body shortcuts">
          <el-button size="small" @click="router.push('/library')"
            >文件库</el-button
          >
          <el-button size="small" @click="router.push('/shelf')"
            >书影音</el-button
          >
          <el-button size="small" @click="router.push('/guestbook')"
            >留言</el-button
          >
          <el-button size="small" @click="router.push('/moderation')"
            >过滤规则</el-button
          >
          <el-button size="small" @click="router.push('/imports')"
            >导入 Markdown</el-button
          >
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.recent {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px;
}

.recent__row {
  display: grid;
  grid-template-columns: 56px minmax(0, 1fr) auto auto;
  gap: 12px;
  align-items: center;
  padding: 10px 12px;
  text-align: left;
  cursor: pointer;
  background: transparent;
  border: 0;
  border-radius: 10px;
  transition: background 160ms ease;
}

.recent__row:hover {
  background: rgb(233 189 94 / 6%);
}

.recent__kind {
  font-size: 11px;
  color: var(--sol);
  letter-spacing: 0.12em;
}

.recent__title {
  overflow: hidden;
  text-overflow: ellipsis;
  font-family: var(--font-display);
  font-size: 15px;
  color: var(--bone);
  white-space: nowrap;
}

.recent__flags {
  display: flex;
  gap: 6px;
  align-items: center;
}

.recent__time {
  font-size: 11.5px;
  color: var(--ash);
}

.shortcuts {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

@media (width <= 760px) {
  .recent__row {
    grid-template-columns: 1fr;
    gap: 4px;
  }
}
</style>
