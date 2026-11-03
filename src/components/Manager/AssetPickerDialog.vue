<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { listFiles, uploadFile } from "@/api/file";
import { message } from "@/utils/message";
import { useCapabilitiesStore } from "@/store/modules/capabilities";
import type { FileItem, FileKind } from "@/api/types";
import AssetImage from "./AssetImage.vue";

/**
 * 从文件库挑一个文件（也可以就地上传）。
 *
 * 为什么不让编辑器直接写外链：私密资源必须走 `asset:<fileId>`，
 * 这样发布时后端能判断“正文引用了私密图片”，并在必要时复制成公开副本。
 * 直接贴 /uploads/xxx.jpg 会让私密内容在发布后 404，或者反过来把私密图暴露成公开地址。
 */
const props = withDefaults(
  defineProps<{
    modelValue: boolean;
    /** 限制可选的文件大类，例如只让正文插图选 image */
    kinds?: FileKind[];
    title?: string;
  }>(),
  { kinds: () => [], title: "从文件库选择" }
);

const emit = defineEmits<{
  "update:modelValue": [boolean];
  pick: [FileItem];
}>();

const capabilities = useCapabilitiesStore();
const open = computed({
  get: () => props.modelValue,
  set: (v: boolean) => emit("update:modelValue", v)
});

const items = ref<FileItem[]>([]);
const total = ref(0);
const page = ref(1);
const pageSize = 24;
const keyword = ref("");
const loading = ref(false);
const errorText = ref("");
const selected = ref<FileItem | null>(null);
let seq = 0;

const kindFilter = computed(() =>
  props.kinds.length === 1 ? props.kinds[0] : undefined
);

async function load(reset = false) {
  if (reset) {
    page.value = 1;
    items.value = [];
  }
  const current = ++seq;
  loading.value = true;
  errorText.value = "";
  try {
    const result = await listFiles({
      page: page.value,
      pageSize,
      keyword: keyword.value.trim() || undefined,
      kind: kindFilter.value
    });
    if (current !== seq) return;
    const incoming = (result?.items ?? []).filter(item =>
      props.kinds.length ? props.kinds.includes(item.kind) : true
    );
    items.value = reset ? incoming : [...items.value, ...incoming];
    total.value = result?.total ?? 0;
  } catch (error) {
    if (current !== seq) return;
    errorText.value = (error as Error)?.message ?? "文件列表读取失败";
  } finally {
    if (current === seq) loading.value = false;
  }
}

watch(
  () => props.modelValue,
  visible => {
    if (!visible) return;
    capabilities.ensure();
    selected.value = null;
    keyword.value = "";
    load(true);
  }
);

let searchTimer: ReturnType<typeof setTimeout> | undefined;
function onSearch() {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => load(true), 260);
}

/* ------------------------------ 上传 ------------------------------ */

interface UploadRow {
  key: string;
  name: string;
  percent: number;
  error: string;
}

const uploads = ref<UploadRow[]>([]);
const uploading = computed(() =>
  uploads.value.some(row => !row.error && row.percent < 100)
);

const EXT_KIND: Record<string, FileKind> = {
  jpg: "image",
  jpeg: "image",
  png: "image",
  webp: "image",
  gif: "image",
  avif: "image",
  pdf: "pdf",
  zip: "archive",
  md: "doc",
  txt: "doc"
};

function validate(file: File): string {
  const ext = (file.name.split(".").pop() ?? "").toLowerCase();
  const allowed = capabilities.allowedExtensions;
  if (!allowed.includes(ext)) {
    return `不支持 .${ext} 格式，允许：${allowed.join(" / ")}`;
  }
  if (props.kinds.length) {
    const kind = EXT_KIND[ext] ?? "other";
    if (!props.kinds.includes(kind)) {
      return `这里只能选${props.kinds.map(k => (k === "image" ? "图片" : k)).join(" / ")}`;
    }
  }
  if (file.size > capabilities.maxFileBytes) {
    return `文件超过上限 ${formatBytes(capabilities.maxFileBytes)}`;
  }
  return "";
}

function formatBytes(bytes: number): string {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1
  );
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

