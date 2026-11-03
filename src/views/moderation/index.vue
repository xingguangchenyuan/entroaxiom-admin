<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import { ElMessageBox } from "element-plus";
import {
  createRule,
  deleteRule,
  listRules,
  testRules,
  toggleRule,
  updateRule
} from "@/api/moderation";
import type {
  MatchMode,
  ModerationRule,
  ModerationTestResult,
  RuleField,
  RuleListQuery,
  RuleSavePayload
} from "@/api/types";
import { DEFAULT_RULE_CATEGORIES, MATCH_MODES, RULE_FIELDS } from "@/api/types";
import { usePagedList } from "@/composables/usePagedList";
import { formatDateTime } from "@/utils/format";
import { message } from "@/utils/message";
import PageHeader from "@/components/Manager/PageHeader.vue";
import EmptyState from "@/components/Manager/EmptyState.vue";

/**
 * 留言过滤规则。
 *
 * 定位要说清楚：这是**站长自己维护的关键词表**，不是平台级审核系统。
 * 所以界面上不写“保证拦截”“全面过滤”，只做两件事——把自己在意的词填进去，
 * 拿一段样例试一下，看它会不会被拦。
 *
 * 匹配只有 contains 和 exact 两种：不给任意正则，既避免灾难性回溯，
 * 也避免一个手滑的正则把整站留言全拦掉。规则结果一律以后端为准，前端不算匹配。
 */
const MATCH_LABEL: Record<MatchMode, string> = {
  contains: "包含",
  exact: "完全相同"
};
const FIELD_LABEL: Record<RuleField, string> = {
  name: "称呼",
  body: "正文"
};

const list = usePagedList<ModerationRule, RuleListQuery>({
  fetcher: query => listRules(query),
  initialQuery: { keyword: "", enabled: undefined },
  pageSize: 20
});

/* ------------------------------ 新建／编辑 ------------------------------ */

interface RuleForm {
  id: string | null;
  text: string;
  matchMode: MatchMode;
  fields: RuleField[];
  category: string;
  enabled: boolean;
}

const editorOpen = ref(false);
const saving = ref(false);
const baseRevision = ref(0);

const blankForm = (): RuleForm => ({
  id: null,
  text: "",
  matchMode: "contains",
  fields: ["body"],
  category: DEFAULT_RULE_CATEGORIES[0],
  enabled: true
});

const form = reactive<RuleForm>(blankForm());

const canSave = computed(
  () => form.text.trim().length > 0 && form.fields.length > 0
);

function openCreate() {
  Object.assign(form, blankForm());
  baseRevision.value = 0;
  editorOpen.value = true;
}

function openEdit(row: ModerationRule) {
  form.id = row.id;
  form.text = row.text;
  form.matchMode = row.matchMode;
  form.fields = [...row.fields];
  form.category = row.category;
  form.enabled = row.enabled;
  baseRevision.value = row.revision;
  editorOpen.value = true;
}

function toPayload(): RuleSavePayload {
  return {
    text: form.text.trim(),
    matchMode: form.matchMode,
    fields: [...form.fields],
    category: form.category.trim() || DEFAULT_RULE_CATEGORIES[0],
    enabled: form.enabled
  };
}

async function saveRule() {
  if (!canSave.value) {
    message("规则内容和作用字段都不能为空", { type: "warning" });
    return;
  }
  saving.value = true;
  try {
    if (form.id) {
      await updateRule(form.id, {
        ...toPayload(),
        baseRevision: baseRevision.value
      });
    } else {
      await createRule(toPayload());
    }
    editorOpen.value = false;
    await list.load();
    message(form.id ? "规则已更新" : "规则已添加", { type: "success" });
  } catch (error) {
    handleRuleError(error, "保存失败");
  } finally {
    saving.value = false;
  }
}

function handleRuleError(error: unknown, fallback: string) {
  const err = error as { code?: string; message?: string };
  if (err?.code === "REVISION_CONFLICT") {
    message("这条规则刚被别处改过，列表已刷新，请重新打开编辑", {
      type: "warning"
    });
    list.load();
    return;
  }
  message(err?.message ?? fallback, { type: "error" });
}

async function flipEnabled(row: ModerationRule, next: boolean) {
  try {
    await toggleRule(row.id, { enabled: next, baseRevision: row.revision });
    message(next ? "规则已启用" : "规则已停用", { type: "success" });
  } catch (error) {
    handleRuleError(error, "启停失败");
  } finally {
    // 无论成败都以服务端为准，避免开关停在错误位置
    await list.load();
  }
}

