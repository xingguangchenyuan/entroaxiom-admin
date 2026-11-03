<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from "vue";
import { ElMessageBox } from "element-plus";
import {
  checkShelfPublication,
  createShelfItem,
  deleteShelfItem,
  getShelfItem,
  listShelf,
  patchShelfVisibility,
  publishShelfItem,
  saveShelfItem,
  unpublishShelfItem
} from "@/api/shelf";
import type {
  AssetDecisionOption,
  FileItem,
  PublicationCheckResult,
  ShelfConsumeStatus,
  ShelfItemAdmin,
  ShelfItemDraft,
  ShelfKind,
  ShelfListQuery,
  Visibility
} from "@/api/types";
import { SHELF_CONSUME_STATUS, SHELF_KINDS } from "@/api/types";
import { usePagedList } from "@/composables/usePagedList";
import { useUnsavedGuard } from "@/composables/useUnsavedGuard";
import { useCapabilitiesStore } from "@/store/modules/capabilities";
import { clearDraft, draftKey, loadDraft, saveDraft } from "@/utils/draftVault";
import { formatDate, formatDateTime } from "@/utils/format";
import { message } from "@/utils/message";
import PageHeader from "@/components/Manager/PageHeader.vue";
import StatusPill from "@/components/Manager/StatusPill.vue";
import EmptyState from "@/components/Manager/EmptyState.vue";
import AssetImage from "@/components/Manager/AssetImage.vue";
import AssetPickerDialog from "@/components/Manager/AssetPickerDialog.vue";
import PublishDialog from "@/components/Manager/PublishDialog.vue";

/**
 * 书影音管理。
 *
 * 这份页面最容易混的是**两个状态**：
 *  - 消费状态 `status`（读过／在读／想读）—— 内容字段，前台照着渲染；
 *  - 发布状态 `publicationStatus`（草稿／已发布）—— 管理字段，决定前台出不出这条。
 * 所以筛选、表格、按钮都分成两列，绝不合并成“状态”一个下拉。
 *
 * 编辑放在右侧抽屉里：条目字段少、改动频繁，跳页面反而更慢。
 * 保存、发布、改权限、撤回仍是四个独立动作，各自带 baseRevision。
 */
const capabilities = useCapabilitiesStore();

const KIND_LABEL: Record<ShelfKind, string> = {
  book: "书",
  film: "影",
  music: "音"
};
const CONSUME_LABEL: Record<ShelfConsumeStatus, string> = {
  done: "已读／看完",
  doing: "在读／在看",
  want: "想读／想看"
};

const list = usePagedList<ShelfItemAdmin, ShelfListQuery>({
  fetcher: query => listShelf(query),
  initialQuery: {
    keyword: "",
    kind: undefined,
    status: undefined,
    publicationStatus: undefined
  },
  pageSize: 20
});

/* ------------------------------ 抽屉编辑 ------------------------------ */

interface ShelfForm extends ShelfItemDraft {
  tagsText: string;
}

const drawerOpen = ref(false);
const editingId = ref<string | null>(null);
const loadingItem = ref(false);
const saving = ref(false);
const baseRevision = ref(0);
const itemState = ref<Pick<
  ShelfItemAdmin,
  | "publicationStatus"
  | "visibility"
  | "coverVisibility"
  | "coverShared"
  | "updatedAt"
> | null>(null);

const emptyForm = (): ShelfForm => ({
  id: "",
  kind: "book",
  title: "",
  creator: "",
  year: null,
  rating: null,
  status: "done",
  date: null,
  tags: [],
  quote: "",
  review: "",
  cover: null,
  link: null,
  tagsText: ""
});

const form = reactive<ShelfForm>(emptyForm());
const originalSnapshot = ref("");
const dirty = computed(() => snapshotOf() !== originalSnapshot.value);

/**
 * 可编辑内容的归一化快照（表单与本地草稿共用同一套）：
 * 标签统一走界面字段 tagsText；revision/发布状态/权限不属于可编辑内容差异。
 */
function snapshotOf(source: ShelfForm = form) {
  return JSON.stringify({
    ...source,
    tags: source.tagsText ?? (source.tags ?? []).join(", ")
  });
}

/* ------------------------- 本地草稿（兑现“暂存”） ------------------------- */

interface ShelfDraftData {
  form: ShelfForm;
}

