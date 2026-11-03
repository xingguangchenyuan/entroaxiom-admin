<script setup lang="ts">
import { computed } from "vue";

/**
 * 版本冲突（HTTP 409 / REVISION_CONFLICT）。
 *
 * 出现原因通常是：另一个标签页保存过、或者你离开前那次自动保存已经落到服务端。
 * 关键是把三个选择摆清楚，**绝不自动覆盖**：
 *   - 用我的覆盖：以线上最新版本号为基准，把本地内容整体写回（旧的线上工作稿会进历史）；
 *   - 放弃我的：丢掉本地，重新载入线上工作稿；
 *   - 先看看差异：交给页面去打开版本对比，不做不可逆的动作。
 */
const props = withDefaults(
  defineProps<{
    modelValue: boolean;
    subject?: string;
    serverRevision?: number | null;
    serverUpdatedAt?: string | null;
    localTitle?: string;
    serverTitle?: string;
    saving?: boolean;
  }>(),
  {
    subject: "这份内容",
    serverRevision: null,
    serverUpdatedAt: null,
    localTitle: "",
    serverTitle: "",
    saving: false
  }
);

const emit = defineEmits<{
  "update:modelValue": [boolean];
  overwrite: [];
  discard: [];
  compare: [];
}>();

const open = computed({
  get: () => props.modelValue,
  set: (v: boolean) => emit("update:modelValue", v)
});

const titleChanged = computed(
  () =>
    !!props.localTitle &&
    !!props.serverTitle &&
    props.localTitle !== props.serverTitle
);
</script>

<template>
  <el-dialog
    v-model="open"
    title="保存冲突"
    width="min(92vw, 560px)"
    append-to-body
  >
    <div class="conflict">
      <p class="ws-sub" style="margin-top: 0">
        {{ subject }}在服务端已经有更新的版本，你这次的修改是基于旧版本做的。
        直接覆盖会让那份更新消失，所以请你决定怎么处理。
      </p>

      <dl class="conflict__facts">
        <div>
          <dt class="ws-meta__label">线上版本号</dt>
          <dd class="ws-mono">{{ serverRevision ?? "—" }}</dd>
        </div>
        <div>
          <dt class="ws-meta__label">线上最后保存</dt>
          <dd class="ws-mono">{{ serverUpdatedAt ?? "—" }}</dd>
        </div>
        <div v-if="titleChanged">
          <dt class="ws-meta__label">标题差异</dt>
          <dd>
            <span class="conflict__mine">{{ localTitle }}</span>
            <span class="ws-hint"> ↔ </span>
            <span class="conflict__theirs">{{ serverTitle }}</span>
          </dd>
        </div>
      </dl>

      <p class="ws-hint">
        建议顺序：先「看看差异」，确认哪些是在线上改的，再决定覆盖还是放弃。
        如果你确定线上那份不重要，才选择覆盖。
      </p>
    </div>

    <template #footer>
      <el-button @click="open = false">留在这里</el-button>
      <el-button @click="emit('compare')">看看差异</el-button>
      <el-button :disabled="saving" @click="emit('discard')"
        >放弃我的，载入线上</el-button
      >
      <el-button type="primary" :loading="saving" @click="emit('overwrite')">
        用我的覆盖
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.conflict {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.conflict__facts {
  display: grid;
  gap: 8px;
  padding: 12px 14px;
  margin: 0;
  background: rgb(239 232 218 / 3%);
  border: 1px solid var(--line);
  border-radius: 12px;
}

.conflict__facts div {
  display: flex;
  gap: 12px;
  align-items: baseline;
}

.conflict__facts dt {
  min-width: 96px;
  font-size: 12px;
  color: var(--ash);
}

.conflict__facts dd {
  margin: 0;
  font-size: 12.5px;
  color: var(--bone-2);
}

.conflict__mine {
  color: var(--sol-hi);
}

.conflict__theirs {
  color: var(--glacier);
}
</style>
