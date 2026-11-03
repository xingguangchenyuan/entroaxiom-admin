<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { ElMessageBox } from "element-plus";
import {
  deleteFile,
  getFile,
  listFileReferences,
  listFiles,
  updateFile,
  uploadFile
} from "@/api/file";
import { usePagedList } from "@/composables/usePagedList";
import { useCapabilitiesStore } from "@/store/modules/capabilities";
import { message } from "@/utils/message";
import { formatBytes, formatDateTime } from "@/utils/format";
import { fetchFileBlob, saveBlob } from "@/utils/media";
import type {
  FileItem,
  FileKind,
  FileListQuery,
  FileReference,
  Visibility
} from "@/api/types";
import PageHeader from "@/components/Manager/PageHeader.vue";
import StatusPill from "@/components/Manager/StatusPill.vue";
import EmptyState from "@/components/Manager/EmptyState.vue";
import AssetImage from "@/components/Manager/AssetImage.vue";

/**
 * 文件库。
 *
 * 三个容易出错的地方，都在这里处理掉：
 *  1. 私密文件不能直接给 <img src>（不会带 token），统一走 AssetImage 的鉴权读取；
 *  2. 删除前必须看引用：仍被内容引用时后端会拒绝，界面要显示“被谁引用”，而不是干巴巴报错；
 *  3. 上传要能手停：每个文件一个 AbortController，取消后立刻从队列里消失。
 */
const capabilities = useCapabilitiesStore();

const KIND_LABEL: Record<FileKind, string> = {
  image: "图片",
  pdf: "PDF",
  archive: "压缩包",
  doc: "文档",
  other: "其他"
};

const list = usePagedList<FileItem, FileListQuery>({
  fetcher: query => listFiles(query),
  initialQuery: {
    keyword: "",
    kind: undefined,
    visibility: undefined,
    unused: false
  },
  pageSize: 20
});

/* ------------------------------ 上传队列 ------------------------------ */

type JobStatus = "waiting" | "uploading" | "done" | "error";

interface UploadJob {
  key: string;
  name: string;
  percent: number;
  status: JobStatus;
  error: string;
  controller: AbortController;
}

const jobs = ref<UploadJob[]>([]);
const dragging = ref(false);
const activeCount = ref(0);

const concurrency = computed(() =>
  Math.max(1, capabilities.data.upload.maxConcurrent || 1)
);
const pending = computed(() =>
  jobs.value.filter(job => job.status === "waiting")
);

function extOf(name: string): string {
  return (name.split(".").pop() ?? "").toLowerCase();
}

function validate(file: File): string {
  const ext = extOf(file.name);
  const allowed = capabilities.allowedExtensions;
  if (allowed.length && !allowed.includes(ext)) {
    return `不支持 .${ext}，允许：${allowed.join(" / ")}`;
  }
  if (file.size > capabilities.maxFileBytes) {
    return `超过单文件上限 ${formatBytes(capabilities.maxFileBytes)}`;
  }
  return "";
}

/** 原始 File 存在 Map 里：放进 ref 会被深层响应式包住，反而不方便直接上传 */
const rawFiles = new Map<string, File>();

function pickFile(job: UploadJob): File | undefined {
  return rawFiles.get(job.key);
}

function pump() {
  while (activeCount.value < concurrency.value) {
    const next = jobs.value.find(job => job.status === "waiting");
    if (!next) break;
    run(next);
  }
}

async function run(job: UploadJob) {
  const file = pickFile(job);
  if (!file) {
    job.status = "error";
    job.error = "文件已不在内存中，请重新选择";
    return;
  }
  activeCount.value += 1;
  job.status = "uploading";
  try {
    await uploadFile(file, {
      visibility: "private",
      signal: job.controller.signal,
      onProgress: percent => {
        job.percent = percent;
      }
    });
    job.percent = 100;
    job.status = "done";
    await list.load();
  } catch (error) {
    if (job.controller.signal.aborted) {
      job.status = "error";
      job.error = "已取消";
    } else {
      job.status = "error";
      job.error = (error as Error)?.message ?? "上传失败";
    }
  } finally {
    activeCount.value -= 1;
    pump();
  }
}