/** 已有条目按“shelf:<id>”隔离；新建条目用明确的新建键，不覆盖已有条目草稿 */
const draftKeyOf = (id: string | null) => draftKey("shelf", id);

/** 把当前表单写进本地草稿（深拷贝快照）；返回写入是否成功 */
function persistShelfDraft() {
  return saveDraft(draftKeyOf(editingId.value), {
    contentId: editingId.value,
    baseRevision: editingId.value ? String(baseRevision.value) : null,
    savedAt: Date.now(),
    data: {
      form: { ...form, tags: [...form.tags], tagsText: form.tagsText }
    }
  });
}

/**
 * 打开抽屉后检查该条目的本地草稿：
 * - 与当前表单归一化后完全一致 → 冗余草稿，自动清理；
 * - 有差异 → 询问“恢复本地修改 / 丢弃本地修改”；关闭/Esc 不算同意丢弃，草稿保留；
 * - 草稿基准旧于当前服务端 revision → 提示由站长明确选择，不静默覆盖。
 */
async function offerShelfDraft() {
  const key = draftKeyOf(editingId.value);
  const draft = loadDraft<ShelfDraftData>(key);
  if (!draft?.data?.form) return;
  const local = draft.data.form;
  if (snapshotOf(local) === snapshotOf()) {
    clearDraft(key);
    return;
  }
  let staleNote = "";
  if (
    editingId.value &&
    draft.baseRevision &&
    String(baseRevision.value) !== draft.baseRevision
  ) {
    staleNote =
      "\n\n服务端已有更新版本（本地草稿基于较早的版本）。恢复会覆盖当前表单，请确认没有覆盖更新的内容。";
  }
  try {
    await ElMessageBox.confirm(
      `本地还留着一份未保存的修改（${formatDateTime(
        new Date(draft.savedAt)
      )}）。要用它替换当前表单吗？${staleNote}`,
      "发现本地草稿",
      {
        confirmButtonText: "恢复本地修改",
        cancelButtonText: "丢弃本地修改",
        distinguishCancelAndClose: true,
        type: "info"
      }
    );
  } catch (action) {
    // 只有点“丢弃本地修改”才删草稿；关闭/Esc 不算同意丢弃
    if (action === "cancel") clearDraft(key);
    return;
  }
  Object.assign(form, {
    ...local,
    tags: [...(local.tags ?? [])],
    tagsText: local.tagsText ?? (local.tags ?? []).join(", ")
  });
  // 不调用 markClean：恢复的是本地未保存内容，保持真实“未保存”状态
  message("已恢复本地修改，检查一遍再保存", { type: "success" });
}

/* ------------------------------- 守卫 ------------------------------- */

const guard = useUnsavedGuard({
  subject: () => `这条${KIND_LABEL[form.kind]}记录`,
  // 兑现“暂存草稿并离开”：确认离开的同时把表单写进草稿箱；
  // 返回写入结果——写入失败时守卫会取消本次离开。
  onLeave: () => {
    if (dirty.value) return persistShelfDraft();
    return true;
  }
});
watch(dirty, value => (value ? guard.markDirty() : guard.markClean()));

function fillForm(data: ShelfItemAdmin) {
  form.id = data.id;
  form.kind = data.kind;
  form.title = data.title;
  form.creator = data.creator ?? "";
  form.year = data.year;
  form.rating = data.rating;
  form.status = data.status;
  form.date = data.date ?? null;
  form.tags = data.tags ?? [];
  form.quote = data.quote ?? "";
  form.review = data.review ?? "";
  form.cover = data.cover ?? null;
  form.link = data.link ?? null;
  form.tagsText = (data.tags ?? []).join(", ");
  originalSnapshot.value = snapshotOf();
  baseRevision.value = data.revision;
  itemState.value = {
    publicationStatus: data.publicationStatus,
    visibility: data.visibility,
    coverVisibility: data.coverVisibility,
    coverShared: data.coverShared,
    updatedAt: data.updatedAt
  };
}

async function openCreate() {
  editingId.value = null;
  Object.assign(form, emptyForm());
  form.date = null;
  baseRevision.value = 0;
  itemState.value = null;
  originalSnapshot.value = snapshotOf();
  guard.markClean();
  drawerOpen.value = true;
  // 新建也要检查“新建草稿”：上次新建未完成留下的内容不该悄悄丢
  await offerShelfDraft();
}

