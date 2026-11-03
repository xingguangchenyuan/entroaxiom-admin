<script setup lang="ts">
import { computed, toRef } from "vue";
import { useAuthMedia } from "@/composables/useAuthMedia";

/**
 * 缩略图／封面。
 *
 * 两种来源：
 *  - `publicSrc`：公开文件，直接给 <img> 用（<img> 不会带 Authorization 头，公开地址才安全）；
 *  - `fileId`：私密文件，走带鉴权的 Blob → 对象 URL。
 * 绝不允许把需要鉴权的地址塞进 `src`，那样线上会 401，还容易误以为“图片坏了”。
 */
const props = withDefaults(
  defineProps<{
    fileId?: string | null;
    src?: string | null;
    alt?: string;
    /** 宽高比，例如 "4 / 3"；给 "auto" 表示不固定 */
    aspect?: string;
    fit?: "cover" | "contain";
  }>(),
  { fileId: null, src: null, alt: "", aspect: "4 / 3", fit: "cover" }
);

const media = useAuthMedia(toRef(props, "fileId"));

const resolvedSrc = computed(() => {
  if (props.fileId) return media.src.value;
  return props.src || null;
});

const state = computed(() => {
  if (!props.fileId) return props.src ? "ready" : "idle";
  return media.state.value;
});

const style = computed(() => ({
  aspectRatio: props.aspect === "auto" ? undefined : props.aspect
}));
</script>

<template>
  <div class="ws-thumb relative" :style="style">
    <img
      v-if="resolvedSrc && state !== 'error'"
      :src="resolvedSrc"
      :alt="alt"
      :style="{ objectFit: fit }"
      loading="lazy"
      decoding="async"
    />
    <div v-else-if="state === 'loading'" class="asset-ph ws-mono">读取中</div>
    <div v-else-if="state === 'error'" class="asset-ph">
      <span class="ws-mono">无法读取</span>
      <el-button link size="small" @click.stop="media.retry()">重试</el-button>
    </div>
    <div v-else class="asset-ph ws-mono">无封面</div>
  </div>
</template>

<style scoped>
.asset-ph {
  display: flex;
  flex-direction: column;
  gap: 4px;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  min-height: 64px;
  font-size: 11px;
  color: var(--ash);
  letter-spacing: 0.08em;
}
</style>
