<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { diffLines } from "diff";
import { getVersion, listVersions, restoreVersion } from "@/api/content";
import type {
  ArticleDetail,
  ArticleVersion,
  ArticleVersionSummary,
  ContentRes,
  VersionSource
} from "@/api/types";
import { message } from "@/utils/message";
import { formatBytes, formatDateTime } from "@/utils/format";
import MarkdownView from "./MarkdownView.vue";
import EmptyState from "./EmptyState.vue";

/**
 * 历史版本抽屉。
 *
 * 三件事必须说清楚，否则会误操作：
 *  1. 恢复只产生**新工作稿**，不动线上快照和当前权限——恢复后仍要重新发布才生效；
 *  2. 恢复前当前工作稿会先被保留成一个版本，刚自动保存的东西不会丢；
 *  3. 对比只做行级差异提示，不假装是逐字 diff（方案只要求能看出改了哪一段）。
 *
 * 恢复的保护编排（确认 + 把当前稿保存成服务端历史）由父页面统一负责：
 * 本组件在发恢复请求前 await beforeRestore()，只有它放行（ok=true 且带回
 * **最新 revision**）才真正调恢复接口；ok=false（取消/关闭/Esc/保存失败）
 * 一律不发请求。父页面这样编排是因为 save() 在保存中会排队提前返回，
 * 普通 emit 后假定异步保存完成是不可靠的。
 */
const props = defineProps<{
  modelValue: boolean;
  res: ContentRes;
  articleId: string;
  /** 当前工作稿正文，用于对比 */
  currentBody: string;
  currentTitle: string;
  currentSummary: string | null;
  /** 恢复时要带的并发版本号 */
  currentRevision: number;
  /**
   * 恢复前编排：确认并保证当前内容已保存为服务端工作稿。
   * ok=false 时本组件必须中止恢复（不发恢复请求）。
   */
  beforeRestore: () => Promise<{
    ok: boolean;
    baseRevision?: number;
    reason?: string;
  }>;
}>();

const emit = defineEmits<{
  "update:modelValue": [boolean];
  restored: [ArticleDetail];
}>();

const open = computed({
  get: () => props.modelValue,
  set: (value: boolean) => emit("update:modelValue", value)
});

const SOURCE_LABEL: Record<VersionSource, string> = {
  manual: "后台保存",
  publish: "发布",
  import: "导入覆盖",
  restore: "历史恢复"
};

const versions = ref<ArticleVersionSummary[]>([]);
const loading = ref(false);
const errorText = ref("");
const selected = ref<ArticleVersion | null>(null);
const selectedLoading = ref(false);
const compareMode = ref(false);
const restoring = ref(false);

async function load() {
  loading.value = true;
  errorText.value = "";
  try {
    versions.value = await listVersions(props.res, props.articleId, {
      page: 1,
      pageSize: 50
    });
  } catch (error) {
    errorText.value = (error as Error)?.message ?? "版本列表读取失败";
    versions.value = [];
  } finally {
    loading.value = false;
  }
}

watch(
  () => props.modelValue,
  visible => {
    if (!visible) return;
    selected.value = null;
    compareMode.value = false;
    load();
  }
);

async function select(version: ArticleVersionSummary) {
  selectedLoading.value = true;
  try {
    selected.value = await getVersion(
      props.res,
      props.articleId,
      version.versionId
    );
  } catch (error) {
    message((error as Error)?.message ?? "这个版本读取失败", { type: "error" });
  } finally {
    selectedLoading.value = false;
  }
}

/** 行级差异：只标出增删行，够判断“改动大不大、改了哪一段” */
const changes = computed(() => {
  if (!selected.value) return [];
  return diffLines(props.currentBody ?? "", selected.value.body ?? "");
});

const stats = computed(() => {
  let added = 0;
  let removed = 0;
  for (const part of changes.value) {
    const lines = part.value.split("\n").length - 1;
    if (part.added) added += lines;
    else if (part.removed) removed += lines;
  }
  return { added, removed };
});