async function openEdit(row: ShelfItemAdmin) {
  editingId.value = row.id;
  drawerOpen.value = true;
  loadingItem.value = true;
  try {
    const data = await getShelfItem(row.id);
    fillForm(data);
    // 先载入服务端数据，再检查该条目的本地草稿
    await offerShelfDraft();
  } catch (error) {
    message((error as Error)?.message ?? "条目读取失败", { type: "error" });
    drawerOpen.value = false;
  } finally {
    loadingItem.value = false;
  }
}

/**
 * 关闭抽屉的唯一入口（底部关闭按钮、抽屉 X、遮罩、Esc 都走这里）。
 * 确认“暂存草稿并离开”时守卫会先写草稿；写入失败/用户取消都不关闭。
 */
async function requestClose() {
  const ok = await guard.confirmLeave();
  if (!ok) return false;
  drawerOpen.value = false;
  return true;
}

function toPayload() {
  return {
    id: form.id,
    kind: form.kind,
    title: form.title.trim(),
    creator: form.creator.trim() || null,
    year: form.year,
    rating: form.rating,
    status: form.status,
    date: form.date || null,
    tags: form.tagsText
      .split(/[,，、]/)
      .map(tag => tag.trim())
      .filter(Boolean),
    quote: form.quote.trim() || null,
    review: form.review.trim() || null,
    cover: form.cover,
    link: form.link?.trim() || null
  };
}

async function save() {
  if (!form.title.trim()) {
    message("标题不能为空", { type: "warning" });
    return;
  }
  if (form.link && !/^https?:\/\//i.test(form.link.trim())) {
    message("外链只能是 http 或 https", { type: "warning" });
    return;
  }
  const payload = toPayload();
  const sent = snapshotOf();
  // 本次保存对应的草稿键：新建用“new”键，创建成功后要清理它，
  // 避免下次“新建”又提示上次已创建过的旧内容（新建键→条目键的转换）。
  const keyAtStart = draftKeyOf(editingId.value);
  saving.value = true;
  try {
    let savedClean = false;
    if (editingId.value) {
      const data = await saveShelfItem(editingId.value, {
        ...payload,
        baseRevision: baseRevision.value
      });
      fillForm(data);
      savedClean = snapshotOf() === sent;
    } else {
      const data = await createShelfItem(payload);
      editingId.value = data.id;
      fillForm(data);
      message("已创建，可以继续补充信息或直接发布", { type: "success" });
      // 新建即兑现草稿（创建出的内容就是草稿的内容）
      savedClean = true;
    }
    if (savedClean) {
      guard.markClean();
      // 只清“本次真正保存成功且与表单一致”的草稿；
      // 请求期间又产生新输入时 savedClean=false，草稿保留。
      clearDraft(keyAtStart);
      if (editingId.value && keyAtStart !== draftKeyOf(editingId.value)) {
        // 新建成功：新键里没有内容，但确保不留任何同名残留
        clearDraft(draftKeyOf(editingId.value));
      }
    }
    await list.load();
  } catch (error) {
    const err = error as { code?: string; message?: string };
    if (err?.code === "REVISION_CONFLICT") {
      message("这条刚被别处改过，已为你重新载入最新版本", { type: "warning" });
      if (editingId.value) {
        const data = await getShelfItem(editingId.value);
        fillForm(data);
      }
    } else {
      message(err?.message ?? "保存失败", { type: "error" });
    }
  } finally {
    saving.value = false;
  }
}

/* ------------------------------ 封面 ------------------------------ */

const coverPickerOpen = ref(false);
const coverAssetId = computed(() =>
  form.cover?.startsWith("asset:") ? form.cover.slice("asset:".length) : null
);
const coverIsExternal = computed(() => !!form.cover && !coverAssetId.value);

function pickCover(file: FileItem) {
  form.cover = `asset:${file.id}`;
}
function clearCover() {
  form.cover = null;
}

/* ------------------------------ 发布 ------------------------------ */

const publishOpen = ref(false);
const visibilityOpen = ref(false);
const visibilityTarget = ref<Visibility>("public");

async function doCheck(payload: {
  action: "publish" | "visibility";
  baseRevision: number;
  targetVisibility?: Visibility | null;
}): Promise<PublicationCheckResult> {
  if (!editingId.value) throw new Error("先保存这条记录");
  return checkShelfPublication(editingId.value, payload);
}

