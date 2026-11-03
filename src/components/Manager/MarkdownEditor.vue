<script setup lang="ts">
import { computed, nextTick, ref } from "vue";
import type { FileItem } from "@/api/types";
import { countChars, countParagraphs } from "@/utils/markdown";
import AssetPickerDialog from "./AssetPickerDialog.vue";

/**
 * Markdown 编辑区。
 *
 * 这里刻意用原生 textarea 而不是富文本编辑器：
 * 正文的真相是 Markdown（前台按 Markdown 渲染、导入导出也是 Markdown），
 * 所见即所得的富文本会在“粘贴自 Word / 导入 .md / 手写公式”这三种场景下悄悄改写内容。
 *
 * 工具条只做最小的文本插入，不接管光标之外的任何东西；其余交给预览。
 */
const props = withDefaults(
  defineProps<{
    modelValue: string;
    placeholder?: string;
    disabled?: boolean;
    readonlyHint?: string;
  }>(),
  {
    placeholder: "从这里开始写……支持 Markdown、$公式$、表格与任务列表。",
    disabled: false,
    readonlyHint: ""
  }
);

const emit = defineEmits<{
  "update:modelValue": [string];
  /** Ctrl/Cmd + S */
  save: [];
}>();

const textarea = ref<HTMLTextAreaElement | null>(null);
const pickerOpen = ref(false);
const attachmentOpen = ref(false);

const value = computed({
  get: () => props.modelValue ?? "",
  set: (next: string) => emit("update:modelValue", next)
});

const chars = computed(() => countChars(value.value));
const blocks = computed(() => countParagraphs(value.value));

function focus() {
  textarea.value?.focus();
}

/** 用选区包起来：没有选中内容时插入占位词并选中它，方便直接替换 */
function wrap(before: string, after = "", placeholder = "") {
  const el = textarea.value;
  if (!el || props.disabled) return;
  const source = value.value;
  const start = el.selectionStart ?? source.length;
  const end = el.selectionEnd ?? source.length;
  const picked = source.slice(start, end) || placeholder;
  const next =
    source.slice(0, start) + before + picked + after + source.slice(end);
  value.value = next;
  nextTick(() => {
    el.focus();
    const from = start + before.length;
    el.setSelectionRange(from, from + picked.length);
  });
}

/** 在每一行行首加前缀（引用、列表、标题都用它） */
function prefixLines(prefix: string, placeholder = "") {
  const el = textarea.value;
  if (!el || props.disabled) return;
  const source = value.value;
  const start = el.selectionStart ?? source.length;
  const end = el.selectionEnd ?? source.length;
  const lineStart = source.lastIndexOf("\n", start - 1) + 1;
  const lineEnd = source.indexOf("\n", end);
  const segmentEnd = lineEnd === -1 ? source.length : lineEnd;
  const segment = source.slice(lineStart, segmentEnd) || placeholder;
  const next =
    source.slice(0, lineStart) +
    segment
      .split("\n")
      .map(line => `${prefix}${line}`)
      .join("\n") +
    source.slice(segmentEnd);
  value.value = next;
  nextTick(() => {
    el.focus();
    el.setSelectionRange(lineStart + prefix.length, segmentEnd + prefix.length);
  });
}

function insertBlock(text: string) {
  const el = textarea.value;
  if (!el || props.disabled) return;
  const source = value.value;
  const start = el.selectionStart ?? source.length;
  const needsLeading = start > 0 && !source.slice(0, start).endsWith("\n\n");
  const prefix = start === 0 ? "" : needsLeading ? "\n\n" : "";
  const next = source.slice(0, start) + prefix + text + source.slice(start);
  value.value = next;
  nextTick(() => {
    el.focus();
    const pos = start + prefix.length + text.length;
    el.setSelectionRange(pos, pos);
  });
}

function onAssetPicked(file: FileItem) {
  // 统一写稳定引用：发布时后端才能判断这是私密资源并给出处理选项
  insertBlock(`![${file.name}](asset:${file.id})`);
}

function onAttachmentPicked(file: FileItem) {
  // 附件用“链接语法”而不是图片语法：预览/线上渲染成可下载的附件链接
  insertBlock(`[${file.name}](asset:${file.id})`);
}