/** 元信息差异：标题／摘要的改动在正文 diff 里看不到，单独列出来 */
const metaDiff = computed(() => {
  if (!selected.value) return [];
  const rows: Array<{ label: string; before: string; after: string }> = [];
  const push = (label: string, before: string | null, after: string | null) => {
    const b = (before ?? "").trim();
    const a = (after ?? "").trim();
    if (b !== a)
      rows.push({ label, before: b || "（空）", after: a || "（空）" });
  };
  // 方向固定为“当前稿 → 这个版本”，避免恢复前看反
  push("标题", props.currentTitle, selected.value.title);
  push("摘要", props.currentSummary, selected.value.summary);
  return rows;
});

async function restore() {
  if (!selected.value || restoring.value) return;
  const version = selected.value;
  restoring.value = true;
  try {
    // 恢复前编排在父页面（确认 + 保存当前稿 + 最新 revision）；不通过就中止
    const prep = await props.beforeRestore();
    if (!prep.ok) {
      if (prep.reason) message(prep.reason, { type: "warning" });
      return;
    }
    const result = await restoreVersion(
      props.res,
      props.articleId,
      version.versionId,
      { baseRevision: prep.baseRevision ?? props.currentRevision }
    );
    message("已恢复为新工作稿，记得再发布一次", { type: "success" });
    emit("restored", result.article);
    open.value = false;
  } catch (error) {
    const err = error as { code?: string };
    message(
      err?.code === "REVISION_CONFLICT"
        ? "这篇刚被别处改过，先刷新再恢复"
        : ((error as Error)?.message ?? "恢复失败"),
      { type: "error" }
    );
  } finally {
    restoring.value = false;
  }
}
</script>

<template>
  <el-drawer v-model="open" title="历史版本" size="min(96vw, 900px)">
    <div class="vh">
      <div class="vh__list">
        <div class="vh__list-head">
          <span class="ws-panel__title">版本列表</span>
          <el-button link size="small" :loading="loading" @click="load"
            >刷新</el-button
          >
        </div>
        <p class="ws-hint">
          手动保存、发布、导入覆盖、历史恢复各留一份；自动保存不单独生成版本。
        </p>
        <div v-loading="loading" class="vh__items">
          <button
            v-for="version in versions"
            :key="version.versionId"
            type="button"
            class="vh__item"
            :class="{ 'is-active': selected?.versionId === version.versionId }"
            @click="select(version)"
          >
            <span class="vh__item-head">
              <span class="ws-mono vh__ver">v{{ version.version }}</span>
              <span class="ws-pill ws-pill--mute">{{
                SOURCE_LABEL[version.source]
              }}</span>
            </span>
            <span class="vh__item-title">{{
              version.title || "（无标题）"
            }}</span>
            <span class="ws-mono ws-cell-sub">
              {{ formatDateTime(version.createdAt) }}
              <template v-if="version.size">
                · {{ formatBytes(version.size) }}</template
              >
            </span>
          </button>
          <EmptyState
            v-if="!loading && !versions.length"
            glyph="◷"
            :title="errorText ? '版本列表没读到' : '还没有历史版本'"
            :description="
              errorText || '第一次手动保存或发布之后，这里就会有记录。'
            "
            :action-text="errorText ? '重试' : ''"
            @action="load"
          />
        </div>
      </div>

      <div class="vh__detail">
        <template v-if="selected">
          <div class="vh__detail-head">
            <div>
              <p class="ws-panel__title">
                v{{ selected.version }} · {{ SOURCE_LABEL[selected.source] }}
              </p>
              <p class="ws-mono ws-cell-sub">
                {{ formatDateTime(selected.createdAt) }}
              </p>
            </div>
            <div class="vh__actions">
              <el-button size="small" @click="compareMode = !compareMode">
                {{ compareMode ? "看完整内容" : "与当前稿对比" }}
              </el-button>
              <el-button
                size="small"
                type="primary"
                :loading="restoring"
                @click="restore"
              >
                恢复这个版本
              </el-button>
            </div>
          </div>

          <div v-if="compareMode" class="vh__compare">
            <p class="ws-hint">
              方向是「当前工作稿 → v{{ selected.version }}」：
              <span class="vh__add">+{{ stats.added }}</span> 行加入、
              <span class="vh__del">−{{ stats.removed }}</span> 行消失。
            </p>
            <div v-if="metaDiff.length" class="vh__meta-diff">
              <div
                v-for="row in metaDiff"
                :key="row.label"
                class="vh__meta-row"
              >
                <span class="ws-meta__label">{{ row.label }}</span>
                <span class="vh__del">{{ row.before }}</span>
                <span class="vh__arrow">→</span>
                <span class="vh__add">{{ row.after }}</span>
              </div>
            </div>
            <pre
              class="vh__diff"
            ><template v-for="(part, index) in changes" :key="index"><span
              :class="part.added ? 'vh__line-add' : part.removed ? 'vh__line-del' : ''"
            >{{ part.value }}</span></template></pre>
            <p class="ws-hint">
              这只是行级差异，用来判断改了哪一段；要看排版效果请切回「看完整内容」。
            </p>
          </div>

          <div v-else v-loading="selectedLoading" class="vh__preview">
            <p class="vh__title">{{ selected.title || "（无标题）" }}</p>
            <p v-if="selected.summary" class="ws-hint">
              {{ selected.summary }}
            </p>
            <MarkdownView :body="selected.body" />
          </div>
        </template>
        <EmptyState
          v-else
          glyph="◷"
          title="选一个版本"
          description="左边点一条，这里会显示它的完整内容和对比入口。"
        />
      </div>
    </div>
  </el-drawer>
