<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import { useRouter } from "vue-router";
import {
  cancelImport,
  commitImport,
  selectImportCandidate,
  uploadImport
} from "@/api/imports";
import type {
  ContentRes,
  ImportAsset,
  ImportPreview,
  ImportWarning
} from "@/api/types";
import { useCapabilitiesStore } from "@/store/modules/capabilities";
import { formatBytes, formatDateTime } from "@/utils/format";
import { message } from "@/utils/message";
import PageHeader from "@/components/Manager/PageHeader.vue";

/**
 * Markdown / ZIP 导入。
 *
 * 三步，每一步都有“为什么”：
 *  1. **预检**：包只到临时区，后端不解压进站点目录、不写库。你在这一步看到
 *     会遇到什么问题（资源缺失、ID 冲突、不认识的 frontmatter）。
 *  2. **确认**：可以改标题／摘要／正文，可以决定没用到的包内文件带不带。
 *     ZIP 里有多篇时必须自己选一篇——不让后端替你猜。
 *  3. **提交**：新建，或者更新同 ID 的既有内容。更新会先把原工作稿存成版本，
 *     所以即使覆盖错了，也还能从版本历史里取回。
 *
 * importId 是临时的：刷新页面就失效，必须重新上传。这里故意不做持久化。
 */
const router = useRouter();
const capabilities = useCapabilitiesStore();

const step = ref(1);
const type = ref<ContentRes>("notes");
const file = ref<File | null>(null);
const uploading = ref(false);
const percent = ref(0);
const dragging = ref(false);
const controller = ref<AbortController | null>(null);

const preview = ref<ImportPreview | null>(null);
const selecting = ref(false);
const committing = ref(false);
const result = ref<{
  articleId: string;
  title: string;
  createdAssets: number;
  linkedAssets: number;
  preservedVersion: string | null;
} | null>(null);

const MAX_IMPORT_BYTES = 40 * 1024 * 1024;

/** 可编辑的草稿镜像：预检结果只是起点，提交以这里为准 */
const form = reactive({
  id: "",
  title: "",
  summary: "",
  category: "",
  tagsText: "",
  date: null as string | null,
  updated: null as string | null,
  mood: "",
  place: "",
  body: "",
  mode: "create" as "create" | "update",
  targetId: "" as string,
  includeUnreferenced: [] as string[]
});

/** 稳定 ID 的 URL 标识规范（方案 §5.2）：只允许小写字母数字连字符，≤80 字符 */
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,79}$/;
const idInvalid = computed(
  () => form.id.trim() !== "" && !ID_PATTERN.test(form.id.trim())
);

const typeLabel = computed(() => (type.value === "notes" ? "笔记" : "随笔"));

/* ------------------------------ 上传 ------------------------------ */

function acceptFile(files: FileList | File[] | null) {
  const picked = files?.[0];
  if (!picked) return;
  if (!/\.(md|markdown|zip)$/i.test(picked.name)) {
    message("只支持 .md 或 .zip", { type: "warning" });
    return;
  }
  if (picked.size > MAX_IMPORT_BYTES) {
    message(`文件超过 ${formatBytes(MAX_IMPORT_BYTES)}，请先精简`, {
      type: "warning"
    });
    return;
  }
  file.value = picked;
}

function onDrop(event: DragEvent) {
  dragging.value = false;
  acceptFile(event.dataTransfer?.files ?? null);
}

function resetUpload() {
  controller.value?.abort();
  controller.value = null;
  file.value = null;
  preview.value = null;
  percent.value = 0;
  uploading.value = false;
  step.value = 1;
}

async function startUpload() {
  if (!file.value) return;
  uploading.value = true;
  percent.value = 0;
  controller.value = new AbortController();
  try {
    const data = await uploadImport(file.value, type.value, {
      signal: controller.value.signal,
      onProgress: value => (percent.value = value)
    });
    preview.value = data;
    percent.value = 100;
    applyPreview(data);
    step.value = 2;
  } catch (error) {
    if ((error as { code?: string })?.code === "ERR_CANCELED") return;
    message((error as Error)?.message ?? "上传失败", { type: "error" });
  } finally {
    uploading.value = false;
  }
}