function onKeydown(event: KeyboardEvent) {
  const meta = event.metaKey || event.ctrlKey;
  if (meta && event.key.toLowerCase() === "s") {
    event.preventDefault();
    emit("save");
    return;
  }
  if (meta && event.key.toLowerCase() === "b") {
    event.preventDefault();
    wrap("**", "**", "加粗文字");
    return;
  }
  if (meta && event.key.toLowerCase() === "i") {
    event.preventDefault();
    wrap("*", "*", "斜体文字");
    return;
  }
  if (meta && event.key.toLowerCase() === "k") {
    event.preventDefault();
    wrap("[", "](https://)", "链接文字");
    return;
  }
  if (event.key === "Tab") {
    // 列表里按 Tab 缩进一个层级；不让焦点跳出编辑区
    event.preventDefault();
    insertBlock("  ");
  }
}

const TABLE_SNIPPET = "| 列一 | 列二 |\n| --- | --- |\n| 内容 | 内容 |\n";

defineExpose({ focus });
</script>

<template>
  <div class="editor">
    <div class="ws-editor__bar">
      <el-button-group>
        <el-button
          size="small"
          title="加粗 Ctrl+B"
          @click="wrap('**', '**', '加粗文字')"
          >B</el-button
        >
        <el-button
          size="small"
          title="斜体 Ctrl+I"
          @click="wrap('*', '*', '斜体文字')"
        >
          <em>I</em>
        </el-button>
        <el-button size="small" title="行内代码" @click="wrap('`', '`', 'code')"
          >code</el-button
        >
        <el-button
          size="small"
          title="链接 Ctrl+K"
          @click="wrap('[', '](https://)', '链接文字')"
        >
          链接
        </el-button>
      </el-button-group>

      <el-button-group>
        <el-button
          size="small"
          title="二级标题"
          @click="prefixLines('## ', '小节标题')"
          >H2</el-button
        >
        <el-button
          size="small"
          title="三级标题"
          @click="prefixLines('### ', '小节标题')"
          >H3</el-button
        >
        <el-button size="small" title="引用" @click="prefixLines('> ', '引用')"
          >引用</el-button
        >
        <el-button
          size="small"
          title="无序列表"
          @click="prefixLines('- ', '条目')"
          >列表</el-button
        >
      </el-button-group>

      <el-button-group>
        <el-button size="small" title="行内公式" @click="wrap('$', '$', 'x^2')"
          >$x$</el-button
        >
        <el-button
          size="small"
          title="块级公式"
          @click="insertBlock('$$\nE = mc^2\n$$')"
          >$$</el-button
        >
        <el-button size="small" title="表格" @click="insertBlock(TABLE_SNIPPET)"
          >表格</el-button
        >
        <el-button
          size="small"
          title="插入文件库图片资源"
          @click="pickerOpen = true"
          >插图</el-button
        >
        <el-button
          size="small"
          title="插入附件下载链接（PDF、ZIP、文档等）"
          @click="attachmentOpen = true"
          >附件</el-button
        >
      </el-button-group>

      <span class="ws-toolbar__spacer" />
      <span class="ws-meta">
        <span class="ws-meta__item">
          <span class="ws-meta__label">字数</span>
          <span class="ws-meta__value">{{ chars }}</span>
        </span>
        <span class="ws-meta__item">
          <span class="ws-meta__label">段落</span>
          <span class="ws-meta__value">{{ blocks }}</span>
        </span>
      </span>
    </div>

    <textarea
      ref="textarea"
      v-model="value"
      class="ws-editor__textarea editor__area"
      :placeholder="placeholder"
      :disabled="disabled"
      spellcheck="false"
      @keydown="onKeydown"
    />

    <p v-if="readonlyHint" class="ws-hint" style="padding: 0 14px 12px">
      {{ readonlyHint }}
    </p>

    <AssetPickerDialog
      v-model="pickerOpen"
      :kinds="['image']"
      title="插入图片"
      @pick="onAssetPicked"
    />

    <AssetPickerDialog
      v-model="attachmentOpen"
      :kinds="['pdf', 'archive', 'doc']"
      title="插入附件（下载链接）"
      @pick="onAttachmentPicked"
    />
  </div>
</template>

<style scoped>
.editor {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
}

.editor__area {
  flex: 1;
  width: 100%;
  min-height: 460px;
  padding: 16px 18px;
  font-family: var(--font-mono);
  font-size: 13.5px;
  line-height: 1.9;
  color: var(--bone);
  tab-size: 2;
  resize: none;
  outline: none;
  background: transparent;
  border: 0;
}

.editor__area::placeholder {
  color: var(--ash);
}

.editor__area:disabled {
  color: var(--dust);
  cursor: not-allowed;
}
</style>