async function removeRule(row: ModerationRule) {
  try {
    await ElMessageBox.confirm(
      `删除「${row.text}」后，已用它拦截过的旧留言仍保留当时的命中证据，不会因此被放行。`,
      "删除规则",
      { type: "warning", confirmButtonText: "删除", cancelButtonText: "取消" }
    );
  } catch {
    return;
  }
  try {
    await deleteRule(row.id, row.revision);
    message("规则已删除", { type: "success" });
    list.loadAfterRemove();
  } catch (error) {
    handleRuleError(error, "删除失败");
  }
}

/* ------------------------------ 样例测试 ------------------------------ */

const tester = reactive({ name: "", body: "" });
const testing = ref(false);
const testResult = ref<ModerationTestResult | null>(null);
const testError = ref("");

async function runTest() {
  if (!tester.body.trim()) {
    message("至少填一段正文再测试", { type: "warning" });
    return;
  }
  testing.value = true;
  testError.value = "";
  try {
    testResult.value = await testRules({
      name: tester.name.trim(),
      body: tester.body
    });
  } catch (error) {
    testResult.value = null;
    testError.value = (error as Error)?.message ?? "测试失败";
  } finally {
    testing.value = false;
  }
}

function clearTest() {
  tester.name = "";
  tester.body = "";
  testResult.value = null;
  testError.value = "";
}

const fieldsText = (fields: RuleField[]) =>
  fields.map(field => FIELD_LABEL[field]).join("、");

list.load();
</script>