async function handleFileList(files: FileList | null) {
  if (!files?.length) return;
  for (const file of Array.from(files)) {
    const invalid = validate(file);
    const row: UploadRow = {
      key: `${file.name}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      name: file.name,
      percent: 0,
      error: invalid
    };
    uploads.value.push(row);
    if (invalid) continue;
    try {
      const created = await uploadFile(file, {
        visibility: "private",
        onProgress: percent => {
          const target = uploads.value.find(u => u.key === row.key);
          if (target) target.percent = percent;
        }
      });
      const target = uploads.value.find(u => u.key === row.key);
      if (target) target.percent = 100;
      if (created) {
        items.value = [created, ...items.value];
        total.value += 1;
        selected.value = created;
      }
    } catch (error) {
      const target = uploads.value.find(u => u.key === row.key);
      if (target) target.error = (error as Error)?.message ?? "上传失败";
    }
  }
}

function onDrop(event: DragEvent) {
  event.preventDefault();
  handleFileList(event.dataTransfer?.files ?? null);
}

function confirm() {
  if (!selected.value) {
    message("请先选择一个文件", { type: "warning" });
    return;
  }
  emit("pick", selected.value);
  open.value = false;
}
</script>

<template>
  <el-dialog
    v-model="open"
    :title="title"
    width="min(94vw, 900px)"
    append-to-body
  >
    <div class="picker">
      <div class="picker__bar">
        <el-input
          v-model="keyword"
          placeholder="按名称搜索"
          clearable
          size="small"
          class="picker__search"
          @input="onSearch"
        />
        <span class="ws-meta">
          <span class="ws-meta__item">
            <span class="ws-meta__label">共</span>
            <span class="ws-meta__value">{{ total }}</span>
            <span class="ws-meta__label">个</span>
          </span>
        </span>
      </div>

      <div class="picker__drop" @dragover.prevent @drop="onDrop">
        <input
          type="file"
          multiple
          class="picker__file"
          @change="handleFileList(($event.target as HTMLInputElement).files)"
        />
        <span class="ws-mono">拖入文件，或点击选择上传</span>
        <span class="ws-hint">
          单个上限
          {{ formatBytes(capabilities.maxFileBytes) }}；上传后默认「私密」，
          发布文章时会让你决定是否复制成公开副本。
        </span>
      </div>

      <div v-if="uploads.length" class="picker__uploads">
        <div v-for="row in uploads" :key="row.key" class="picker__upload">
          <span class="picker__upload-name ws-mono">{{ row.name }}</span>
          <el-progress
            v-if="!row.error"
            :percentage="row.percent"
            :stroke-width="4"
            :show-text="false"
            class="picker__upload-bar"
          />
          <span v-if="row.error" class="ws-hint ws-hint--danger">{{
            row.error
          }}</span>
        </div>
      </div>

      <p v-if="errorText" class="ws-hint ws-hint--danger">{{ errorText }}</p>

      <div v-loading="loading" class="picker__grid">
        <button
          v-for="item in items"
          :key="item.id"
          type="button"
          class="picker__cell"
          :class="{ 'is-selected': selected?.id === item.id }"
          @click="selected = item"
          @dblclick="
            selected = item;
            confirm();
          "
        >
          <AssetImage
            :file-id="item.visibility === 'private' ? item.id : null"
            :src="item.publicSrc"
            :alt="item.name"
            aspect="4 / 3"
          />
          <span class="picker__name">{{ item.name }}</span>
          <span class="picker__meta ws-mono">{{ formatBytes(item.size) }}</span>
        </button>
        <div v-if="!items.length && !loading" class="picker__empty ws-hint">
          文件库里还没有内容。可以先把图片拖进来。
        </div>
      </div>

      <div v-if="items.length < total" class="picker__more">
        <el-button
          size="small"
          :loading="loading"
          @click="
            page += 1;
            load();
          "
        >
          加载更多（{{ items.length }} / {{ total }}）
        </el-button>
      </div>
    </div>

    <template #footer>
      <el-button @click="open = false">取消</el-button>
      <el-button
        type="primary"
        :disabled="!selected || uploading"
        @click="confirm"
      >
        使用所选文件
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.picker {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.picker__bar {
  display: flex;
  gap: 12px;
  align-items: center;
}

.picker__search {
  max-width: 280px;
}

.picker__drop {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 16px;
  text-align: center;
  cursor: pointer;
  border: 1px dashed var(--line-2);
  border-radius: 12px;
}

.picker__drop:hover {
  border-color: color-mix(in srgb, var(--sol) 45%, transparent);
}

.picker__file {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  cursor: pointer;
  opacity: 0;
}

.picker__uploads {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.picker__upload {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 140px;
  gap: 10px;
  align-items: center;
  font-size: 12px;
}

.picker__upload-name {
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--bone-2);
  white-space: nowrap;
}

.picker__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(132px, 1fr));
  gap: 10px;
  min-height: 120px;
  max-height: 46vh;
  padding: 2px;
  overflow: auto;
}

.picker__cell {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px;
  text-align: left;
  cursor: pointer;
  background: rgb(239 232 218 / 2%);
  border: 1px solid var(--line);
  border-radius: 12px;
}

.picker__cell:hover {
  border-color: var(--line-2);
}

.picker__cell.is-selected {
  border-color: var(--sol);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--sol) 55%, transparent) inset;
}

.picker__name {
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 12px;
  color: var(--bone-2);
  white-space: nowrap;
}

.picker__meta {
  font-size: 10.5px;
  color: var(--ash);
}

.picker__empty {
  grid-column: 1 / -1;
  padding: 32px 0;
  text-align: center;
}

.picker__more {
  display: flex;
  justify-content: center;
}
</style>
