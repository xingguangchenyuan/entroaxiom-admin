<script setup lang="ts">
/**
 * 空状态。刻意区分两种空：
 *  - 真的还没有内容（给出建立的入口）；
 *  - 筛选后为空（给出清空筛选的出口），不要让站长以为数据丢了。
 */
withDefaults(
  defineProps<{
    title: string;
    description?: string;
    glyph?: string;
    actionText?: string;
  }>(),
  { description: "", glyph: "○", actionText: "" }
);

defineEmits<{ action: [] }>();
</script>

<template>
  <div class="ws-empty">
    <div class="ws-empty__glyph" aria-hidden="true">{{ glyph }}</div>
    <p class="ws-empty__title">{{ title }}</p>
    <p v-if="description" class="ws-empty__desc">{{ description }}</p>
    <slot />
    <el-button v-if="actionText" size="small" @click="$emit('action')">
      {{ actionText }}
    </el-button>
  </div>
</template>