function applyPreview(data: ImportPreview) {
  const draft = data.draft;
  form.id = draft?.id ?? "";
  form.title = draft?.title ?? "";
  form.summary = draft?.summary ?? "";
  form.category = draft?.category ?? "";
  form.tagsText = (draft?.tags ?? []).join(", ");
  form.date = draft?.date ?? null;
  form.updated = draft?.updated ?? null;
  form.mood = draft?.mood ?? "";
  form.place = draft?.place ?? "";
  form.body = draft?.body ?? "";
  form.includeUnreferenced = [];
  // 只有一个冲突候选时预选“更新”，多个时默认新建，避免误覆盖
  form.mode = data.conflicts.length === 1 ? "update" : "create";
  form.targetId = data.conflicts.length === 1 ? data.conflicts[0].id : "";
}

/* ------------------------------ 选择候选 ------------------------------ */

async function chooseCandidate(path: string) {
  if (!preview.value) return;
  selecting.value = true;
  try {
    const data = await selectImportCandidate(preview.value.importId, path);
    preview.value = data;
    applyPreview(data);
  } catch (error) {
    message((error as Error)?.message ?? "读取这篇失败", { type: "error" });
  } finally {
    selecting.value = false;
  }
}

/* ------------------------------ 提交 ------------------------------ */

const bodyBytes = computed(() => new Blob([form.body]).size);
const bodyTooLarge = computed(
  () => bodyBytes.value > capabilities.maxBodyBytes
);
const bodyChars = computed(() => Array.from(form.body).length);

const missingAssets = computed(
  () => preview.value?.assets.filter(asset => asset.state === "missing") ?? []
);
const ambiguousAssets = computed(
  () => preview.value?.assets.filter(asset => asset.state === "ambiguous") ?? []
);
const unreferencedAssets = computed(
  () =>
    preview.value?.assets.filter(
      asset => asset.state === "unreferenced" && asset.kind !== "other"
    ) ?? []
);

/**
 * 勾选“这个包内文件也一起导入”。
 * 用显式 toggle 而不是 v-model + value：Element Plus 的 checkbox 把 value 定位在
 * string | number | boolean，塞不进这里的 string[] 模型。
 */
function toggleUnreferenced(path: string, checked: boolean | string | number) {
  const on = checked === true;
  const set = new Set(form.includeUnreferenced);
  if (on) set.add(path);
  else set.delete(path);
  form.includeUnreferenced = [...set];
}

const assetStateLabel: Record<ImportAsset["state"], string> = {
  matched: "已匹配",
  unreferenced: "未被引用",
  missing: "包内缺失",
  ambiguous: "多个候选",
  unsupported: "不支持"
};

const canCommit = computed(() => {
  if (!preview.value || committing.value) return false;
  if (!preview.value.committable) return false;
  if (missingAssets.value.length > 0) return false;
  if (ambiguousAssets.value.length > 0) return false;
  if (form.mode === "update" && !form.targetId) return false;
  if (idInvalid.value) return false;
  if (form.mode === "create" && form.id.trim() && form.targetId) return false;
  if (!form.title.trim() || !form.body.trim()) return false;
  return !bodyTooLarge.value;
});

const blockingReason = computed(() => {
  if (!preview.value) return "";
  if (missingAssets.value.length) {
    return `正文引用了 ${missingAssets.value.length} 个包内不存在的文件，请先在本地补齐再重新打包。`;
  }
  if (ambiguousAssets.value.length) {
    return `有 ${ambiguousAssets.value.length} 个资源匹配到多个候选文件，请整理包内目录后重试。`;
  }
  if (!preview.value.committable)
    return "后端判定这次导入暂不可提交，原因见下方提示。";
  if (form.mode === "update" && !form.targetId)
    return "更新模式需要先选择要更新的内容。";
  if (idInvalid.value)
    return "ID 只允许小写字母、数字和连字符（最长 80 字符），且不能以连字符开头。";
  if (form.mode === "create" && form.id.trim() && form.targetId)
    return "这个 ID 在后台里已存在：请改用「更新既有内容」，或清空 ID 新建。";
  if (bodyTooLarge.value) return "正文超出单篇上限，请删减后再提交。";
  return "";
});