async function doPublish(payload: {
  checkId: string;
  baseRevision: number;
  targetVisibility?: Visibility | null;
  /**
   * 发布面板收集到的私密资源处理决定。必须原样透传：
   * 少传这一个字段，服务端会按“全部保持私密”处理，
   * 于是封面文案写着“已公开”，前台却是一张裂图。
   */
  assetDecisions: Array<{ fileId: string; decision: AssetDecisionOption }>;
}) {
  if (!editingId.value) throw new Error("先保存这条记录");
  const data = await publishShelfItem(editingId.value, {
    checkId: payload.checkId,
    baseRevision: payload.baseRevision,
    targetVisibility: payload.targetVisibility,
    assetDecisions: payload.assetDecisions,
    confirmed: true
  });
  fillForm(data);
  await list.load();
  return data;
}

async function applyVisibility(payload: {
  checkId: string;
  baseRevision: number;
  targetVisibility?: Visibility | null;
}) {
  if (!editingId.value) throw new Error("先保存这条记录");
  const data = await patchShelfVisibility(editingId.value, {
    visibility: (payload.targetVisibility ??
      visibilityTarget.value) as Visibility,
    baseRevision: payload.baseRevision,
    checkId: payload.checkId
  });
  fillForm(data);
  await list.load();
  return data;
}

async function unpublish() {
  if (!editingId.value) return;
  try {
    await ElMessageBox.confirm(
      "撤回后前台不再展示这条记录，但管理端数据与封面都会保留。",
      "撤回发布",
      { type: "warning", confirmButtonText: "撤回", cancelButtonText: "取消" }
    );
  } catch {
    return;
  }
  try {
    const data = await unpublishShelfItem(editingId.value, {
      baseRevision: baseRevision.value
    });
    fillForm(data);
    await list.load();
    message("已撤回发布", { type: "success" });
  } catch (error) {
    message((error as Error)?.message ?? "撤回失败", { type: "error" });
  }
}

/**
 * 预检凭据失效（`REVISION_CONFLICT`）：面板已自行关闭。
 * 先取回最新 revision，再重新打开面板触发一次新的预检。
 */
async function reopenAfterStale(target: "publish" | "visibility") {
  if (!editingId.value) return;
  try {
    const data = await getShelfItem(editingId.value);
    fillForm(data);
    await list.load();
  } catch (error) {
    message((error as Error)?.message ?? "最新内容读取失败", { type: "error" });
    return;
  }
  if (target === "visibility") {
    visibilityOpen.value = true;
    return;
  }
  publishOpen.value = true;
}

const publishNotice = computed(() => {
  if (!itemState.value) return "先保存这条记录，再发布。";
  if (itemState.value.coverVisibility === "private") {
    return "封面用的是私密文件：发布时前台会取不到它，请在预检里选择处理方式（推荐复制为公开副本）。";
  }
  if (itemState.value.visibility === "private") {
    return "这条当前是私密：发布只生成线上快照，前台仍然看不到。";
  }
  return "";
});

/* ------------------------------ 行操作 ------------------------------ */

async function removeRow(row: ShelfItemAdmin) {
  try {
    await ElMessageBox.confirm(
      row.publicationStatus === "published"
        ? "这条正在前台展示。删除后前台会立刻不再出现，且管理端无法恢复。"
        : "删除后无法恢复。",
      "删除记录",
      {
        type: "warning",
        confirmButtonText: "删除",
        cancelButtonText: "取消",
        confirmButtonClass: "el-button--danger"
      }
    );
  } catch {
    return;
  }
  try {
    await deleteShelfItem(row.id, row.revision);
    message("已删除", { type: "success" });
    if (editingId.value === row.id) drawerOpen.value = false;
    list.loadAfterRemove();
  } catch (error) {
    const err = error as { code?: string };
    message(
      err?.code === "REVISION_CONFLICT"
        ? "这条刚被别处改过，先刷新再删除"
        : ((error as Error)?.message ?? "删除失败"),
      { type: "error" }
    );
  }
}

watch(drawerOpen, visible => {
  if (!visible) guard.markClean();
});

/* --------------------- 编辑中防抖暂存（覆盖同标签页刷新） --------------------- */