<template>
  <div class="ws-page">
    <PageHeader
      eyebrow="Moderation"
      title="留言过滤规则"
      subtitle="你自己维护的词表：填进去的词会让命中的留言先被拦下，等你决定放行还是隐藏。这不是全自动审核，也拦不住你没写进来的话。"
    >
      <template #actions>
        <el-button type="primary" size="small" @click="openCreate"
          >添加规则</el-button
        >
      </template>
    </PageHeader>

    <section class="ws-panel">
      <div class="ws-toolbar">
        <el-input
          v-model="list.query.keyword"
          size="small"
          clearable
          placeholder="搜规则内容或分类"
          style="max-width: 220px"
          @keyup.enter="list.search()"
          @clear="list.search()"
        />
        <el-select
          v-model="list.query.enabled"
          size="small"
          clearable
          placeholder="全部状态"
          style="width: 130px"
          @change="list.search()"
        >
          <el-option label="启用中" :value="true" />
          <el-option label="已停用" :value="false" />
        </el-select>
        <span class="ws-toolbar__spacer" />
        <span class="ws-hint">共 {{ list.total.value }} 条</span>
      </div>

      <el-table
        v-loading="list.loading.value"
        :data="list.items.value"
        size="small"
        row-key="id"
        class="ws-table"
      >
        <el-table-column label="规则" min-width="200">
          <template #default="{ row }">
            <p class="ws-cell-title ws-mono">{{ row.text }}</p>
            <p class="ws-cell-sub">{{ row.category }}</p>
          </template>
        </el-table-column>
        <el-table-column label="匹配" width="100">
          <template #default="{ row }">
            {{ MATCH_LABEL[row.matchMode as MatchMode] }}
          </template>
        </el-table-column>
        <el-table-column label="作用于" width="120">
          <template #default="{ row }">
            {{ fieldsText(row.fields as RuleField[]) }}
          </template>
        </el-table-column>
        <el-table-column label="启用" width="90">
          <template #default="{ row }">
            <el-switch
              :model-value="row.enabled"
              size="small"
              @update:model-value="
                (v: string | number | boolean) => flipEnabled(row, Boolean(v))
              "
            />
          </template>
        </el-table-column>
        <el-table-column label="更新" width="150">
          <template #default="{ row }">
            <span class="ws-hint">{{ formatDateTime(row.updatedAt) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="130" fixed="right">
          <template #default="{ row }">
            <el-button link size="small" @click="openEdit(row)">编辑</el-button>
            <el-button link size="small" @click="removeRule(row)"
              >删除</el-button
            >
          </template>
        </el-table-column>
        <template #empty>
          <EmptyState
            v-if="list.isFiltered.value"
            glyph="⌕"
            title="没有符合筛选的规则"
            description="换个关键词，或清空筛选看全部规则。"
            action-text="清空筛选"
            @action="list.reset"
          />
          <EmptyState
            v-else
            glyph="⊘"
            title="还没有规则"
            description="空词表意味着留言全部放行。加一条词表，命中时留言会进入待处理。"
            action-text="新建规则"
            @action="openCreate"
          />
        </template>
      </el-table>

      <div class="ws-pager">
        <el-pagination
          v-model:current-page="list.page.value"
          v-model:page-size="list.pageSize.value"
          :total="list.total.value"
          :page-sizes="[10, 20, 50]"
          layout="total, sizes, prev, pager, next"
          size="small"
          background
          @current-change="list.setPage"
          @size-change="list.search()"
        />
      </div>
    </section>

    <section class="ws-panel mod-tester">
      <div class="ws-toolbar">
        <p class="mod-tester__title">拿一段话试一试</p>
        <span class="ws-toolbar__spacer" />
        <span class="ws-hint">不会创建真实留言，也不影响线上数据</span>
      </div>
      <div class="mod-tester__grid">
        <el-input
          v-model="tester.name"
          size="small"
          maxlength="24"
          placeholder="称呼（可空）"
        />
        <el-input
          v-model="tester.body"
          type="textarea"
          :rows="4"
          maxlength="500"
          show-word-limit
          placeholder="把想试的话贴进来"
        />
        <div class="mod-tester__ops">
          <el-button size="small" :loading="testing" @click="runTest"
            >开始测试</el-button
          >
          <el-button size="small" :disabled="testing" @click="clearTest"
            >清空</el-button
          >
        </div>
      </div>

      <div v-if="testError" class="ws-hint ws-hint--warn">{{ testError }}</div>

      <div v-else-if="testResult" class="mod-result">
        <p
          class="ws-pill"
          :class="testResult.allowed ? 'ws-pill--public' : 'ws-pill--danger'"
        >
          {{ testResult.allowed ? "会放行" : "会被拦下" }}
        </p>
        <ul v-if="testResult.matches.length" class="mod-result__list">
          <li
            v-for="(match, index) in testResult.matches"
            :key="`${match.ruleId}-${index}`"
          >
            命中「<span class="ws-mono">{{ match.text }}</span
            >」 · {{ MATCH_LABEL[match.matchMode] }} · 作用于{{
              FIELD_LABEL[match.field]
            }}
          </li>
        </ul>
        <p v-else class="ws-hint">没有命中任何启用中的规则。</p>
        <p v-if="testResult.note" class="ws-hint">{{ testResult.note }}</p>
        <p v-if="testResult.policyVersion" class="ws-hint ws-mono">
          规则集版本 {{ testResult.policyVersion }}
        </p>
        <details class="mod-result__raw">
          <summary class="ws-hint">规范化后的输入</summary>
          <p class="ws-hint">
            称呼：{{ testResult.normalized.name || "（空）" }}
          </p>
          <p class="ws-hint">正文：{{ testResult.normalized.body }}</p>
        </details>
      </div>
    </section>

    <el-dialog
      v-model="editorOpen"
      :title="form.id ? '编辑规则' : '添加规则'"
      width="min(94vw, 480px)"
      append-to-body
    >
      <el-form label-position="top" size="small">
        <el-form-item label="内容" required>
          <el-input
            v-model="form.text"
            maxlength="120"
            show-word-limit
            placeholder="一个词或一段短语"
          />
        </el-form-item>
        <el-form-item label="匹配方式" required>
          <el-radio-group v-model="form.matchMode">
            <el-radio-button
              v-for="mode in MATCH_MODES"
              :key="mode"
              :value="mode"
            >
              {{ MATCH_LABEL[mode] }}
            </el-radio-button>
          </el-radio-group>
          <p class="ws-hint mod-form__hint">
            「包含」只要出现就算命中；「完全相同」用于整句复制的广告。不支持正则。
          </p>
        </el-form-item>
        <el-form-item label="作用字段" required>
          <el-checkbox-group v-model="form.fields">
            <el-checkbox
              v-for="field in RULE_FIELDS"
              :key="field"
              :value="field"
            >
              {{ FIELD_LABEL[field] }}
            </el-checkbox>
          </el-checkbox-group>
        </el-form-item>
        <el-form-item label="分类">
          <el-select
            v-model="form.category"
            filterable
            allow-create
            default-first-option
            style="width: 100%"
          >
            <el-option
              v-for="category in DEFAULT_RULE_CATEGORIES"
              :key="category"
              :label="category"
              :value="category"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="启用">
          <el-switch v-model="form.enabled" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button size="small" @click="editorOpen = false">取消</el-button>
        <el-button
          size="small"
          type="primary"
          :loading="saving"
          :disabled="!canSave"
          @click="saveRule"
        >
          保存
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.mod-tester {
  margin-top: 16px;
}

.mod-tester__title {
  margin: 0;
  font-family: var(--font-display);
  font-size: 15px;
  color: var(--bone);
}

.mod-tester__grid {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.mod-tester__ops {
  display: flex;
  gap: 8px;
}

.mod-result {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-top: 12px;
  margin-top: 12px;
  border-top: 1px solid var(--line);
}

.mod-result__list {
  padding-left: 18px;
  margin: 0;
  font-size: 12px;
  line-height: 1.8;
  color: var(--bone);
}

.mod-result__raw {
  margin-top: 4px;
}

.mod-result__raw summary {
  cursor: pointer;
}

.mod-form__hint {
  margin: 6px 0 0;
}

.ws-pill {
  align-self: flex-start;
}
</style>
