<script setup lang="ts">
/** 页面抬头：小标签 + 标题 + 说明 + 右侧操作区 */
defineProps<{
  eyebrow?: string;
  title: string;
  description?: string;
}>();
</script>

<template>
  <header class="ws-head">
    <div class="min-w-0">
      <p v-if="eyebrow" class="ws-eyebrow">{{ eyebrow }}</p>
      <h1 class="ws-title">{{ title }}</h1>
      <p v-if="description" class="ws-sub">{{ description }}</p>
      <slot name="under" />
    </div>
    <div v-if="$slots.actions" class="ws-actions">
      <slot name="actions" />
    </div>
  </header>
</template>