async function commit() {
  if (!preview.value || !canCommit.value) return;
  committing.value = true;
  try {
    const data = await commitImport(preview.value.importId, {
      mode: form.mode,
      targetId: form.mode === "update" ? form.targetId : undefined,
      baseRevision:
        form.mode === "update"
          ? preview.value.conflicts.find(item => item.id === form.targetId)
              ?.revision
          : undefined,
      draft: {
        // 保留 frontmatter 里的稳定 ID：留空时后端按标题生成（方案 §6.3）
        id: form.id.trim(),
        title: form.title.trim(),
        summary: form.summary.trim(),
        category: form.category.trim() || null,
        tags: form.tagsText
          .split(/[,，、]/)
          .map(tag => tag.trim())
          .filter(Boolean),
        date: form.date || null,
        updated: form.updated || null,
        // 随笔才有心境/地点
        mood: type.value === "essays" ? form.mood.trim() || null : undefined,
        place: type.value === "essays" ? form.place.trim() || null : undefined,
        body: form.body
      },
      includeUnreferencedPaths: [...form.includeUnreferenced]
    });
    result.value = data;
    preview.value = null;
    step.value = 3;
    message("导入完成", { type: "success" });
  } catch (error) {
    const err = error as { code?: string; message?: string };
    message(
      err?.code === "REVISION_CONFLICT"
        ? "目标内容刚被改过，请重新预检后再提交"
        : (err?.message ?? "提交失败"),
      { type: "error" }
    );
  } finally {
    committing.value = false;
  }
}

async function discard() {
  const id = preview.value?.importId;
  preview.value = null;
  resetUpload();
  if (id) {
    try {
      await cancelImport(id);
    } catch {
      // 释放失败不影响站长：后端会按过期时间清理
    }
  }
}

function openArticle() {
  if (!result.value) return;
  router.push(`/content/${type.value}/${result.value.articleId}`);
}

const warningType = (severity: ImportWarning["severity"]) =>
  severity === "error" ? "danger" : severity === "warning" ? "warning" : "info";

capabilities.ensure();
</script>

