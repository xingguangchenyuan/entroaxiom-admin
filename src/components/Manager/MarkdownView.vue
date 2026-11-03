<script setup lang="ts">
import { ref, watch, nextTick, computed, onBeforeUnmount } from "vue";
import "katex/dist/katex.min.css";
import { message } from "@/utils/message";
import { resolveFileUrl, fetchFileBlob, saveBlob } from "@/utils/media";
import {
  renderMarkdown,
  extractHeadings,
  type HeadingItem
} from "@/utils/markdown";

/**
 * 正文预览（只读）。
 *
 * 与前台共用同一套 remark/rehype 管线（见 utils/markdown），所以这里的排版就是线上排版，
 * 不会出现“后台预览好好的、发出去全乱”的情况。
 *
 * 三件必须在这里做的事：
 *  1. `asset:<fileId>` 的私密图片要换成带鉴权的对象 URL（<img> 不会自己带 token）；
 *  2. 正文里的链接不能把后台整页带走：外链新窗口、页内锚点本页滚动、站内链接提示到线上站点；
 *  3. 表格包一层横向滚动容器，宽表不会撑破布局。
 */
const props = withDefaults(
  defineProps<{
    body?: string;
    /** 输入防抖，编辑时不要每次按键都跑一遍管线 */
    debounce?: number;
    zoomable?: boolean;
  }>(),
  { body: "", debounce: 160, zoomable: true }
);

const emit = defineEmits<{ headings: [HeadingItem[]] }>();

/** 线上站点地址：站内链接在预览里跳到真实站点，而不是留在后台 */
const SITE_BASE = (import.meta.env.VITE_SITE_URL || "").replace(/\/$/, "");

const root = ref<HTMLElement | null>(null);
const html = ref("");
const zoom = ref<{ src: string; alt: string } | null>(null);

/** el-dialog 只认布尔值，这里做一层转接，避免把 false 写进 zoom */
const zoomOpen = computed({
  get: () => !!zoom.value,
  set: (visible: boolean) => {
    if (!visible) zoom.value = null;
  }
});

let seq = 0;
let timer: ReturnType<typeof setTimeout> | undefined;

async function render() {
  const current = ++seq;
  try {
    const out = await renderMarkdown(props.body ?? "");
    if (current !== seq) return;
    html.value = out;
    await nextTick();
    if (current !== seq) return;
    decorate();
    emit("headings", extractHeadings(out));
  } catch (error) {
    if (current !== seq) return;
    // 渲染失败通常是极端输入，不该白屏：给出可读的兜底
    html.value = "";
    message((error as Error)?.message ?? "预览渲染失败", { type: "error" });
  }
}

/** 渲染后处理：宽表包滚动容器、外链加 rel、私密图片换成对象 URL */
function decorate() {
  const host = root.value;
  if (!host) return;
  const current = seq;

  host.querySelectorAll("table").forEach(table => {
    const parent = table.parentElement;
    if (parent?.classList.contains("md-table-wrap")) return;
    const wrap = document.createElement("div");
    wrap.className = "md-table-wrap";
    wrap.tabIndex = 0;
    wrap.setAttribute("role", "region");
    wrap.setAttribute("aria-label", "表格，可横向滚动");
    table.replaceWith(wrap);
    wrap.appendChild(table);
  });

  host.querySelectorAll("a[href]").forEach(link => {
    const href = link.getAttribute("href") ?? "";
    if (/^https?:/i.test(href)) {
      link.setAttribute("target", "_blank");
      link.setAttribute("rel", "noopener noreferrer");
    }
  });

  host.querySelectorAll<HTMLImageElement>("img[data-asset-id]").forEach(img => {
    const fileId = img.dataset.assetId;
    if (!fileId) return;
    img.classList.add("md-img--pending");
    resolveFileUrl(fileId)
      .then(url => {
        if (current !== seq) return;
        img.src = url;
        img.classList.remove("md-img--pending");
      })
      .catch((error: Error) => {
        if (current !== seq) return;
        img.classList.remove("md-img--pending");
        img.classList.add("md-img--failed");
        img.removeAttribute("src");
        img.alt = error?.message || "私密图片读取失败";
      });
  });

  // 附件下载链接：`[名字](asset:<fileId>)` 渲染成带 data-asset-id 的 <a>，
  // 标记成可下载附件，点击时由 onRootClick 走鉴权下载，而不是当站内链接跳走。
  host.querySelectorAll<HTMLAnchorElement>("a[data-asset-id]").forEach(link => {
    link.classList.add("md-asset-link");
    link.setAttribute("title", "下载附件");
  });
}

