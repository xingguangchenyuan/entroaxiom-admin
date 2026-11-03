<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessageBox } from "element-plus";
import {
  createArticle,
  deleteArticle,
  getArticle,
  getContentOptions,
  getPublishedView,
  listArticles
} from "@/api/content";
import type {
  ArticleListItem,
  ArticleListQuery,
  ContentOptions,
  ContentRes,
  PublicationStatus,
  PublishedArticleView,
  Visibility
} from "@/api/types";
import { usePagedList } from "@/composables/usePagedList";
import { message } from "@/utils/message";
import { formatDate, formatDateTime } from "@/utils/format";
import PageHeader from "@/components/Manager/PageHeader.vue";
import StatusPill from "@/components/Manager/StatusPill.vue";
import EmptyState from "@/components/Manager/EmptyState.vue";
import MarkdownView from "@/components/Manager/MarkdownView.vue";

/**
 * 随笔／笔记列表。两类内容字段同构，只有随笔多 mood／place，
 * 因此共用这一个页面，靠路由 meta.res 区分，避免复制两份实现。
 *
 * 注意“状态”有三层，界面上必须分开表达，不能混成一个徽章：
 *  1. status：有没有线上快照（draft／published）；
 *  2. visibility：私密／公开；
 *  3. hasUnpublishedChanges：工作稿与快照是否已经不同（不能只看 updatedAt）。
 */
const route = useRoute();
const router = useRouter();

const res = computed<ContentRes>(() => {
  const fromMeta = (route.meta as { res?: string }).res;
  return (
    fromMeta === "notes" || fromMeta === "essays" ? fromMeta : "essays"
  ) as ContentRes;
});
const isEssay = computed(() => res.value === "essays");
const resLabel = computed(() => (isEssay.value ? "随笔" : "学习笔记"));
const resLabelEn = computed(() => (isEssay.value ? "Essays" : "Notes"));

const list = usePagedList<ArticleListItem, ArticleListQuery>({
  fetcher: query =>
    // 开关只表达“只看有未发布修改”；关着的时候不要下发 false，否则查询串里会多一个无意义条件
    listArticles(res.value, {
      ...query,
      hasUnpublishedChanges: query.hasUnpublishedChanges ? true : undefined
    }),
  initialQuery: {
    keyword: "",
    status: undefined,
    visibility: undefined,
    category: undefined,
    tag: undefined,
    hasUnpublishedChanges: false
  },
  pageSize: 20
});

const options = ref<ContentOptions>({ categories: [], tags: [] });

async function loadOptions() {
  try {
    options.value = await getContentOptions(res.value);
  } catch {
    options.value = { categories: [], tags: [] };
  }
}

/* ------------------------------ 新建 ------------------------------ */

const createOpen = ref(false);
const creating = ref(false);
const createForm = reactive({ title: "", summary: "" });

function openCreate() {
  createForm.title = "";
  createForm.summary = "";
  createOpen.value = true;
}

async function submitCreate() {
  const title = createForm.title.trim();
  if (!title) {
    message("先给这篇文章起个标题", { type: "warning" });
    return;
  }
  creating.value = true;
  try {
    // 新建一律是私密工作稿：发布必须由站长在编辑页显式走预检流程
    const created = await createArticle(res.value, {
      id: "",
      title,
      summary: createForm.summary.trim() || null,
      category: null,
      tags: null,
      date: null,
      updated: null,
      body: "",
      ...(isEssay.value ? { mood: null, place: null } : {})
    });
    createOpen.value = false;
    message("已创建私密工作稿", { type: "success" });
    router.push(`/content/${res.value}/${created.id}`);
  } catch (error) {
    message((error as Error)?.message ?? "创建失败", { type: "error" });
  } finally {
    creating.value = false;
  }
}

/* ------------------------------ 删除 ------------------------------ */

const removingId = ref("");