<template>
  <div class="ws-page">
    <PageHeader
      eyebrow="Import"
      title="导入 Markdown"
      subtitle="把旧站的文章搬过来：先预检，看清楚了再提交。包只进临时区，确认之前不会写进站点。"
    />

    <el-steps :active="step - 1" simple class="imp-steps">
      <el-step title="上传预检" />
      <el-step title="确认内容" />
      <el-step title="完成" />
    </el-steps>

    <!-- 第一步：上传 -->
    <section v-if="step === 1" class="ws-panel">
      <div class="ws-toolbar">
        <span class="imp-label">导入到</span>
        <el-radio-group v-model="type" size="small">
          <el-radio-button value="notes">笔记</el-radio-button>
          <el-radio-button value="essays">随笔</el-radio-button>
        </el-radio-group>
      </div>

      <div
        class="imp-drop"
        :class="{ 'imp-drop--active': dragging }"
        @dragover.prevent="dragging = true"
        @dragleave.prevent="dragging = false"
        @drop.prevent="onDrop"
      >
        <p class="imp-drop__title">
          {{ file ? file.name : "把 .md 或 .zip 拖到这里" }}
        </p>
        <p class="ws-hint">
          {{
            file
              ? formatBytes(file.size)
              : "ZIP 里可以有多篇 Markdown 与图片资源"
          }}
        </p>
        <div class="imp-drop__ops">
          <label class="el-button el-button--small">
            选择文件
            <input
              type="file"
              accept=".md,.markdown,.zip"
              hidden
              @change="acceptFile(($event.target as HTMLInputElement).files)"
            />
          </label>
          <el-button
            v-if="file"
            size="small"
            :disabled="uploading"
            @click="file = null"
          >
            换一个
          </el-button>
        </div>
        <el-progress
          v-if="uploading"
          :percentage="percent"
          :stroke-width="4"
          class="imp-drop__progress"
        />
      </div>

      <div class="imp-ops">
        <el-button
          type="primary"
          size="small"
          :loading="uploading"
          :disabled="!file"
          @click="startUpload"
        >
          上传并预检
        </el-button>
        <span class="ws-hint">预检不会改动任何既有内容</span>
      </div>
    </section>

    <!-- 第二步：确认 -->
    <template v-else-if="step === 2 && preview">
      <section class="ws-panel">
        <div class="ws-toolbar">
          <p class="imp-title">预检结果 · 导入为{{ typeLabel }}</p>
          <span class="ws-toolbar__spacer" />
          <span class="ws-hint">
            临时文件保留至 {{ formatDateTime(preview.expiresAt) }}
          </span>
        </div>

        <div v-if="preview.unknownFrontmatter.length" class="imp-note">
          这些 frontmatter 字段管理端不认识，不会导入：
          <span class="ws-mono">{{
            preview.unknownFrontmatter.join("、")
          }}</span>
        </div>

        <div v-if="preview.candidates.length > 1" class="imp-candidates">
          <p class="imp-label">包里有多篇，选一篇导入</p>
          <div class="imp-candidates__list">
            <button
              v-for="candidate in preview.candidates"
              :key="candidate.path"
              type="button"
              class="imp-candidate"
              :class="{
                'imp-candidate--active': preview.selectedPath === candidate.path
              }"
              :disabled="selecting"
              @click="chooseCandidate(candidate.path)"
            >
              <span class="imp-candidate__path ws-mono">{{
                candidate.path
              }}</span>
              <span class="ws-hint">
                {{ candidate.title || "（无标题）" }} ·
                {{ formatBytes(candidate.size) }}
              </span>
            </button>
          </div>
          <p v-if="!preview.selectedPath" class="ws-hint">
            选一篇之后才会显示正文与资源映射。
          </p>
        </div>

        <div v-if="preview.draft" class="imp-form">
          <el-form label-position="top" size="small">
            <el-form-item
              label="ID（URL 标识）"
              :error="
                idInvalid
                  ? '只允许小写字母、数字和连字符，且不以连字符开头'
                  : ''
              "
            >
              <el-input
                v-model="form.id"
                placeholder="留空则按标题生成，例如 my-essay-2026"
                maxlength="80"
                show-word-limit
              />
              <p class="ws-hint">
                来自 frontmatter 的稳定
                ID，可修改；留空时按标题自动生成。若后台已有同 ID
                内容，请在下方改用「更新既有内容」。
              </p>
            </el-form-item>
            <el-form-item label="标题" required>
              <el-input v-model="form.title" maxlength="200" show-word-limit />
            </el-form-item>
            <el-form-item
              :label="`摘要（最多 ${capabilities.maxSummaryChars} 字）`"
            >
              <el-input
                v-model="form.summary"
                type="textarea"
                :rows="2"
                :maxlength="capabilities.maxSummaryChars"
                show-word-limit
              />
            </el-form-item>
            <div class="imp-form__row">
              <el-form-item label="归类">
                <el-input v-model="form.category" placeholder="可空" />
              </el-form-item>
              <el-form-item label="写作日期">
                <el-date-picker
                  v-model="form.date"
                  type="date"
                  value-format="YYYY-MM-DD"
                  placeholder="可空"
                  style="width: 100%"
                />
              </el-form-item>
              <el-form-item label="展示更新日期">
                <el-date-picker
                  v-model="form.updated"
                  type="date"
                  value-format="YYYY-MM-DD"
                  placeholder="可空"
                  style="width: 100%"
                />
              </el-form-item>
            </div>
            <el-form-item label="标签（逗号分隔）">
              <el-input
                v-model="form.tagsText"
                placeholder="例如：旧站迁移, 2019"
              />
            </el-form-item>
            <div v-if="type === 'essays'" class="imp-form__row">
              <el-form-item label="心境（最多 20 字）">
                <el-input
                  v-model="form.mood"
                  maxlength="20"
                  show-word-limit
                  placeholder="可空"
                />
              </el-form-item>
              <el-form-item label="地点（最多 100 字）">
                <el-input
                  v-model="form.place"
                  maxlength="100"
                  show-word-limit
                  placeholder="可空"
                />
              </el-form-item>
            </div>
            <el-form-item label="正文（可修正）">
              <el-input v-model="form.body" type="textarea" :rows="10" />
              <p class="ws-hint" :class="{ 'ws-hint--warn': bodyTooLarge }">
                {{ bodyChars }} 字 · {{ formatBytes(bodyBytes) }} / 上限
                {{ formatBytes(capabilities.maxBodyBytes) }}
              </p>
            </el-form-item>
          </el-form>
        </div>
      </section>

      <section v-if="preview.draft" class="ws-panel">
        <div class="ws-toolbar">
          <p class="imp-title">包内资源</p>
          <span class="ws-toolbar__spacer" />
          <span class="ws-hint">
            {{ preview.assets.length }} 个 · 缺失 {{ preview.missingCount }}
          </span>
        </div>

        <el-table
          v-if="preview.assets.length"
          :data="preview.assets"
          size="small"
          row-key="path"
          class="ws-table"
        >
          <el-table-column label="路径" min-width="240">
            <template #default="{ row }">
              <span class="ws-mono imp-path">{{ row.path }}</span>
              <p v-if="row.note" class="ws-hint">{{ row.note }}</p>
              <p v-if="row.candidates?.length" class="ws-hint ws-mono">
                候选：{{ row.candidates.join("、") }}
              </p>
            </template>
          </el-table-column>
          <el-table-column label="类型" width="80">
            <template #default="{ row }">{{ row.kind }}</template>
          </el-table-column>
          <el-table-column label="大小" width="90">
            <template #default="{ row }">{{ formatBytes(row.size) }}</template>
          </el-table-column>
          <el-table-column label="状态" width="110">
            <template #default="{ row }">
              <span
                class="ws-pill"
                :class="
                  row.state === 'matched'
                    ? 'ws-pill--public'
                    : row.state === 'missing' || row.state === 'ambiguous'
                      ? 'ws-pill--danger'
                      : 'ws-pill--mute'
                "
              >
                {{ assetStateLabel[row.state as ImportAsset["state"]] }}
              </span>
            </template>
          </el-table-column>
          <el-table-column label="导入" width="80">
            <template #default="{ row }">
              <el-checkbox
                v-if="row.state === 'unreferenced'"
                :model-value="form.includeUnreferenced.includes(row.path)"
                @change="toggleUnreferenced(row.path, $event)"
              />
              <span v-else-if="row.referenced" class="ws-hint">随正文</span>
              <span v-else class="ws-hint">—</span>
            </template>
          </el-table-column>
        </el-table>
        <p v-else class="ws-hint">这个包里没有可识别的资源文件。</p>

        <p v-if="unreferencedAssets.length" class="ws-hint">
          未勾选的包内文件不会导入，之后想用可以再单独上传。
        </p>
      </section>

      <section v-if="preview.draft" class="ws-panel">
        <div class="ws-toolbar">
          <p class="imp-title">落库方式</p>
        </div>

        <el-radio-group v-model="form.mode" class="imp-mode">
          <el-radio value="create">新建一篇{{ typeLabel }}</el-radio>
          <el-radio value="update" :disabled="!preview.conflicts.length">
            更新既有内容
          </el-radio>
        </el-radio-group>

        <div v-if="form.mode === 'update'" class="imp-conflicts">
          <p class="ws-hint">
            更新会先把原工作稿存成一个版本，之后可从版本历史取回。
          </p>
          <el-radio-group v-model="form.targetId" class="imp-conflicts__list">
            <el-radio
              v-for="conflict in preview.conflicts"
              :key="conflict.id"
              :value="conflict.id"
            >
              {{ conflict.title }} · 更新于
              {{ formatDateTime(conflict.updatedAt) }}
            </el-radio>
          </el-radio-group>
          <p v-if="!preview.conflicts.length" class="ws-hint">
            没有同 ID 的既有内容可更新。
          </p>
        </div>

        <ul v-if="preview.warnings.length" class="imp-warnings">
          <li
            v-for="(warning, index) in preview.warnings"
            :key="`${warning.code}-${index}`"
          >
            <el-tag
              size="small"
              effect="plain"
              :type="warningType(warning.severity)"
            >
              {{ warning.severity }}
            </el-tag>
            <span>{{ warning.message }}</span>
            <span v-if="warning.path" class="ws-hint ws-mono">{{
              warning.path
            }}</span>
          </li>
        </ul>

        <div v-if="blockingReason" class="ws-hint ws-hint--warn imp-blocking">
          {{ blockingReason }}
        </div>

        <div class="imp-ops">
          <el-button size="small" :disabled="committing" @click="discard">
            放弃这次导入
          </el-button>
          <span class="ws-toolbar__spacer" />
          <el-button
            type="primary"
            size="small"
            :loading="committing"
            :disabled="!canCommit"
            @click="commit"
          >
            {{ form.mode === "update" ? "覆盖并保存" : "导入为工作稿" }}
          </el-button>
        </div>
      </section>
    </template>

    <!-- 第三步：完成 -->
    <section v-else-if="step === 3 && result" class="ws-panel imp-done">
      <p class="imp-done__title">导入完成</p>
      <p class="ws-hint">
        《{{ result.title }}》已作为工作稿存下——还没发布，前台看不到。
      </p>
      <ul class="imp-done__stats">
        <li>新建资源 {{ result.createdAssets }} 个</li>
        <li>关联资源 {{ result.linkedAssets }} 个</li>
        <li v-if="result.preservedVersion">
          原工作稿已存为版本
          <span class="ws-mono">{{ result.preservedVersion }}</span>
        </li>
      </ul>
      <div class="imp-ops">
        <el-button size="small" @click="((result = null), resetUpload())">
          再导入一篇
        </el-button>
        <el-button type="primary" size="small" @click="openArticle">
          去打开发表
        </el-button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.imp-steps {
  margin-bottom: 16px;
}

