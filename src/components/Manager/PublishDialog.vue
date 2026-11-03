<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { message } from "@/utils/message";
import type {
  AssetDecisionOption,
  PublicationCheckResult,
  Visibility
} from "@/api/types";

/**
 * 发布确认面板。
 *
 * 设计原则：**前端不自己判断能不能发布**。
 * 是否可发布、哪些私密资源需要决策、有没有阻塞性问题，全部由后端预检返回；
 * 这里只负责把结果讲清楚、把站长的选择收集起来。
 *
 * `checkId` 是“站长看过这份预检”的凭据：预检过期或资源变化后必须重新检查，
 * 否则会出现“检查时还没问题，发布时图片权限已经变了”的静默错误。
 */
const props = withDefaults(
  defineProps<{
    modelValue: boolean;
    /** 预检请求 */
    check: (payload: {
      action: "publish" | "visibility";
      baseRevision: number;
      targetVisibility?: Visibility | null;
    }) => Promise<PublicationCheckResult>;
    /** 真正提交发布 */
    publish: (payload: {
      checkId: string;
      baseRevision: number;
      targetVisibility?: Visibility | null;
      assetDecisions: Array<{ fileId: string; decision: AssetDecisionOption }>;
    }) => Promise<unknown>;
    baseRevision: number;
    action?: "publish" | "visibility";
    targetVisibility?: Visibility | null;
    /** 例如“这篇随笔”“这本书记录” */
    subject?: string;
    /** 预检前的额外提醒，例如“工作稿与线上一致，发布不会产生新快照” */
    notice?: string;
  }>(),
  {
    action: "publish",
    targetVisibility: null,
    subject: "这篇内容",
    notice: ""
  }
);

const emit = defineEmits<{
  "update:modelValue": [boolean];
  published: [unknown];
  /** 预检凭据已作废（revision 被别人改过），父组件需刷新并重新打开面板 */
  stale: [action: "publish" | "visibility"];
}>();

const open = computed({
  get: () => props.modelValue,
  set: (v: boolean) => emit("update:modelValue", v)
});

const loading = ref(false);
const submitting = ref(false);
const result = ref<PublicationCheckResult | null>(null);
const errorText = ref("");
const decisions = ref<Record<string, AssetDecisionOption>>({});

// 只有"发布"才会生成新的公开内容、才需要处理私密资源；
// 只改可见范围时后端不会复制/公开任何文件，因此不显示资源决策区。
const isPublish = computed(() => props.action === "publish");

const title = computed(() =>
  props.action === "visibility" ? "确认可见范围变更" : "确认发布"
);
const ctaText = computed(() =>
  props.action === "visibility" ? "应用可见范围" : "确认发布"
);

const ACTION_LABEL: Record<AssetDecisionOption, string> = {
  "keep-private": "保持私密（正文里会显示不出来，仅你自己可见）",
  "copy-public": "复制为公开副本（原图仍保持私密，推荐）",
  "make-public": "把原文件改为公开"
};

const blocking = computed(() =>
  (result.value?.checks ?? []).filter(item => item.severity === "error")
);
const warnings = computed(() =>
  (result.value?.checks ?? []).filter(item => item.severity === "warning")
);
const infos = computed(() =>
  (result.value?.checks ?? []).filter(item => item.severity === "info")
);

const pendingDecisions = computed(() =>
  isPublish.value
    ? (result.value?.assetDecisions ?? []).filter(
        item => !decisions.value[item.fileId]
      )
    : []
);

const canSubmit = computed(
  () =>
    !!result.value &&
    result.value.canProceed &&
    blocking.value.length === 0 &&
    pendingDecisions.value.length === 0 &&
    !loading.value
);

async function run() {
  loading.value = true;
  errorText.value = "";
  result.value = null;
  decisions.value = {};
  try {
    const data = await props.check({
      action: props.action,
      baseRevision: props.baseRevision,
      targetVisibility: props.targetVisibility
    });
    result.value = data;
    // 一律不预填：发布时只有站长对每个私密资源逐项选择过，
    // canSubmit 才为真。预填 copy-public 会让 pendingDecisions 恒空，
    // 门控失效，还会默认把私密图复制成公开副本。
    decisions.value = {};
  } catch (error) {
    errorText.value = (error as Error)?.message ?? "预检失败，请稍后再试";
  } finally {
    loading.value = false;
  }
}

watch(
  () => props.modelValue,
  visible => {
    if (visible) run();
  }
);