let shelfVaultTimer: number | undefined;

watch(
  () => snapshotOf(),
  () => {
    if (!drawerOpen.value) return;
    if (dirty.value) {
      window.clearTimeout(shelfVaultTimer);
      shelfVaultTimer = window.setTimeout(() => {
        // 离开前/保存成功时另有即时写入；这里只兜“刷新页面也能找回”
        if (!dirty.value || !drawerOpen.value) return;
        persistShelfDraft();
      }, 800);
    }
  }
);

onBeforeUnmount(() => {
  window.clearTimeout(shelfVaultTimer);
});

capabilities.ensure();
list.load();
</script>

<template>
  <div class="ws-page">
    <PageHeader
      eyebrow="Shelf"
      title="书影音"
      subtitle="读完的书、看过的片、听过的碟。消费状态是给读者看的，发布状态是给你自己看的——两者互不影响。"
    >
      <template #actions>
        <el-button type="primary" size="small" @click="openCreate"
          >新建条目</el-button
        >
      </template>
    </PageHeader>

    <section class="ws-panel">
      <div class="ws-toolbar">
        <el-input
          v-model="list.query.keyword"
          size="small"
          clearable
          placeholder="搜标题、作者、短评"
          style="max-width: 240px"
          @keyup.enter="list.search()"
          @clear="list.search()"
        />
        <el-select
          v-model="list.query.kind"
          size="small"
          clearable
          placeholder="全部类型"
          style="width: 120px"
          @change="list.search()"
        >
          <el-option
            v-for="kind in SHELF_KINDS"
            :key="kind"
            :label="KIND_LABEL[kind]"
            :value="kind"
          />
        </el-select>
        <el-select
          v-model="list.query.status"
          size="small"
          clearable
          placeholder="全部消费状态"
          style="width: 150px"
          @change="list.search()"
        >
          <el-option
            v-for="status in SHELF_CONSUME_STATUS"
            :key="status"
            :label="CONSUME_LABEL[status]"
            :value="status"
          />
        </el-select>
        <el-select
          v-model="list.query.publicationStatus"
          size="small"
          clearable
          placeholder="全部发布状态"
          style="width: 140px"
          @change="list.search()"
        >
          <el-option label="草稿" value="draft" />
          <el-option label="已发布" value="published" />
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
        <el-table-column label="封面" width="72">
          <template #default="{ row }">
            <AssetImage
              v-if="row.cover?.startsWith('asset:')"
              :file-id="row.cover.slice(6)"
              aspect="2 / 3"
              class="shelf__cover"
            />
            <img
              v-else-if="row.cover"
              :src="row.cover"
              alt=""
              class="shelf__cover"
              referrerpolicy="no-referrer"
            />
            <div v-else class="shelf__cover shelf__cover--empty">
              {{ KIND_LABEL[row.kind as ShelfKind] }}
            </div>
          </template>
        </el-table-column>
        <el-table-column label="标题" min-width="220">
          <template #default="{ row }">
            <p class="ws-cell-title">{{ row.title }}</p>
            <p class="ws-cell-sub">
              {{ row.creator || "—"
              }}<template v-if="row.year"> · {{ row.year }}</template>
              <template v-if="row.rating"> · ★ {{ row.rating }}</template>
            </p>
          </template>
        </el-table-column>
        <el-table-column label="类型" width="70">
          <template #default="{ row }">{{
            KIND_LABEL[row.kind as ShelfKind]
          }}</template>
        </el-table-column>
        <el-table-column label="消费状态" width="120">
          <template #default="{ row }">
            <el-tag size="small" effect="plain" type="info">
              {{ CONSUME_LABEL[row.status as ShelfConsumeStatus] }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="发布" width="150">
          <template #default="{ row }">
            <StatusPill :value="row.publicationStatus" kind="publication" />
            <StatusPill :value="row.visibility" kind="visibility" />
          </template>
        </el-table-column>
        <el-table-column label="标记日期" width="110">
          <template #default="{ row }">{{
            row.date ? formatDate(row.date) : "—"
          }}</template>
        </el-table-column>
        <el-table-column label="更新" width="140">
          <template #default="{ row }">
            <span class="ws-hint">{{ formatDateTime(row.updatedAt) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="150" fixed="right">
          <template #default="{ row }">
            <el-button link size="small" @click="openEdit(row)">编辑</el-button>
            <el-button link size="small" @click="removeRow(row)"
              >删除</el-button
            >
          </template>
        </el-table-column>
        <template #empty>
          <EmptyState
            v-if="list.isFiltered.value"
            glyph="⌕"
            title="没有符合筛选的条目"
            description="换个关键词、类型或状态，也可以清空筛选看全部。"
            action-text="清空筛选"
            @action="list.reset"
          />
          <EmptyState
            v-else
            glyph="❑"
            title="书架还是空的"
            description="记下读完的、在看的、想看的——私密保存，想公开时再发布。"
            action-text="新增一条"
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

    <el-drawer
      :model-value="drawerOpen"
      :title="editingId ? '编辑条目' : '新建条目'"
      size="min(96vw, 620px)"
      :before-close="done => requestClose().then(ok => done(ok ? true : false))"
      @update:model-value="value => (drawerOpen = value)"
    >
      <div v-loading="loadingItem" class="shelf-form">
        <el-form label-position="top" size="small">
          <div class="shelf-form__row">
            <el-form-item label="类型" required>
              <el-radio-group v-model="form.kind">
                <el-radio-button
                  v-for="kind in SHELF_KINDS"
                  :key="kind"
                  :value="kind"
                >
                  {{ KIND_LABEL[kind] }}
                </el-radio-button>
              </el-radio-group>
            </el-form-item>
            <el-form-item label="消费状态" required>
              <el-select v-model="form.status" style="width: 100%">
                <el-option
                  v-for="status in SHELF_CONSUME_STATUS"
                  :key="status"
                  :label="CONSUME_LABEL[status]"
                  :value="status"
                />
              </el-select>
            </el-form-item>
          </div>

          <el-form-item label="标题" required>
            <el-input v-model="form.title" maxlength="160" show-word-limit />
          </el-form-item>

          <div class="shelf-form__row">
            <el-form-item label="作者／导演／音乐人">
              <el-input v-model="form.creator" maxlength="120" />
            </el-form-item>
            <el-form-item label="年份">
              <el-input-number
                v-model="form.year"
                :min="1"
                :max="2200"
                :controls="false"
                placeholder="可空"
                style="width: 100%"
              />
            </el-form-item>
          </div>

          <div class="shelf-form__row">
            <el-form-item label="评分（0–5，可半星）">
              <el-rate v-model="form.rating" allow-half clearable />
            </el-form-item>
            <el-form-item label="标记日期">
              <el-date-picker
                v-model="form.date"
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
              placeholder="例如：科幻, 短篇, 重读"
            />
          </el-form-item>

          <el-form-item label="一句话摘录">
            <el-input
              v-model="form.quote"
              type="textarea"
              :rows="2"
              maxlength="300"
              show-word-limit
            />
          </el-form-item>

          <el-form-item label="短评（纯文本，空行分段）">
            <el-input
              v-model="form.review"
              type="textarea"
              :rows="6"
              maxlength="3000"
              show-word-limit
              placeholder="不用 Markdown：前台按段落直接排版"
            />
          </el-form-item>

          <el-form-item label="封面">
            <div class="shelf-cover">
              <div class="shelf-cover__preview">
                <AssetImage
                  v-if="coverAssetId"
                  :file-id="coverAssetId"
                  aspect="2 / 3"
                />
                <img
                  v-else-if="coverIsExternal"
                  :src="form.cover ?? ''"
                  alt=""
                  referrerpolicy="no-referrer"
                />
                <span v-else class="ws-hint">未设置</span>
              </div>
              <div class="shelf-cover__ops">
                <el-button size="small" @click="coverPickerOpen = true">
                  从文件库选
                </el-button>
                <el-button
                  size="small"
                  :disabled="!form.cover"
                  @click="clearCover"
                >
                  清除
                </el-button>
                <p v-if="coverAssetId" class="ws-hint ws-mono">
                  asset:{{ coverAssetId }}
                </p>
                <p v-if="itemState?.coverShared" class="ws-hint ws-hint--warn">
                  这张封面还被别的条目共用，改权限会影响它们。
                </p>
                <p
                  v-if="itemState && itemState.coverVisibility === 'private'"
                  class="ws-hint"
                >
                  封面是私密资源：前台取不到，发布时会被要求处理。
                </p>
                <el-input
                  v-model="form.cover"
                  size="small"
                  placeholder="或直接填 https 图片地址"
                  style="margin-top: 6px"
                />
              </div>
            </div>
          </el-form-item>

          <el-form-item label="外链（豆瓣等）">
            <el-input v-model="form.link" placeholder="https://…" />
          </el-form-item>
        </el-form>

        <div v-if="itemState" class="shelf-form__state">
          <StatusPill :value="itemState.publicationStatus" kind="publication" />
          <StatusPill :value="itemState.visibility" kind="visibility" />
          <span class="ws-hint"
            >更新于 {{ formatDateTime(itemState.updatedAt) }}</span
          >
        </div>
      </div>

      <template #footer>
        <div class="shelf-form__footer">
          <el-button
            v-if="itemState?.publicationStatus === 'published'"
            size="small"
            @click="unpublish"
          >
            撤回发布
          </el-button>
          <el-dropdown v-if="editingId" trigger="click" :disabled="dirty">
            <el-button size="small">可见范围</el-button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item
                  :disabled="itemState?.visibility === 'public'"
                  @click="
                    ((visibilityTarget = 'public'), (visibilityOpen = true))
                  "
                >
                  改为公开
                </el-dropdown-item>
                <el-dropdown-item
                  :disabled="itemState?.visibility === 'private'"
                  @click="
                    ((visibilityTarget = 'private'), (visibilityOpen = true))
                  "
                >
                  改为私密
                </el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
          <span class="ws-toolbar__spacer" />
          <el-button size="small" @click="requestClose">关闭</el-button>
          <el-button
            size="small"
            :loading="saving"
            :disabled="!dirty"
            @click="save"
          >
            保存
          </el-button>
          <el-button
            size="small"
            type="primary"
            :disabled="!editingId || saving"
            @click="publishOpen = true"
          >
            {{
              itemState?.publicationStatus === "published" ? "更新发布" : "发布"
            }}
          </el-button>
        </div>
      </template>
    </el-drawer>

    <AssetPickerDialog
      v-model="coverPickerOpen"
      title="选择封面"
      :kinds="['image']"
      @pick="pickCover"
    />

    <PublishDialog
      v-model="publishOpen"
      :check="doCheck"
      :publish="doPublish"
      :base-revision="baseRevision"
      :subject="`这条${KIND_LABEL[form.kind]}记录`"
      :notice="publishNotice"
      @published="publishOpen = false"
      @stale="reopenAfterStale"
    />

    <PublishDialog
      v-model="visibilityOpen"
      action="visibility"
      :target-visibility="visibilityTarget"
      :check="doCheck"
      :publish="applyVisibility"
      :base-revision="baseRevision"
      :subject="`这条${KIND_LABEL[form.kind]}记录`"
      notice="改权限不产生新快照。私密条目即使发布，前台也不展示。"
      @published="visibilityOpen = false"
      @stale="reopenAfterStale"
    />
  </div>
</template>

<style scoped>
.shelf__cover {
  display: block;
  width: 44px;
  height: 66px;
  object-fit: cover;
  border: 1px solid var(--line);
  border-radius: 6px;
}

.shelf__cover--empty {
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  color: var(--ash);
  background: rgb(239 232 218 / 4%);
}

.shelf-form {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.shelf-form__row {
  display: flex;
  gap: 12px;
}

.shelf-form__row > * {
  flex: 1 1 0;
  min-width: 0;
}

.shelf-form__state {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  padding-top: 8px;
  border-top: 1px solid var(--line);
}

.shelf-form__footer {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}

.shelf-cover {
  display: flex;
  gap: 12px;
  align-items: flex-start;
  width: 100%;
}

.shelf-cover__preview {
  display: flex;
  flex: 0 0 76px;
  align-items: center;
  justify-content: center;
  width: 76px;
  height: 112px;
  overflow: hidden;
  background: rgb(239 232 218 / 4%);
  border: 1px solid var(--line);
  border-radius: 8px;
}

.shelf-cover__preview img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.shelf-cover__ops {
  display: flex;
  flex: 1 1 0;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
  min-width: 0;
}

.shelf-cover__ops .ws-hint {
  width: 100%;
  margin: 0;
}

@media (width <= 900px) {
  .shelf-form__row {
    flex-direction: column;
    gap: 0;
  }
}
</style>