watch(
  () => props.body,
  () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(render, props.debounce);
  },
  { immediate: true }
);

onBeforeUnmount(() => {
  if (timer) clearTimeout(timer);
  seq += 1;
});

function scrollToAnchor(id: string) {
  const host = root.value;
  if (!host) return;
  const target = host.querySelector(`[id="${CSS.escape(id)}"]`);
  target?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function onRootClick(event: MouseEvent) {
  const el = event.target as HTMLElement | null;
  if (!el) return;

  const img = el.closest("img");
  if (img && props.zoomable && img.getAttribute("src")) {
    zoom.value = { src: img.getAttribute("src") as string, alt: img.alt ?? "" };
    return;
  }

  const link = el.closest("a");
  if (!link) return;

  // 附件下载链接优先：带鉴权的 fetch → 落盘，链接本身是 `asset:` 协议，不会导航
  const assetId = link.dataset.assetId;
  if (assetId) {
    event.preventDefault();
    fetchFileBlob(assetId)
      .then(({ blob, filename }) => {
        saveBlob(blob, filename || assetId);
      })
      .catch((error: Error) => {
        message(error?.message ?? "附件下载失败", { type: "error" });
      });
    return;
  }

  const href = link.getAttribute("href") ?? "";
  if (!href) return;
  if (href.startsWith("#")) {
    event.preventDefault();
    scrollToAnchor(href.slice(1));
    return;
  }
  if (/^https?:/i.test(href)) return;
  // 站内相对链接：预览里不接管路由，指向线上站点
  event.preventDefault();
  if (SITE_BASE) {
    window.open(`${SITE_BASE}${href}`, "_blank", "noopener");
  } else {
    message(`这是站内链接：${href}（只在线上站点可跳转）`, { type: "info" });
  }
}
</script>

<template>
  <div ref="root" class="prose" @click="onRootClick" v-html="html" />

  <el-dialog
    v-model="zoomOpen"
    :title="zoom?.alt || '查看图片'"
    width="min(92vw, 1080px)"
    align-center
    append-to-body
    class="md-zoom"
  >
    <img v-if="zoom" :src="zoom.src" :alt="zoom.alt" class="md-zoom__img" />
  </el-dialog>
</template>

<style scoped>
.prose {
  font-family: var(--font-sans);
  font-size: 15px;
  line-height: 1.85;
  color: var(--bone-2);
  overflow-wrap: break-word;
}

.prose :deep(h1),
.prose :deep(h2),
.prose :deep(h3),
.prose :deep(h4) {
  font-family: var(--font-display);
  font-weight: 400;
  line-height: 1.35;
  color: var(--bone);
  letter-spacing: 0.02em;
}

.prose :deep(h1) {
  margin: 1.6em 0 0.7em;
  font-size: 26px;
}

.prose :deep(h2) {
  padding-top: 0.7em;
  margin: 2em 0 0.8em;
  font-size: 21px;
  border-top: 1px solid var(--line);
}

.prose :deep(h3) {
  margin: 1.6em 0 0.6em;
  font-size: 17px;
}

.prose :deep(h4) {
  margin: 1.4em 0 0.5em;
  font-size: 15px;
  color: var(--bone-2);
}

.prose :deep(p) {
  margin: 0 0 1.05em;
}

.prose :deep(a) {
  color: var(--sol-hi);
  text-decoration: underline;
  text-decoration-color: color-mix(in srgb, var(--sol) 45%, transparent);
  text-underline-offset: 0.22em;
}

.prose :deep(a:hover) {
  color: var(--sol);
}

/* 附件下载链接：`[名字](asset:<fileId>)`，点击触发鉴权下载 */
.prose :deep(a.md-asset-link) {
  display: inline-flex;
  gap: 0.35em;
  align-items: center;
  cursor: pointer;
}

.prose :deep(a.md-asset-link::before) {
  font-size: 0.85em;
  content: "⬇";
  opacity: 0.75;
}

.prose :deep(strong) {
  font-weight: 600;
  color: var(--bone);
}

.prose :deep(em) {
  color: var(--bone);
}

.prose :deep(ul),
.prose :deep(ol) {
  padding-left: 1.4em;
  margin: 0 0 1.05em;
}

.prose :deep(li) {
  margin: 0.25em 0;
}

.prose :deep(li::marker) {
  color: var(--sol);
}

.prose :deep(blockquote) {
  padding: 0.2em 0 0.2em 1em;
  margin: 1.2em 0;
  color: var(--dust);
  border-left: 2px solid color-mix(in srgb, var(--sol) 55%, transparent);
}

.prose :deep(blockquote p:last-child) {
  margin-bottom: 0;
}

.prose :deep(code) {
  padding: 0.12em 0.4em;
  font-family: var(--font-mono);
  font-size: 0.88em;
  color: var(--glacier);
  background: rgb(159 214 224 / 8%);
  border-radius: 5px;
}

.prose :deep(pre) {
  padding: 14px 16px;
  margin: 1.2em 0;
  overflow: auto;
  background: rgb(3 4 10 / 70%);
  border: 1px solid var(--line);
  border-radius: 12px;
}

.prose :deep(pre code) {
  padding: 0;
  font-size: 12.5px;
  line-height: 1.75;
  color: var(--bone-2);
  background: none;
}

.prose :deep(hr) {
  margin: 2em 0;
  border: 0;
  border-top: 1px solid var(--line);
}

.prose :deep(img) {
  max-width: 100%;
  height: auto;
  cursor: zoom-in;
  border: 1px solid var(--line);
  border-radius: 10px;
}

.prose :deep(img.md-img--pending) {
  min-width: 120px;
  min-height: 80px;
  background: rgb(239 232 218 / 5%);
}

.prose :deep(img.md-img--failed) {
  min-height: 64px;
  padding: 18px;
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--ember);
  cursor: default;
  background: rgb(239 132 86 / 8%);
  border-style: dashed;
}

.prose :deep(.md-table-wrap) {
  margin: 1.2em 0;
  overflow-x: auto;
  border: 1px solid var(--line);
  border-radius: 12px;
}

.prose :deep(table) {
  width: 100%;
  font-size: 13.5px;
  border-collapse: collapse;
}

.prose :deep(th),
.prose :deep(td) {
  padding: 9px 12px;
  text-align: left;
  border-bottom: 1px solid var(--line);
}

.prose :deep(th) {
  font-family: var(--font-mono);
  font-size: 11.5px;
  font-weight: 600;
  color: var(--bone);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  background: rgb(239 232 218 / 4%);
}

.prose :deep(tr:last-child td) {
  border-bottom: 0;
}

.prose :deep(.katex-display) {
  padding: 6px 0;
  overflow: auto hidden;
}

.prose :deep(input[type="checkbox"]) {
  margin-right: 6px;
  accent-color: var(--sol);
}

.prose :deep(.footnotes) {
  margin-top: 2em;
  font-size: 13px;
  color: var(--dust);
}

.md-zoom__img {
  display: block;
  max-width: 100%;
  max-height: 78vh;
  margin: 0 auto;
  border-radius: 10px;
}
</style>