async function submit() {
  if (!result.value || !canSubmit.value) return;
  submitting.value = true;
  try {
    // visibility 不携带资源决策：字段在类型上是可选的，这里显式传空数组，
    // 让请求体与实际生效范围一致（后端也不会消费它）。
    const assetDecisions = isPublish.value
      ? Object.entries(decisions.value).map(([fileId, decision]) => ({
          fileId,
          decision
        }))
      : [];
    const payload = {
      checkId: result.value.checkId,
      baseRevision: props.baseRevision,
      targetVisibility: props.targetVisibility,
      assetDecisions
    };
    const data = await props.publish(payload);
    message(props.action === "visibility" ? "可见范围已更新" : "已发布", {
      type: "success"
    });
    emit("published", data);
    open.value = false;
  } catch (error) {
    const err = error as { code?: string; message?: string };
    if (err?.code === "CHECK_EXPIRED") {
      // checkId 有 5 分钟有效期且只能消费一次：手里这份已经作废，
      // 再点提交只会拿到同一个错误。清掉旧结果并就地重跑一次预检。
      result.value = null;
      decisions.value = {};
      await run();
      errorText.value = "预检已过期，已经重新检查，请再确认一次。";
      return;
    }
    if (err?.code === "REVISION_CONFLICT") {
      // 这篇在别处被改过：当前 baseRevision 已作废，重跑预检也没用，
      // 必须先拿到最新 revision。交给父组件刷新后重新打开面板。
      result.value = null;
      decisions.value = {};
      open.value = false;
      emit("stale", isPublish.value ? "publish" : "visibility");
      return;
    }
    // 其余错误提示由请求层统一处理；这里保留面板，站长可以重新预检
    errorText.value = err?.message ?? "发布失败";
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <el-dialog
    v-model="open"
    :title="title"
    width="min(94vw, 720px)"
    append-to-body
  >
    <div v-loading="loading" class="pub">
      <p v-if="notice" class="ws-hint ws-hint--warn">{{ notice }}</p>

      <div v-if="errorText" class="pub__box pub__box--error">
        <p class="pub__box-title">
          {{ result ? "上一次提交没有成功" : "预检没能完成" }}
        </p>
        <p class="ws-hint">{{ errorText }}</p>
        <el-button size="small" @click="run">重新预检</el-button>
      </div>

      <template v-if="result">
        <div v-if="blocking.length" class="pub__box pub__box--error">
          <p class="pub__box-title">有必须先处理的问题</p>
          <ul class="pub__list">
            <li v-for="item in blocking" :key="item.code">
              {{ item.message }}
            </li>
          </ul>
        </div>

        <div v-if="warnings.length" class="pub__box">
          <p class="pub__box-title">发布前请留意</p>
          <ul class="pub__list">
            <li v-for="item in warnings" :key="item.code">
              {{ item.message }}
            </li>
          </ul>
        </div>

        <div v-if="infos.length" class="pub__box pub__box--quiet">
          <p class="pub__box-title">说明</p>
          <ul class="pub__list">
            <li v-for="item in infos" :key="item.code">{{ item.message }}</li>
          </ul>
        </div>

        <div
          v-if="isPublish && result.assetDecisions.length"
          class="pub__assets"
        >
          <p class="pub__box-title">正文里的私密资源</p>
          <p class="ws-hint">
            这些文件当前是私密的。前台读者拿不到私密文件，所以需要你决定它们发布后怎么处理。
          </p>
          <div
            v-for="asset in result.assetDecisions"
            :key="asset.fileId"
            class="pub__asset"
          >
            <div class="pub__asset-head">
              <span class="ws-mono pub__asset-name">{{ asset.name }}</span>
              <span
                v-if="asset.sharedWithPrivate"
                class="ws-pill ws-pill--warn"
              >
                同时被其他私密内容引用
              </span>
            </div>
            <p v-if="asset.reason" class="ws-hint">{{ asset.reason }}</p>
            <el-radio-group v-model="decisions[asset.fileId]" size="small">
              <el-radio
                v-for="option in asset.options"
                :key="option"
                :value="option"
                class="pub__radio"
              >
                {{ ACTION_LABEL[option] }}
              </el-radio>
            </el-radio-group>
          </div>
        </div>

        <p
          v-if="!result.canProceed && !blocking.length"
          class="ws-hint ws-hint--warn"
        >
          后端认为当前还不能发布。请按上面的提示处理后再试。
        </p>

        <p class="ws-meta" style="margin-top: 6px">
          <span class="ws-meta__item">
            <span class="ws-meta__label">预检有效期至</span>
            <span class="ws-meta__value">{{ result.expiresAt }}</span>
          </span>
        </p>
      </template>
    </div>

    <template #footer>
      <el-button @click="open = false">取消</el-button>
      <el-button :disabled="loading" @click="run">重新预检</el-button>
      <el-button
        type="primary"
        :loading="submitting"
        :disabled="!canSubmit"
        @click="submit"
      >
        {{ ctaText }}
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.pub {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 120px;
}

.pub__box {
  padding: 12px 14px;
  background: rgb(233 189 94 / 6%);
  border: 1px solid color-mix(in srgb, var(--sol) 28%, transparent);
  border-radius: 12px;
}

.pub__box--error {
  background: rgb(239 132 86 / 8%);
  border-color: color-mix(in srgb, var(--ember) 34%, transparent);
}

.pub__box--quiet {
  background: rgb(239 232 218 / 3%);
  border-color: var(--line);
}

.pub__box-title {
  margin: 0 0 6px;
  font-family: var(--font-display);
  font-size: 14px;
  color: var(--bone);
}

.pub__list {
  padding-left: 1.1em;
  margin: 0;
  font-size: 13px;
  line-height: 1.8;
  color: var(--bone-2);
}

.pub__assets {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.pub__asset {
  padding: 10px 12px;
  background: rgb(239 232 218 / 2%);
  border: 1px solid var(--line);
  border-radius: 12px;
}

.pub__asset-head {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  margin-bottom: 4px;
}

.pub__asset-name {
  font-size: 12.5px;
  color: var(--bone);
}

.pub__radio {
  display: flex;
  align-items: flex-start;
  height: auto;
  margin: 4px 0;
  font-size: 12.5px;
  line-height: 1.6;
}
</style>
