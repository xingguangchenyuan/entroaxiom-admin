<script setup lang="ts">
import { computed } from "vue";

/**
 * 状态标签。
 * 颜色之外一定带文字：色觉差异下也能区分“已发布 / 草稿”，
 * 并且同一个词在不同语境下的含义不同（status 是消费状态、publicationStatus 是发布状态），
 * 所以按 `kind` 分开映射，避免把“想看”显示成“草稿”。
 */
const props = withDefaults(
  defineProps<{
    value: string | null | undefined;
    kind?: "publication" | "visibility" | "guestbook" | "consume" | "plain";
    label?: string;
  }>(),
  { kind: "plain", label: "" }
);

const MAP: Record<string, { label: string; cls: string }> = {
  // 发布状态
  draft: { label: "草稿", cls: "ws-pill--draft" },
  published: { label: "已发布", cls: "ws-pill--published" },
  // 可见范围
  public: { label: "公开", cls: "ws-pill--public" },
  private: { label: "私密", cls: "ws-pill--private" },
  // 留言
  approved: { label: "已公开", cls: "ws-pill--published" },
  hidden: { label: "已隐藏", cls: "ws-pill--warn" },
  blocked: { label: "已拦截", cls: "ws-pill--danger" },
  pending: { label: "待复核", cls: "ws-pill--warn" },
  // 消费状态
  done: { label: "已完成", cls: "ws-pill--published" },
  doing: { label: "进行中", cls: "ws-pill--warn" },
  want: { label: "想读 / 想看", cls: "ws-pill--draft" }
};

const resolved = computed(() => {
  const raw = String(props.value ?? "").trim();
  if (!raw) return { label: "—", cls: "ws-pill--mute" };
  const hit = MAP[raw];
  if (hit) return hit;
  return { label: props.label || raw, cls: "ws-pill--mute" };
});

const text = computed(() => props.label || resolved.value.label);
</script>

<template>
  <span class="ws-pill" :class="resolved.cls">{{ text }}</span>
</template>