.imp-label {
  font-size: 12px;
  color: var(--ash);
  letter-spacing: 0.06em;
}

.imp-title {
  margin: 0;
  font-family: var(--font-display);
  font-size: 15px;
  color: var(--bone);
}

.imp-drop {
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: center;
  padding: 36px 20px;
  background: rgb(239 232 218 / 2%);
  border: 1px dashed var(--line);
  border-radius: 12px;
  transition:
    border-color 0.2s ease,
    background 0.2s ease;
}

.imp-drop--active {
  background: rgb(233 189 94 / 6%);
  border-color: var(--sol);
}

.imp-drop__title {
  margin: 0;
  font-size: 14px;
  color: var(--bone);
  text-align: center;
  word-break: break-all;
}

.imp-drop__ops {
  display: flex;
  gap: 8px;
  margin-top: 6px;
}

.imp-drop__progress {
  width: 100%;
  max-width: 320px;
  margin-top: 8px;
}

.imp-ops {
  display: flex;
  gap: 10px;
  align-items: center;
  margin-top: 14px;
}

.imp-note {
  padding: 8px 12px;
  margin-bottom: 12px;
  font-size: 12px;
  color: var(--bone);
  word-break: break-all;
  background: rgb(239 232 218 / 3%);
  border: 1px solid var(--line);
  border-left: 2px solid var(--glacier);
  border-radius: 6px;
}