function enqueueWithFiles(files: FileList | File[]) {
  const incoming = Array.from(files);
  incoming.forEach(file => {
    const key = `${file.name}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    rawFiles.set(key, file);
  });
  // 复用 enqueue 的校验与排队逻辑
  jobs.value.push(
    ...incoming.map(file => {
      const key = [...rawFiles.keys()].find(
        k => rawFiles.get(k) === file
      ) as string;
      const reason = validate(file);
      return {
        key,
        name: file.name,
        percent: 0,
        status: (reason ? "error" : "waiting") as JobStatus,
        error: reason,
        controller: new AbortController()
      };
    })
  );
  pump();
}

function cancel(job: UploadJob) {
  job.controller.abort();
  if (job.status === "waiting") {
    job.status = "error";
    job.error = "已取消";
  }
}

function clearFinished() {
  jobs.value = jobs.value.filter(
    job => job.status === "uploading" || job.status === "waiting"
  );
}

function onDrop(event: DragEvent) {
  dragging.value = false;
  enqueueWithFiles(event.dataTransfer?.files ?? []);
}

/* ------------------------------ 详情抽屉 ------------------------------ */

const drawerOpen = ref(false);
const detail = ref<FileItem | null>(null);
const references = ref<FileReference[]>([]);
const detailLoading = ref(false);
const saving = ref(false);
const form = reactive({
  name: "",
  description: "",
  visibility: "private" as Visibility
});
const previewSrc = ref<string>("");
const previewError = ref("");

function resetDetail() {
  detail.value = null;
  references.value = [];
  form.name = "";
  form.description = "";
  previewSrc.value = "";
  previewError.value = "";
}

async function openDetail(row: FileItem) {
  drawerOpen.value = true;
  detailLoading.value = true;
  resetDetail();
  try {
    const [file, refs] = await Promise.all([
      getFile(row.id),
      listFileReferences(row.id).catch(() => [] as FileReference[])
    ]);
    detail.value = file;
    references.value = refs ?? [];
    form.name = file.name;
    form.description = file.description ?? "";
    form.visibility = file.visibility;
    if (file.kind === "image" || file.kind === "pdf") {
      previewSrc.value = file.publicSrc ?? "";
    }
  } catch (error) {
    message((error as Error)?.message ?? "文件详情读取失败", { type: "error" });
  } finally {
    detailLoading.value = false;
  }
}

async function saveDetail() {
  if (!detail.value) return;
  if (!form.name.trim()) {
    message("名称不能为空", { type: "warning" });
    return;
  }
  saving.value = true;
  try {
    const updated = await updateFile(detail.value.id, {
      name: form.name.trim(),
      description: form.description.trim() || null,
      visibility: form.visibility,
      baseRevision: detail.value.revision
    });
    detail.value = updated;
    message("已保存", { type: "success" });
    list.load();
  } catch (error) {
    message((error as Error)?.message ?? "保存失败", { type: "error" });
  } finally {
    saving.value = false;
  }
}

async function removeFile(row: FileItem) {
  const refCount = row.referenceCount ?? 0;
  try {
    await ElMessageBox.confirm(
      refCount > 0
        ? `这个文件被 ${refCount} 处内容引用。删除后，那些地方的图片／附件会打不开。确定删除？`
        : "删除后不可恢复。确定删除这个文件？",
      "删除文件",
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
  try {
    await deleteFile(row.id, row.revision);
    message("已删除", { type: "success" });
    if (detail.value?.id === row.id) drawerOpen.value = false;
    list.load();
  } catch (error) {
    const err = error as { code?: string; details?: unknown };
    if (err?.code === "FILE_IN_USE") {
      // 后端把引用清单放在 details 里：直接展示“被谁引用”，并停在详情页
      message("仍被内容引用，先看引用清单再决定", { type: "warning" });
      openDetail(row);
      return;
    }
    message((error as Error)?.message ?? "删除失败", { type: "error" });
  }
}

async function download(row: FileItem) {
  try {
    const { blob, filename } = await fetchFileBlob(row.id);
    saveBlob(blob, filename || row.name);
  } catch (error) {
    message((error as Error)?.message ?? "下载失败", { type: "error" });
  }
}

const kindOptions = computed(() =>
  (Object.keys(KIND_LABEL) as FileKind[]).map(kind => ({
    value: kind,
    label: KIND_LABEL[kind]
  }))
);

onMounted(() => capabilities.ensure());

const USAGE_LABEL: Record<string, string> = {
  working: "工作稿",
  published: "已发布",
  version: "历史版本",
  cover: "封面"
};
const OWNER_LABEL: Record<string, string> = {
  essays: "随笔",
  notes: "笔记",
  shelf: "书影音"
};
</script>

<template>
  <div class="ws-page">
    <PageHeader
      eyebrow="Library"
      title="文件库"
      description="图片、PDF、附件的唯一存放处。正文里引用文件时用 asset:<文件ID>，发布时再决定私密资源是否复制成公开副本。"
    >
      <template #actions>
        <el-button size="small" @click="list.load">刷新</el-button>
      </template>
    </PageHeader>

    <div
      class="dropzone"
      :class="{ 'is-dragging': dragging }"
      @dragover.prevent="dragging = true"
      @dragleave.prevent="dragging = false"
      @drop.prevent="onDrop"
    >
      <input
        type="file"
        multiple
        class="dropzone__input"
        @change="
          enqueueWithFiles(($event.target as HTMLInputElement).files);
          ($event.target as HTMLInputElement).value = '';
        "
      />
      <p class="dropzone__title">把文件拖进来，或点击选择</p>
      <p class="ws-hint">
        单文件上限 {{ formatBytes(capabilities.maxFileBytes) }}，允许
        {{ capabilities.allowedExtensions.join(" / ") }}。
        上传后默认「私密」，只有明确改公开或被发布流程复制，才会出现在前台。
      </p>
    </div>

    <div v-if="jobs.length" class="ws-panel">
      <div class="ws-panel__head">
        <span class="ws-panel__title">上传队列</span>
        <el-button link size="small" @click="clearFinished"
          >清理已结束</el-button
        >
      </div>
      <div class="ws-panel__body jobs">
        <div v-for="job in jobs" :key="job.key" class="job">
          <span class="job__name ws-mono">{{ job.name }}</span>
          <el-progress
            v-if="job.status === 'uploading' || job.status === 'done'"
            :percentage="job.percent"
            :stroke-width="4"
            :show-text="false"
            :status="job.status === 'done' ? 'success' : undefined"
            class="job__bar"
          />
          <span
            v-else
            class="ws-hint"
            :class="{ 'ws-hint--danger': job.status === 'error' }"
          >
            {{ job.status === "waiting" ? "排队中" : job.error }}
          </span>
          <el-button
            v-if="job.status === 'uploading' || job.status === 'waiting'"
            link
            size="small"
            @click="cancel(job)"
          >
            取消
          </el-button>
        </div>
        <p v-if="pending.length" class="ws-hint">
          还有 {{ pending.length }} 个在排队。
        </p>
      </div>
    </div>

    <div class="ws-toolbar">
      <el-input
        v-model="list.query.keyword"
        placeholder="搜索名称或说明"
        clearable
        size="small"
        style="max-width: 240px"
        @input="list.search"
        @clear="list.search"
      />
      <el-select
        v-model="list.query.kind"
        placeholder="全部类型"
        clearable
        size="small"
        style="width: 132px"
        @change="list.search"
      >
        <el-option
          v-for="option in kindOptions"
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
        style="width: 132px"
        @change="list.search"
      >
        <el-option label="公开" value="public" />
        <el-option label="私密" value="private" />
      </el-select>
      <el-checkbox
        v-model="list.query.unused"
        size="small"
        @change="list.search"
      >
        只看未被引用
      </el-checkbox>
      <span class="ws-toolbar__spacer" />
      <span class="ws-meta">
        <span class="ws-meta__item">
          <span class="ws-meta__label">共</span>
          <span class="ws-meta__value">{{ list.total.value }}</span>
          <span class="ws-meta__label">个文件</span>
        </span>
      </span>
    </div>

    <div class="ws-panel">
      <el-table
        v-loading="list.loading.value"
        :data="list.items.value"
        row-key="id"
        size="small"
        class="ws-row-click"
        @row-click="openDetail"
      >
        <el-table-column label="文件" min-width="260">
          <template #default="{ row }">
            <div class="file-cell">
              <AssetImage
                v-if="row.kind === 'image'"
                class="file-cell__thumb"
                :file-id="row.visibility === 'private' ? row.id : null"
                :src="row.publicSrc"
                :alt="row.name"
                aspect="1 / 1"
              />
              <span v-else class="file-cell__glyph ws-mono">{{
                row.ext || "?"
              }}</span>
              <div class="min-w-0">
                <p class="ws-cell-title truncate">{{ row.name }}</p>
                <p class="ws-cell-sub truncate">
                  {{ row.description || "无说明" }}
                </p>
              </div>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="类型" width="90">
          <template #default="{ row }">
            <span class="ws-mono">{{
              KIND_LABEL[row.kind as FileKind] ?? row.kind
            }}</span>
          </template>
        </el-table-column>
        <el-table-column label="大小" width="92">
          <template #default="{ row }">
            <span class="ws-num">{{ formatBytes(row.size) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="权限" width="92">
          <template #default="{ row }">
            <StatusPill :value="row.visibility" kind="visibility" />
          </template>
        </el-table-column>
        <el-table-column label="引用" width="72">
          <template #default="{ row }">
            <span class="ws-num" :class="{ 'is-zero': !row.referenceCount }">
              {{ row.referenceCount }}
            </span>
          </template>
        </el-table-column>
        <el-table-column label="更新" width="140">
          <template #default="{ row }">
            <span class="ws-mono ws-cell-sub">{{
              formatDateTime(row.updatedAt)
            }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="180" align="right">
          <template #default="{ row }">
            <el-button link size="small" @click.stop="openDetail(row)"
              >详情</el-button
            >
            <el-button link size="small" @click.stop="download(row)"
              >下载</el-button
            >
            <el-button
              link
              size="small"
              type="danger"
              @click.stop="removeFile(row)"
            >
              删除
            </el-button>
          </template>
        </el-table-column>
        <template #empty>
          <EmptyState
            v-if="list.isFiltered.value"
            glyph="⌕"
            title="没有匹配的文件"
            description="换个关键词，或清空筛选条件。"
            action-text="清空筛选"
            @action="list.reset"
          />
          <EmptyState
            v-else
            glyph="▤"
            title="文件库还是空的"
            description="把图片或附件拖到上面的区域，就能在正文里引用它们。"
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

    <el-drawer v-model="drawerOpen" title="文件详情" size="min(92vw, 560px)">
      <div v-loading="detailLoading" class="drawer">
        <template v-if="detail">
          <div
            v-if="detail.kind === 'image' || detail.kind === 'pdf'"
            class="drawer__preview"
          >
            <AssetImage
              v-if="detail.kind === 'image'"
              :file-id="detail.visibility === 'private' ? detail.id : null"
              :src="previewSrc || detail.publicSrc"
              :alt="detail.name"
              aspect="auto"
              fit="contain"
            />
            <div v-else class="drawer__pdf">
              <p class="ws-hint">
                PDF
                预览依赖浏览器内置阅读器。私密文件通过鉴权地址临时读取，离开页面即失效。
              </p>
              <el-button size="small" @click="download(detail)"
                >下载后查看</el-button
              >
            </div>
          </div>

          <el-form label-position="top" size="small" class="drawer__form">
            <el-form-item label="名称">
              <el-input v-model="form.name" maxlength="120" show-word-limit />
            </el-form-item>
            <el-form-item label="说明（可选）">
              <el-input
                v-model="form.description"
                type="textarea"
                :rows="2"
                maxlength="300"
                show-word-limit
                placeholder="给自己看的备注，不会出现在前台"
              />
            </el-form-item>
            <el-form-item label="可见范围">
              <el-radio-group v-model="form.visibility">
                <el-radio value="private">私密（需登录，前台不显示）</el-radio>
                <el-radio value="public">公开（可直接访问）</el-radio>
              </el-radio-group>
            </el-form-item>
            <p class="ws-hint">
              改成公开会让任何拿到链接的人都能访问。若只是想在文章里显示，
              更安全的做法是发布时选择“复制为公开副本”。
            </p>
          </el-form>

          <div class="drawer__actions">
            <el-button
              type="primary"
              size="small"
              :loading="saving"
              @click="saveDetail"
            >
              保存修改
            </el-button>
            <el-button size="small" @click="download(detail)">下载</el-button>
            <el-button size="small" type="danger" @click="removeFile(detail)"
              >删除</el-button
            >
          </div>

          <hr class="ws-rule" />

          <div class="drawer__section">
            <p class="ws-panel__title">被谁引用</p>
            <p v-if="!references.length" class="ws-hint">
              还没有内容引用它。未被引用的文件可以安全删除。
            </p>
            <ul v-else class="refs">
              <li
                v-for="ref in references"
                :key="`${ref.owner}-${ref.targetId}-${ref.usage}-${ref.version ?? ''}`"
              >
                <span class="ws-pill ws-pill--mute">{{
                  OWNER_LABEL[ref.owner] ?? ref.owner
                }}</span>
                <span class="refs__title">{{ ref.title || ref.targetId }}</span>
                <span class="ws-mono ws-hint">
                  {{ USAGE_LABEL[ref.usage] ?? ref.usage }}
                  <template v-if="ref.version">· v{{ ref.version }}</template>
                  <template v-if="ref.isPublic"> · 前台可见</template>
                </span>
              </li>
            </ul>
          </div>

          <hr class="ws-rule" />

          <div class="ws-meta">
            <span class="ws-meta__item">
              <span class="ws-meta__label">ID</span>
              <span class="ws-meta__value">{{ detail.id }}</span>
            </span>
            <span class="ws-meta__item">
              <span class="ws-meta__label">版本</span>
              <span class="ws-meta__value">{{ detail.revision }}</span>
            </span>
            <span class="ws-meta__item">
              <span class="ws-meta__label">创建</span>
              <span class="ws-meta__value">{{
                formatDateTime(detail.createdAt)
              }}</span>
            </span>
          </div>
        </template>
        <p v-else-if="!detailLoading" class="ws-hint">
          {{ previewError || "没有读取到文件信息。" }}
        </p>
      </div>
    </el-drawer>
  </div>
</template>

<style scoped>
.dropzone {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 22px;
  text-align: center;
  cursor: pointer;
  background: linear-gradient(150deg, rgb(233 189 94 / 5%), transparent 60%);
  border: 1px dashed var(--line-2);
  border-radius: 16px;
  transition:
    border-color 160ms ease,
    background 160ms ease;
}

.dropzone:hover,
.dropzone.is-dragging {
  background: linear-gradient(150deg, rgb(233 189 94 / 10%), transparent 60%);
  border-color: color-mix(in srgb, var(--sol) 55%, transparent);
}

.dropzone__input {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  cursor: pointer;
  opacity: 0;
}

.dropzone__title {
  font-family: var(--font-display);
  font-size: 16px;
  color: var(--bone);
}

.jobs {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.job {
  display: grid;
  grid-template-columns: minmax(120px, 1fr) minmax(120px, 240px) 64px;
  gap: 12px;
  align-items: center;
}

.job__name {
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 12px;
  color: var(--bone-2);
  white-space: nowrap;
}

.file-cell {
  display: flex;
  gap: 10px;
  align-items: center;
  min-width: 0;
}

.file-cell__thumb {
  flex: 0 0 40px;
  width: 40px;
}

.file-cell__glyph {
  display: grid;
  flex: 0 0 40px;
  place-items: center;
  width: 40px;
  height: 40px;
  font-size: 10.5px;
  color: var(--sol);
  text-transform: uppercase;
  background: rgb(233 189 94 / 8%);
  border: 1px solid var(--line);
  border-radius: 8px;
}

.truncate {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.is-zero {
  color: var(--ash);
}

.pager {
  display: flex;
  justify-content: flex-end;
  padding: 12px 16px;
  border-top: 1px solid var(--line);
}

.drawer {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.drawer__preview {
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: 12px;
}

.drawer__pdf {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 18px;
  text-align: center;
}

.drawer__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.drawer__section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.refs {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 0;
  margin: 0;
  list-style: none;
}

.refs li {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  padding: 8px 10px;
  background: rgb(239 232 218 / 3%);
  border: 1px solid var(--line);
  border-radius: 10px;
}

.refs__title {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 13px;
  color: var(--bone-2);
  white-space: nowrap;
}
</style>