/**
 * 列表行不带 revision（列表只给摘要与发布元信息），
 * 所以删除前先取一次详情拿最新 revision——同时也顺便确认“线上确实没有别人刚改过”。
 */
async function removeArticle(row: ArticleListItem) {
  const label = row.title || row.id;
  try {
    await ElMessageBox.confirm(
      row.status === "published"
        ? `《${label}》正在前台公开。删除会同时撤掉公开入口，且不可恢复。确定删除？`
        : `确定删除《${label}》？删除后不可恢复。`,
      "删除文章",
      {
        type: "warning",
        confirmButtonText: "删除",
        cancelButtonText: "取消",
        confirmButtonClass: "el-button--danger"
      }
    );
  } catch {
    return;
  }
  removingId.value = row.id;
  try {
    const detail = await getArticle(res.value, row.id);
    await deleteArticle(res.value, row.id, detail.revision);
    message("已删除", { type: "success" });
    await list.loadAfterRemove();
  } catch (error) {
    const err = error as { code?: string };
    if (err?.code === "REVISION_CONFLICT") {
      message("这篇刚被改动过，列表已刷新，请再确认一次", { type: "warning" });
      list.load();
    } else {
      message((error as Error)?.message ?? "删除失败", { type: "error" });
    }
  } finally {
    removingId.value = "";
  }
}

/* ------------------------------ 线上快照 ------------------------------ */

const previewOpen = ref(false);
const previewLoading = ref(false);
const preview = ref<PublishedArticleView | null>(null);
const previewError = ref("");
const previewTitle = ref("");

async function viewPublished(row: ArticleListItem) {
  previewOpen.value = true;
  previewLoading.value = true;
  preview.value = null;
  previewError.value = "";
  previewTitle.value = row.title || row.id;
  try {
    preview.value = await getPublishedView(res.value, row.id);
  } catch (error) {
    previewError.value =
      (error as Error)?.message ?? "这篇没有线上快照，或快照读取失败。";
  } finally {
    previewLoading.value = false;
  }
}

/* ------------------------------ 工具 ------------------------------ */

const statusOptions: Array<{ value: PublicationStatus; label: string }> = [
  { value: "draft", label: "未发布" },
  { value: "published", label: "已发布" }
];
const visibilityOptions: Array<{ value: Visibility; label: string }> = [
  { value: "public", label: "公开" },
  { value: "private", label: "私密" }
];

const rows = computed(() => list.items.value);

function openEdit(row: ArticleListItem) {
  router.push(`/content/${res.value}/${row.id}`);
}

onMounted(async () => {
  await Promise.all([list.load(), loadOptions()]);
});
</script>