.imp-candidates {
  margin-bottom: 14px;
}

.imp-candidates__list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 8px;
}

.imp-candidate {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 10px;
  color: inherit;
  text-align: left;
  cursor: pointer;
  background: rgb(239 232 218 / 2%);
  border: 1px solid var(--line);
  border-radius: 8px;
}

.imp-candidate--active {
  background: rgb(233 189 94 / 7%);
  border-color: var(--sol);
}

.imp-candidate__path {
  font-size: 12px;
  color: var(--bone);
  word-break: break-all;
}

.imp-form {
  margin-top: 8px;
}

.imp-form__row {
  display: flex;
  gap: 12px;
}

.imp-form__row > * {
  flex: 1 1 0;
  min-width: 0;
}

.imp-path {
  font-size: 12px;
  word-break: break-all;
}

.imp-mode {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.imp-conflicts {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  margin-top: 10px;
  border: 1px solid var(--line);
  border-radius: 8px;
}

.imp-conflicts__list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.imp-warnings {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 0;
  margin: 12px 0 0;
  font-size: 12px;
  color: var(--bone);
  list-style: none;
}

.imp-warnings li {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: baseline;
}

.imp-blocking {
  margin-top: 12px;
}

.imp-done {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.imp-done__title {
  margin: 0;
  font-family: var(--font-display);
  font-size: 18px;
  color: var(--sol);
}

.imp-done__stats {
  padding-left: 18px;
  margin: 0;
  font-size: 12px;
  line-height: 1.9;
  color: var(--bone);
}

@media (width <= 900px) {
  .imp-form__row {
    flex-direction: column;
    gap: 0;
  }
}
</style>