</template>

<style scoped>
.vh {
  display: grid;
  grid-template-columns: minmax(220px, 300px) minmax(0, 1fr);
  gap: 18px;
  height: 100%;
  min-height: 420px;
}

.vh__list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 0;
}

.vh__list-head,
.vh__detail-head {
  display: flex;
  gap: 10px;
  align-items: center;
  justify-content: space-between;
}

.vh__items {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 6px;
  min-height: 160px;
  overflow-y: auto;
}

.vh__item {
  display: flex;
  flex-direction: column;
  gap: 3px;
  width: 100%;
  padding: 9px 11px;
  font: inherit;
  text-align: left;
  cursor: pointer;
  background: rgb(239 232 218 / 2%);
  border: 1px solid var(--line);
  border-radius: 10px;
  transition:
    border-color 150ms ease,
    background 150ms ease;
}

.vh__item:hover,
.vh__item.is-active {
  background: rgb(233 189 94 / 7%);
  border-color: color-mix(in srgb, var(--sol) 40%, transparent);
}

.vh__item-head {
  display: flex;
  gap: 6px;
  align-items: center;
}

.vh__ver {
  font-size: 12px;
  color: var(--sol);
}

.vh__item-title {
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 13px;
  color: var(--bone-2);
  white-space: nowrap;
}

.vh__detail {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
  min-height: 0;
}

.vh__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.vh__compare,
.vh__preview {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
}

.vh__diff {
  padding: 12px;
  margin: 8px 0 0;
  overflow-x: auto;
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.7;
  color: var(--bone-2);
  white-space: pre-wrap;
  background: rgb(3 4 10 / 50%);
  border: 1px solid var(--line);
  border-radius: 10px;
}

.vh__line-add {
  color: #8fd3a2;
  background: rgb(143 211 162 / 8%);
}

.vh__line-del {
  color: #e79a7d;
  background: rgb(231 154 125 / 8%);
}

.vh__meta-diff {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 8px;
}

.vh__meta-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: baseline;
  font-size: 12.5px;
}

.vh__arrow {
  color: var(--ash);
}

.vh__add {
  color: #8fd3a2;
}

.vh__del {
  color: #e79a7d;
}

.vh__title {
  margin: 0 0 6px;
  font-family: var(--font-display);
  font-size: 18px;
  color: var(--bone);
}

@media (width <= 820px) {
  .vh {
    grid-template-columns: 1fr;
  }

  .vh__items {
    max-height: 220px;
  }
}
</style>