<template>
  <div class="ws-page">
    <PageHeader
      :eyebrow="`Content / ${resLabelEn}`"
      :title="resLabel"
      :description="
        isEssay
          ? '随笔按写作日期归档，带心情与地点。工作稿可以随便改，只有发布之后前台才会变。'
          : '学习笔记按分类与标签组织。工作稿与线上快照分开保存，发布前会先做一次资源检查。'
      "
    >
      <template #actions>
        <el-button size="small" @click="list.load">刷新</el-button>
        <el-button type="primary" size="small" @click="openCreate">
          新建{{ resLabel }}
        </el-button>
      </template>
    </PageHeader>

    <div class="ws-toolbar">
      <el-input
        v-model="list.query.keyword"
        placeholder="搜索标题、摘要或正文"
        clearable
        size="small"
        style="max-width: 260px"
        @input="list.search"
        @clear="list.search"
      />
      <el-select
        v-model="list.query.status"
        placeholder="全部状态"
        clearable
        size="small"
        style="width: 118px"
        @change="list.search"
      >
        <el-option
          v-for="option in statusOptions"
          :key="option.value"
          :label="option.label"
          :value="option.value"
        />
      </el-select>
      <el-select
        v-model="list.query.visibility"
        placeholder="全部权限"
        clearable
        size="small"
        style="width: 118px"
        @change="list.search"
      >
        <el-option
          v-for="option in visibilityOptions"
          :key="option.value"
          :label="option.label"
          :value="option.value"
        />
      </el-select>
      <el-select
        v-if="options.categories.length"
        v-model="list.query.category"
        placeholder="全部分类"
        clearable
        size="small"
        style="width: 130px"
        @change="list.search"
      >
        <el-option
          v-for="category in options.categories"
          :key="category"
          :label="category"
          :value="category"
        />
      </el-select>
      <el-select
        v-if="options.tags.length"
        v-model="list.query.tag"
        placeholder="全部标签"
        clearable
        filterable
        size="small"
        style="width: 130px"
        @change="list.search"
      >
        <el-option
          v-for="tag in options.tags"
          :key="tag"
          :label="tag"
          :value="tag"
        />
      </el-select>
      <el-checkbox
        v-model="list.query.hasUnpublishedChanges"
        size="small"
        @change="list.search"
      >
        只看有未发布修改
      </el-checkbox>
      <span class="ws-toolbar__spacer" />
      <span class="ws-meta">
        <span class="ws-meta__item">
          <span class="ws-meta__label">共</span>
          <span class="ws-meta__value">{{ list.total.value }}</span>
          <span class="ws-meta__label">篇</span>
        </span>
      </span>
    </div>

    <div class="ws-panel">
      <el-table
        v-loading="list.loading.value"
        :data="rows"
        row-key="id"
        size="small"
        class="ws-row-click"
        @row-click="openEdit"
      >
        <el-table-column label="标题" min-width="300">
          <template #default="{ row }">
            <div class="title-cell">
              <p class="ws-cell-title">
                <span
                  v-if="row.hasUnpublishedChanges"
                  class="dot"
                  title="有未发布的修改"
                />
                {{ row.title || "（无标题）" }}
              </p>
              <p class="ws-cell-sub line-2">{{ row.summary || "无摘要" }}</p>
              <p v-if="isEssay && (row.mood || row.place)" class="ws-cell-sub">
                <span v-if="row.mood">{{ row.mood }}</span>
                <span v-if="row.place" class="sep">·</span>
                <span v-if="row.place">{{ row.place }}</span>
              </p>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="归类" width="150">
          <template #default="{ row }">
            <div class="classify">
              <span v-if="row.category" class="ws-pill ws-pill--mute">{{
                row.category
              }}</span>
              <span
                v-for="tag in (row.tags ?? []).slice(0, 2)"
                :key="tag"
                class="ws-pill ws-pill--mute"
              >
                {{ tag }}
              </span>
              <span v-if="(row.tags ?? []).length > 2" class="ws-hint">
                +{{ (row.tags ?? []).length - 2 }}
              </span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="日期" width="104">
          <template #default="{ row }">
            <span class="ws-mono ws-cell-sub">
              {{ row.date ? formatDate(row.date) : "—" }}
            </span>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="150">
          <template #default="{ row }">
            <div class="status-cell">
              <StatusPill :value="row.status" kind="publication" />
              <StatusPill :value="row.visibility" kind="visibility" />
            </div>
          </template>
        </el-table-column>
        <el-table-column label="更新" width="128">
          <template #default="{ row }">
            <span class="ws-mono ws-cell-sub">{{
              formatDateTime(row.updatedAt)
            }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="168" align="right">
          <template #default="{ row }">
            <el-button link size="small" @click.stop="openEdit(row)"
              >编辑</el-button
            >
            <el-button
              link
              size="small"
              :disabled="row.status !== 'published'"
              @click.stop="viewPublished(row)"
            >
              线上
            </el-button>
            <el-button
              link
              size="small"
              type="danger"
              :loading="removingId === row.id"
              @click.stop="removeArticle(row)"
            >
              删除
            </el-button>
          </template>
        </el-table-column>
        <template #empty>
          <EmptyState
            v-if="list.isFiltered.value"
            glyph="⌕"
            title="没有匹配的文章"
            description="换个关键词，或清空筛选条件。"
            action-text="清空筛选"
            @action="list.reset"
          />
          <EmptyState
            v-else
            glyph="✎"
            :title="`还没有${resLabel}`"
            :description="`点右上角新建，先写成私密工作稿；写顺了再发布。`"
            action-text="新建"
            @action="openCreate"
          />
        </template>
      </el-table>

      <div v-if="list.total.value > list.pageSize.value" class="pager">
        <el-pagination
          background
          layout="prev, pager, next, sizes"
          :current-page="list.page.value"
          :page-size="list.pageSize.value"
          :page-sizes="[20, 50, 100]"
          :total="list.total.value"
          @current-change="list.setPage"
          @size-change="list.setPageSize"
        />
      </div>
    </div>

    <el-dialog v-model="createOpen" title="新建" width="min(92vw, 460px)">
      <el-form label-position="top" size="small" @submit.prevent="submitCreate">
        <el-form-item label="标题">
          <el-input
            v-model="createForm.title"
            maxlength="120"
            show-word-limit
            placeholder="先写一个能认出它的标题"
            @keyup.enter="submitCreate"
          />
        </el-form-item>
        <el-form-item label="摘要（可选）">
          <el-input
            v-model="createForm.summary"
            type="textarea"
            :rows="3"
            maxlength="300"
            show-word-limit
            placeholder="列表里显示的两三行话，之后也能改"
          />
        </el-form-item>
        <p class="ws-hint">
          新建后是私密工作稿：前台看不到，也没有线上快照。发布是编辑页里的独立动作，
          会先检查私密资源。
        </p>
      </el-form>
      <template #footer>
        <el-button size="small" @click="createOpen = false">取消</el-button>
        <el-button
          type="primary"
          size="small"
          :loading="creating"
          @click="submitCreate"
        >
          创建并开始写
        </el-button>
      </template>
    </el-dialog>

    <el-drawer
      v-model="previewOpen"
      :title="`线上快照 · ${previewTitle}`"
      size="min(94vw, 720px)"
    >
      <div v-loading="previewLoading" class="preview">
        <template v-if="preview">
          <div class="ws-meta">
            <span class="ws-meta__item">
              <span class="ws-meta__label">发布</span>
              <span class="ws-meta__value">{{
                formatDateTime(preview.publishedAt)
              }}</span>
            </span>
            <span class="ws-meta__item">
              <span class="ws-meta__label">快照版本</span>
              <span class="ws-meta__value">{{
                preview.publishedRevision
              }}</span>
            </span>
            <span class="ws-meta__item">
              <span class="ws-meta__label">权限</span>
              <span class="ws-meta__value">
                {{ preview.visibility === "public" ? "公开" : "私密" }}
              </span>
            </span>
          </div>
          <p class="ws-hint">
            这是访客现在看到的内容。它不是工作稿——工作稿里未发布的修改不会出现在这里。
          </p>
          <hr class="ws-rule" />
          <MarkdownView :body="preview.body" />
        </template>
        <EmptyState
          v-else-if="!previewLoading"
          glyph="◌"
          title="没有读到线上快照"
          :description="previewError"
        />
      </div>
    </el-drawer>
  </div>
</template>

<style scoped>
.title-cell {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  margin-right: 6px;
  vertical-align: middle;
  background: var(--sol);
  border-radius: 50%;
}

.line-2 {
  display: -webkit-box;
  overflow: hidden;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.sep {
  margin: 0 4px;
  color: var(--ash);
}

.classify {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  align-items: center;
}

.status-cell {
  display: flex;
  gap: 4px;
  align-items: center;
}

.pager {
  display: flex;
  justify-content: flex-end;
  padding: 12px 16px;
  border-top: 1px solid var(--line);
}

.preview {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
</style>
