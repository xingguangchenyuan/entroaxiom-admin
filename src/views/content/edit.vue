<script setup lang="ts">
import {
  computed,
  onBeforeUnmount,
  onMounted,
  reactive,
  ref,
  watch
} from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessageBox } from "element-plus";
import { diffLines } from "diff";
import {
  checkArticlePublication,
  deleteArticle,
  exportArticle,
  getArticle,
  getContentOptions,
  patchArticleVisibility,
  publishArticle,
  saveArticle,
  unpublishArticle
} from "@/api/content";
import { asContentRes } from "@/api/types";
import type {
  ArticleDetail,
  ContentOptions,
  ContentRes,
  Visibility
} from "@/api/types";
import { useCapabilitiesStore } from "@/store/modules/capabilities";
import { useUnsavedGuard } from "@/composables/useUnsavedGuard";
import { clearDraft, draftKey, loadDraft, saveDraft } from "@/utils/draftVault";
import { editableArticleSnapshot } from "@/utils/editableSnapshot";
import { createSaveQueue } from "@/utils/saveQueue";
import { countChars } from "@/utils/markdown";
import { message } from "@/utils/message";
import { fetchFileBlob, saveBlob } from "@/utils/media";
import { formatBytes, formatDateTime } from "@/utils/format";
import MarkdownEditor from "@/components/Manager/MarkdownEditor.vue";
import MarkdownView from "@/components/Manager/MarkdownView.vue";
import StatusPill from "@/components/Manager/StatusPill.vue";
import AssetImage from "@/components/Manager/AssetImage.vue";
import PublishDialog from "@/components/Manager/PublishDialog.vue";
import ConflictDialog from "@/components/Manager/ConflictDialog.vue";
import VersionHistory from "@/components/Manager/VersionHistory.vue";

/**
 * 文章编辑页（随笔／笔记共用）。
 *
 * 这里集中体现了方案里最容易做错的三件事，写代码时按这三条对照：
 *
 * 1. **工作稿与线上快照分离**：保存只改工作稿；发布是独立动作，且必须先预检。
 *    界面永远同时显示「发布状态」和「是否有未发布修改」，不合并成一个开关。
 * 2. **可见范围是独立操作**：普通保存不携带 visibility；改权限走独立接口，
 *    并且要先看资源检查结果。私密文章也可以有发布快照，只是前台看不到。
 * 3. **并发必须显式处理**：所有写入带 baseRevision；409 时弹冲突面板，
 *    给「覆盖／放弃／看差异」三条路，绝不自动重试覆盖。
 *
 * 自动保存只更新工作稿（saveMode=auto），同一篇的保存请求串行化，
 * 晚返回的旧结果不会覆盖新输入；切换文章时旧请求的响应会被丢弃。
 */
const route = useRoute();
const router = useRouter();
const capabilities = useCapabilitiesStore();

const res = computed<ContentRes>(
  () => asContentRes((route.meta as { res?: unknown }).res) ?? "essays"
);
const articleId = computed(() => String(route.params.id ?? ""));
const isEssay = computed(() => res.value === "essays");
const resLabel = computed(() => (isEssay.value ? "随笔" : "学习笔记"));
const listPath = computed(() => `/content/${res.value}`);

const loading = ref(true);
const loadError = ref("");
const detail = ref<ArticleDetail | null>(null);
const options = ref<ContentOptions>({ categories: [], tags: [] });

interface EditorForm {
  title: string;
  summary: string;
  category: string;
  tags: string[];
  date: string;
  updated: string;
  mood: string;
  place: string;
  body: string;
}

const form = reactive<EditorForm>({
  title: "",
  summary: "",
  category: "",
  tags: [],
  date: "",
  updated: "",
  mood: "",
  place: "",
  body: ""
});

/**
 * 与后端一致的“可编辑内容”快照：用它判断脏，而不是比两个对象引用。
 *
 * 归一化规则（表单、服务端详情、本地草稿共用同一套，避免“脏”与“恢复”
 * 用两套标准打架）：
 * - 可选文本字段按 null/空串/缺失统一成空串，再 trim；
 * - 标签数组逐项 trim 并去掉空项，**不排序**（沿用现有产品语义）；
 * - body 是 Markdown 正文，**绝不 trim**（trim 会改变实际正文）；
 * - 随笔才把 mood/place 纳入差异，笔记一律视为空；
 * - revision/updatedAt/权限/发布状态不属于可编辑内容差异。
 *
 * 具体实现抽到 src/utils/editableSnapshot.ts，供回归脚本直接验证。
 */
function snapshotOf(source: EditorForm) {
  return editableArticleSnapshot(source, isEssay.value);
}

/** 服务端详情 → 同样的归一化快照，供“草稿是否与服务端一致”判断 */
function snapshotOfDetail(data: ArticleDetail) {
  return editableArticleSnapshot(
    {
      title: data.title ?? "",
      summary: data.summary ?? "",
      category: data.category ?? "",
      tags: [...(data.tags ?? [])],
      date: data.date ?? "",
      updated: data.updated ?? "",
      mood: data.mood ?? "",
      place: data.place ?? "",
      body: data.body ?? ""
    },
    isEssay.value
  );
}

const originalSnapshot = ref("");
const dirty = computed(
  () => !!detail.value && snapshotOf(form) !== originalSnapshot.value
);

/* ------------------------------ 保存状态 ------------------------------ */

type SaveState = "idle" | "dirty" | "saving" | "saved" | "error";
const saveState = ref<SaveState>("idle");
const savedAt = ref<Date | null>(null);
const saveError = ref("");

const saveLabel = computed(() => {
  if (saveState.value === "saving") return "保存中…";
  if (saveState.value === "error") return "保存失败";
  if (dirty.value) return "有未保存修改";
  if (saveState.value === "saved" && savedAt.value) {
    return `已保存于 ${savedAt.value.toLocaleTimeString("zh-CN", { hour12: false })}`;
  }
  return "已保存";
});

const bodyBytes = computed(() => new Blob([form.body]).size);
const bodyChars = computed(() => countChars(form.body));
const bodyTooLarge = computed(
  () => bodyBytes.value > capabilities.maxBodyBytes
);
const publishReady = computed(() => {
  if (!detail.value) return false;
  return !!form.title.trim() && !!form.body.trim() && !bodyTooLarge.value;
});

/* ------------------------------ 载入 ------------------------------ */

const vaultKey = computed(() =>
  draftKey(`content:${res.value}`, articleId.value)
);

/** 把当前表单写进本地草稿；只在脏的时候调用。返回写入是否成功。 */
function persistDraft() {
  return saveDraft(vaultKey.value, {
    contentId: articleId.value || null,
    baseRevision: detail.value ? String(detail.value.revision) : null,
    savedAt: Date.now(),
    data: { form: { ...form, tags: [...form.tags] } }
  });
}

function applyDetail(data: ArticleDetail) {
  detail.value = data;
  form.title = data.title ?? "";
  form.summary = data.summary ?? "";
  form.category = data.category ?? "";
  form.tags = [...(data.tags ?? [])];
  form.date = data.date ?? "";
  form.updated = data.updated ?? "";
  form.mood = data.mood ?? "";
  form.place = data.place ?? "";
  form.body = data.body ?? "";
  originalSnapshot.value = snapshotOf(form);
  saveState.value = "idle";
  savedAt.value = data.updatedAt ? new Date(data.updatedAt) : null;
  saveError.value = "";
}

async function load() {
  loading.value = true;
  loadError.value = "";
  try {
    const data = await getArticle(res.value, articleId.value);
    applyDetail(data);
    await offerDraft(data);
  } catch (error) {
    loadError.value = (error as Error)?.message ?? "这篇文章读取失败";
  } finally {
    loading.value = false;
  }
}

/**
 * 恢复本地草稿。
 * 只提示，不自动覆盖：服务端可能已经有更新的内容，替换与否必须由站长决定。
 *
 * 差异判断用与“脏状态”同一套归一化快照（snapshotOf）：标题正文相同、
 * 只有摘要/分类/标签/日期/随笔心境地点不同的草稿也必须保留并提供恢复入口；
 * 只有全部可编辑字段归一化后完全一致，才属于冗余草稿，可以自动清理。
 * 关闭/Esc 提示不属于“明确丢弃”，草稿保留。
 */
async function offerDraft(server: ArticleDetail) {
  const draft = loadDraft<{ form: EditorForm }>(vaultKey.value);
  if (!draft?.data?.form) return;
  const local = draft.data.form;
  if (snapshotOf(local) === snapshotOfDetail(server)) {
    clearDraft(vaultKey.value);
    return;
  }
  try {
    await ElMessageBox.confirm(
      `本地还留着一份未保存的修改（${formatDateTime(
        new Date(draft.savedAt)
      )}）。要用它替换线上工作稿的内容吗？`,
      "发现本地草稿",
      {
        confirmButtonText: "恢复本地修改",
        cancelButtonText: "丢弃本地修改",
        distinguishCancelAndClose: true,
        type: "info"
      }
    );
    Object.assign(form, {
      ...local,
      mood: local.mood ?? "",
      place: local.place ?? ""
    });
    saveState.value = "dirty";
    message("已恢复本地修改，检查一遍再保存", { type: "success" });
  } catch (action) {
    // 只有点“丢弃本地修改”才删草稿；关闭/Esc 不算同意丢弃，草稿保留
    if (action === "cancel") clearDraft(vaultKey.value);
  }
}

/* ------------------------------ 保存 ------------------------------ */

const saving = ref(false);

/** 一次保存请求的结果：谁调用它谁负责解读 */
type SaveOutcome = "saved" | "dirty" | "skipped" | "error" | "conflict";

function buildPayload(mode: "auto" | "manual") {
  return {
    id: articleId.value,
    title: form.title.trim(),
    summary: form.summary.trim() || null,
    category: form.category.trim() || null,
    tags: form.tags.map(tag => tag.trim()).filter(Boolean),
    date: form.date || null,
    updated: form.updated || null,
    body: form.body,
    ...(isEssay.value
      ? { mood: form.mood.trim() || null, place: form.place.trim() || null }
      : {}),
    baseRevision: detail.value?.revision ?? 0,
    saveMode: mode
  };
}

/**
 * 真正的保存请求（无并发保护，由 save() 串行化调用）。
 * 同一时刻只允许一个请求在飞：请求期间发生的改动会排队，等这次回来再写一次，
 * 这样“晚返回的旧请求覆盖新输入”不可能发生。
 */
async function runSave(mode: "auto" | "manual"): Promise<SaveOutcome> {
  if (!detail.value || loading.value) return "skipped";
  if (mode === "auto" && !dirty.value) return "skipped";
  if (mode === "manual" && !form.title.trim()) {
    message("标题不能为空", { type: "warning" });
    return "skipped";
  }
  if (bodyTooLarge.value) {
    message("正文超过服务端上限，先精简再保存", { type: "warning" });
    return "skipped";
  }

  const sentSnapshot = snapshotOf(form);
  const payload = buildPayload(mode);
  saving.value = true;
  saveState.value = "saving";
  saveError.value = "";

  // 记录本次保存针对哪一篇：切走文章后，旧响应不能再落到新页面上
  const forArticle = articleId.value;

  try {
    const saved = await saveArticle(res.value, forArticle, payload);
    if (forArticle !== articleId.value) return "skipped";
    detail.value = saved;
    if (snapshotOf(form) === sentSnapshot) {
      originalSnapshot.value = sentSnapshot;
      saveState.value = "saved";
      savedAt.value = new Date();
      clearDraft(vaultKey.value);
      if (mode === "manual") message("已保存工作稿", { type: "success" });
      return "saved";
    }
    // 保存期间又改了：保持脏状态，让调用方决定要不要补存
    saveState.value = "dirty";
    return "dirty";
  } catch (error) {
    if (forArticle !== articleId.value) return "skipped";
    const err = error as { code?: string; message?: string };
    if (err?.code === "REVISION_CONFLICT") {
      await openConflict();
      return "conflict";
    }
    saveState.value = "error";
    saveError.value = err?.message ?? "保存失败";
    message(saveError.value, { type: "error" });
    return "error";
  } finally {
    saving.value = false;
  }
}

/**
 * 串行化保存链：保证同一时间只有一个保存请求在飞。
 * 实现抽到 src/utils/saveQueue.ts，供回归脚本直接验证。
 */
const saveQueue = createSaveQueue();

/**
 * 保存工作稿（入口）。
 * 返回这次保存的明确结果；请求期间的新改动会作为下一次链式保存处理。
 */
function save(mode: "auto" | "manual"): Promise<SaveOutcome> {
  return saveQueue.enqueue(() => runSave(mode));
}

/** 等已排队的保存全部结束（不吞结果） */
function awaitSaveIdle(): Promise<void> {
  return saveQueue.awaitIdle();
}

/**
 * 保证当前编辑内容已保存到服务端工作稿（供恢复历史版本前的编排使用）。
 * 只有真正保存成功才返回 "saved"；校验失败/网络错误/冲突都返回 "failed"，
 * 调用方不得继续发恢复请求。
 */
async function ensureSaved(): Promise<"saved" | "failed"> {
  if (!detail.value || loading.value) return "failed";
  await awaitSaveIdle();
  if (!dirty.value) return "saved";
  const outcome = await save("manual");
  if (outcome === "saved") return "saved";
  if (outcome === "dirty") {
    // 保存期间又有新输入（防御）：已排队，再等一轮
    await awaitSaveIdle();
    return "failed";
  }
  // conflict 时 openConflict 已打开冲突面板；skipped/error 直接失败
  return "failed";
}

/* ------------------------------ 自动保存 ------------------------------ */

let autoTimer: number | undefined;
let vaultTimer: number | undefined;

watch(
  () => snapshotOf(form),
  () => {
    if (!detail.value) return;
    // 恢复历史版本的编排过程中：暂停自动保存与防抖暂存，
    // 由 beforeRestore 显式完成“保存当前稿”，避免定时保存插队。
    if (restoreBusy.value) return;
    if (dirty.value) {
      if (saveState.value !== "saving") saveState.value = "dirty";
      window.clearTimeout(vaultTimer);
      vaultTimer = window.setTimeout(() => {
        if (!dirty.value || restoreBusy.value) return;
        persistDraft();
      }, 800);
      window.clearTimeout(autoTimer);
      // 停手 2.5 秒再写一次，避免每敲一个字就打一次接口
      autoTimer = window.setTimeout(() => {
        // 发布/可见范围面板开着时不能自动保存：预检把 baseRevision 绑进了
        // checkId，此时再写一次工作稿，提交发布必然 409（预检凭据与当前稿不符）。
        if (
          conflictOpen.value ||
          saving.value ||
          restoreBusy.value ||
          publishOpen.value ||
          visibilityOpen.value
        ) {
          return;
        }
        void save("auto");
      }, 2500);
    }
  }
);

/* ------------------------------ 冲突 ------------------------------ */

const conflictOpen = ref(false);
const conflictServer = ref<ArticleDetail | null>(null);
const compareOpen = ref(false);
const overwriting = ref(false);

async function openConflict() {
  try {
    const server = await getArticle(res.value, articleId.value);
    conflictServer.value = server;
    conflictOpen.value = true;
    saveState.value = "error";
    saveError.value = "线上有更新的版本";
  } catch {
    message("保存冲突，且没能取到线上版本，请刷新页面再试", { type: "error" });
  }
}

const conflictDiff = computed(() => {
  if (!conflictServer.value) return [];
  return diffLines(conflictServer.value.body ?? "", form.body ?? "");
});

function discardMine() {
  if (!conflictServer.value) return;
  applyDetail(conflictServer.value);
  conflictOpen.value = false;
  compareOpen.value = false;
  message("已载入线上版本", { type: "success" });
}

async function overwriteMine() {
  if (!conflictServer.value || !detail.value) return;
  overwriting.value = true;
  try {
    // 以线上最新版本号为基准重写：旧的线上工作稿会进历史版本，不是静默丢弃
    detail.value = { ...detail.value, revision: conflictServer.value.revision };
    conflictOpen.value = false;
    compareOpen.value = false;
    await save("manual");
  } finally {
    overwriting.value = false;
  }
}

/* ------------------------------ 发布 ------------------------------ */

const publishOpen = ref(false);
const visibilityOpen = ref(false);
const visibilityTarget = ref<Visibility>("public");

const publishNotice = computed(() => {
  if (!detail.value) return "";
  if (dirty.value) {
    return "编辑框里还有尚未保存的修改。发布的内容是最近一次已保存的工作稿，未保存的改动不会包含进去——发布完成后请再保存一次。";
  }
  if (detail.value.visibility === "private") {
    return "这篇当前是私密：发布只生成线上快照，前台仍然看不到。要让读者看到，需要在「可见范围」里改为公开。";
  }
  if (detail.value.status === "published") {
    return "工作稿与线上快照一致，重发不会产生实质变化。";
  }
  return "";
});

async function doCheck(payload: {
  action: "publish" | "visibility";
  baseRevision: number;
  targetVisibility?: Visibility | null;
}) {
  return checkArticlePublication(res.value, articleId.value, payload);
}

async function doPublish(payload: {
  checkId: string;
  baseRevision: number;
  targetVisibility?: Visibility | null;
  assetDecisions: Array<{
    fileId: string;
    decision: "keep-private" | "copy-public" | "make-public";
  }>;
}) {
  return publishArticle(res.value, articleId.value, {
    checkId: payload.checkId,
    baseRevision: payload.baseRevision,
    targetVisibility: payload.targetVisibility,
    assetDecisions: payload.assetDecisions,
    confirmed: true
  });
}

async function onPublished() {
  // 发布的是“已保存的工作稿”：如果编辑框里还有未保存改动，
  // 它们既没进发布内容、也没被存过，不能借发布把它们标成“已保存”。
  await reloadAfterMutation();
  if (!dirty.value) {
    originalSnapshot.value = snapshotOf(form);
    saveState.value = "idle";
  }
}

/**
 * 变更后重新取详情。
 *
 * 只刷新服务端信息（detail/revision/发布元信息），绝不触碰 originalSnapshot
 * 或 saveState：权限回执不是“正文已保存”的证据，不能用来清未保存状态。
 * 刷新失败要提示（错误 revision 静默覆盖会让后续保存带错基准），不吞错。
 */
async function reloadAfterMutation() {
  const forArticle = articleId.value;
  const forRes = res.value;
  try {
    const data = await getArticle(forRes, forArticle);
    if (forArticle !== articleId.value || forRes !== res.value) return;
    detail.value = data;
  } catch (error) {
    message(
      (error as Error)?.message ?? "变更后的详情刷新失败，请刷新页面后再编辑",
      { type: "warning" }
    );
  }
}

/** 可见范围变更成功后：只刷新详情，不把权限回执当成“正文已保存” */
async function onVisibilityApplied() {
  await reloadAfterMutation();
}

/**
 * 预检凭据失效（`REVISION_CONFLICT`）后重新开面板。
 * 面板已自行关闭；这里先把最新 revision 取回来，再重新打开，
 * 面板的 watch 会用新 revision 重跑一次预检，站长不用手动刷新页面。
 */
async function reopenAfterStale(target: "publish" | "visibility") {
  await reloadAfterMutation();
  if (!detail.value) return;
  if (target === "visibility") {
    visibilityOpen.value = true;
    return;
  }
  publishOpen.value = true;
}

function openVisibility(target: Visibility) {
  if (!detail.value) return;
  if (target === detail.value.visibility) return;
  visibilityTarget.value = target;
  visibilityOpen.value = true;
}

async function applyVisibility(payload: {
  checkId: string;
  baseRevision: number;
  targetVisibility?: Visibility | null;
}) {
  // 权限是独立子资源：这里只改权限，不产生新快照
  return patchArticleVisibility(res.value, articleId.value, {
    visibility: (payload.targetVisibility ??
      visibilityTarget.value) as Visibility,
    baseRevision: payload.baseRevision,
    checkId: payload.checkId
  });
}

const visibilityNotice = computed(() =>
  visibilityTarget.value === "public"
    ? "改为公开后，访客能直接打开这篇的线上快照。正文里的私密资源不会被自动公开——需要它在页面显示，请走发布流程并选择「复制为公开副本」。"
    : "改为私密会立刻限制后续公开访问：已经打开的页面和已下载的副本无法收回。工作稿与快照都保留。"
);

async function unpublish() {
  if (!detail.value) return;
  try {
    await ElMessageBox.confirm(
      "撤回后前台不再提供这篇内容，工作稿与历史版本都会保留。重新发布即可恢复。",
      "撤回发布",
      { type: "warning", confirmButtonText: "撤回", cancelButtonText: "取消" }
    );
  } catch {
    return;
  }
  try {
    const data = await unpublishArticle(res.value, articleId.value, {
      baseRevision: detail.value.revision
    });
    // 撤回请求针对的是当前这篇；切走后旧响应不得落到新页面上
    if (data.id === articleId.value) {
      detail.value = data;
    }
    // 撤回发布不动正文：编辑框里若有未保存改动，继续保持“未保存”状态，
    // 不能借撤回把没存过的东西标成已保存。
    if (!dirty.value) {
      originalSnapshot.value = snapshotOf(form);
    }
    message("已撤回发布", { type: "success" });
  } catch (error) {
    message((error as Error)?.message ?? "撤回失败", { type: "error" });
  }
}

/* ------------------------------ 导出 / 删除 ------------------------------ */

const exporting = ref(false);

async function exportAs(format: "md" | "zip", source: "working" | "published") {
  if (!detail.value) return;
  exporting.value = true;
  try {
    const response = await exportArticle(res.value, articleId.value, {
      source,
      format
    });
    const blob = response.data;
    const filename = `${detail.value.id}-${source === "published" ? "published" : "working"}.${format}`;
    saveBlob(blob, filename);
    message("已开始下载", { type: "success" });
  } catch (error) {
    message((error as Error)?.message ?? "导出失败", { type: "error" });
  } finally {
    exporting.value = false;
  }
}

async function removeArticle() {
  if (!detail.value) return;
  try {
    await ElMessageBox.confirm(
      detail.value.status === "published"
        ? "这篇正在前台公开。删除会同时撤掉公开入口，且不可恢复。"
        : "删除后不可恢复。",
      "删除文章",
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
    guard.markClean();
    await deleteArticle(res.value, articleId.value, detail.value.revision);
    message("已删除", { type: "success" });
    router.push(listPath.value);
  } catch (error) {
    const err = error as { code?: string };
    message(
      err?.code === "REVISION_CONFLICT"
        ? "这篇刚被别处改过，先刷新再删除"
        : ((error as Error)?.message ?? "删除失败"),
      { type: "error" }
    );
  }
}

/* ------------------------------ 视图 ------------------------------ */

type ViewMode = "split" | "edit" | "preview";
const viewMode = ref<ViewMode>(
  typeof window !== "undefined" && window.innerWidth < 1100 ? "edit" : "split"
);
const metaOpen = ref(false);
const versionsOpen = ref(false);
const siteUrl = (import.meta.env.VITE_SITE_URL || "").replace(/\/$/, "");

const statusText = computed(() => {
  if (!detail.value) return "";
  const base = detail.value.status === "published" ? "已发布" : "未发布";
  return detail.value.hasUnpublishedChanges ? `${base} · 有未发布修改` : base;
});

const guard = useUnsavedGuard({
  subject: () => `这篇${resLabel.value}`,
  // 无论从哪条路径确认“暂存草稿并离开”（返回按钮、侧栏菜单、路由跳转），
  // 都当场把编辑框内容写进草稿箱，兑现“暂存”承诺。
  // 返回写入是否成功：守卫据此决定能否放行离开（失败必须拦住）。
  onLeave: () => {
    if (dirty.value) return persistDraft();
    return true;
  }
});

// 把“有未保存修改”这个判断交给守卫，离开页面（关闭标签、点菜单）时才拦得住
watch(dirty, value => (value ? guard.markDirty() : guard.markClean()));
watch(saving, value => (guard.saving.value = value));

async function goBack() {
  // confirmLeave 在站长选择“暂存草稿并离开”时已通过 onLeave 存了草稿；
  // 这里 markClean 是为了避免 router.push 再触发 onBeforeRouteLeave 弹第二次确认框。
  const ok = await guard.confirmLeave();
  if (!ok) return;
  guard.markClean();
  router.push(listPath.value);
}

/**
 * 恢复历史版本的“恢复前编排”（由 VersionHistory 在发恢复请求前 await 调用）。
 *
 * 契约：恢复必须先保留当前工作稿再形成新工作稿。因此在任何恢复请求发出前：
 * 1. 先确认（取消/关闭/Esc 都停止恢复，编辑框内容原样保留，绝不解释成丢弃）；
 * 2. 确认后进入恢复事务：暂停自动保存定时器与防抖暂存，等待在途保存完成；
 * 3. 有未保存内容则执行可等待的手动保存；只有真正保存成功才用**最新 revision**
 *    放行恢复；校验失败/网络错误/409 冲突都立即停止，不发恢复请求、不覆盖表单。
 */
const restoreBusy = ref(false);

async function beforeRestore(): Promise<{
  ok: boolean;
  baseRevision?: number;
  reason?: string;
}> {
  if (!detail.value) return { ok: false, reason: "文章还没加载完" };
  restoreBusy.value = true;
  // 暂停会插队的自动保存/防抖暂存定时器；事务结束或失败后再恢复
  window.clearTimeout(autoTimer);
  window.clearTimeout(vaultTimer);
  try {
    const needSave = dirty.value;
    try {
      await ElMessageBox.confirm(
        needSave
          ? "编辑框里还有未保存的修改。恢复会先把它们保存为服务端工作稿（当前稿会保留在历史版本中），再用所选版本替换；线上发布内容和可见范围不变。"
          : "恢复会用所选版本替换当前工作稿，当前稿会保留在历史版本中；线上发布内容和可见范围不变。",
        "恢复这个版本",
        {
          type: "warning",
          confirmButtonText: needSave ? "保存当前稿并恢复" : "恢复为新工作稿",
          cancelButtonText: "取消",
          distinguishCancelAndClose: true
        }
      );
    } catch {
      // 取消 / 关闭 / Esc：停止恢复，编辑框内容原样保留
      return { ok: false };
    }
    if (needSave) {
      const saved = await ensureSaved();
      if (saved !== "saved") {
        return {
          ok: false,
          reason: "当前修改没有保存成功，已取消恢复。请先解决保存问题再试。"
        };
      }
    } else {
      // 无未保存修改，但可能有在途请求：等它结束，避免旧响应在恢复后反写
      await awaitSaveIdle();
    }
    if (!detail.value) return { ok: false };
    return { ok: true, baseRevision: detail.value.revision };
  } finally {
    restoreBusy.value = false;
  }
}

/**
 * 恢复结果落到编辑框。
 * 不再做“恢复成功后问是否暂存”：当前稿已在恢复前保存到服务端历史，
 * 本地草稿此时指向旧内容，属于已消费的冗余，直接清掉。
 */
function onRestored(data: ArticleDetail) {
  applyDetail(data);
  clearDraft(vaultKey.value);
}

function openSite() {
  if (!siteUrl || !detail.value) return;
  const path = detail.value.status === "published" ? "published" : "working";
  window.open(
    `${siteUrl}/${res.value}/${encodeURIComponent(detail.value.id)}/?source=${path}`,
    "_blank",
    "noopener"
  );
}

watch(
  () => [res.value, articleId.value],
  () => {
    // 切文章：清掉上一轮的定时器，避免串写。
    // 在途保存请求由 runSave 内的 forArticle 守卫丢弃，无需额外取消。
    window.clearTimeout(autoTimer);
    window.clearTimeout(vaultTimer);
    conflictOpen.value = false;
    void load();
  }
);

onMounted(async () => {
  capabilities.ensure();
  await load();
  try {
    options.value = await getContentOptions(res.value);
  } catch {
    options.value = { categories: [], tags: [] };
  }
});

onBeforeUnmount(() => {
  window.clearTimeout(autoTimer);
  window.clearTimeout(vaultTimer);
});
</script>

<template>
  <div class="ed">
    <header class="ed__bar">
      <button type="button" class="ed__back" @click="goBack">← 返回列表</button>
      <span class="ed__crumb ws-mono">{{ resLabel }} / {{ articleId }}</span>
      <span class="ws-toolbar__spacer" />

      <span class="ed__state" :class="`is-${saveState}`">{{ saveLabel }}</span>
      <el-button
        size="small"
        :loading="saving"
        :disabled="loading || !detail"
        @click="save('manual')"
      >
        保存草稿
      </el-button>
      <el-button
        size="small"
        type="primary"
        :disabled="!publishReady || loading"
        @click="publishOpen = true"
      >
        {{ detail?.status === "published" ? "更新发布" : "发布" }}
      </el-button>
      <el-dropdown trigger="click">
        <el-button size="small">更多</el-button>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item @click="metaOpen = true"
              >文章信息</el-dropdown-item
            >
            <el-dropdown-item @click="versionsOpen = true"
              >历史版本</el-dropdown-item
            >
            <el-dropdown-item
              v-if="detail"
              :disabled="detail.visibility === 'public'"
              @click="openVisibility('public')"
            >
              改为公开
            </el-dropdown-item>
            <el-dropdown-item
              v-if="detail"
              :disabled="detail.visibility === 'private'"
              @click="openVisibility('private')"
            >
              改为私密
            </el-dropdown-item>
            <el-dropdown-item
              v-if="detail?.status === 'published'"
              @click="unpublish"
            >
              撤回发布
            </el-dropdown-item>
            <el-dropdown-item
              :disabled="exporting"
              @click="exportAs('md', 'working')"
            >
              导出 Markdown（工作稿）
            </el-dropdown-item>
            <el-dropdown-item
              v-if="detail?.status === 'published'"
              :disabled="exporting"
              @click="exportAs('md', 'published')"
            >
              导出 Markdown（线上）
            </el-dropdown-item>
            <el-dropdown-item
              :disabled="exporting"
              divided
              @click="exportAs('zip', 'working')"
            >
              导出资源包 zip
            </el-dropdown-item>
            <el-dropdown-item v-if="siteUrl" @click="openSite">
              在线站点查看
            </el-dropdown-item>
            <el-dropdown-item divided @click="removeArticle">
              <span class="ed__danger">删除这篇文章</span>
            </el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
    </header>

    <div v-if="loading" class="ed__loading">
      <el-skeleton :rows="8" animated />
    </div>

    <div v-else-if="loadError" class="ed__loading">
      <p class="ws-hint ws-hint--danger">{{ loadError }}</p>
      <el-button size="small" @click="load">重试</el-button>
      <el-button size="small" @click="goBack">返回列表</el-button>
    </div>

    <template v-else>
      <section class="ed__head">
        <input
          v-model="form.title"
          class="ed__title"
          maxlength="200"
          placeholder="标题"
          @keydown.enter.prevent
        />
        <div class="ed__badges">
          <StatusPill v-if="detail" :value="detail.status" kind="publication" />
          <StatusPill
            v-if="detail"
            :value="detail.visibility"
            kind="visibility"
          />
          <span
            v-if="detail?.hasUnpublishedChanges"
            class="ws-pill ws-pill--warn"
          >
            工作稿与线上不同
          </span>
          <span class="ws-hint">{{ statusText }}</span>
          <span class="ws-toolbar__spacer" />
          <span class="ws-hint">
            {{ bodyChars }} 字 · {{ formatBytes(bodyBytes) }} /
            {{ formatBytes(capabilities.maxBodyBytes) }}
          </span>
          <el-segmented
            v-model="viewMode"
            size="small"
            :options="[
              { label: '并排', value: 'split' },
              { label: '编辑', value: 'edit' },
              { label: '预览', value: 'preview' }
            ]"
          />
        </div>
        <p v-if="bodyTooLarge" class="ws-hint ws-hint--danger">
          正文超过了服务端的
          {{ formatBytes(capabilities.maxBodyBytes) }} 上限，保存会被拒绝。
        </p>
      </section>

      <section class="ed__body" :class="`is-${viewMode}`">
        <div v-show="viewMode !== 'preview'" class="ed__pane ed__pane--edit">
          <MarkdownEditor v-model="form.body" @save="save('manual')" />
        </div>
        <div v-show="viewMode !== 'edit'" class="ed__pane ed__pane--preview">
          <div class="ed__pane-head">
            <span class="ws-panel__title">预览</span>
            <span class="ws-hint"
              >与前台同一套渲染管线，公式、表格、任务列表都按线上样式</span
            >
          </div>
          <div class="ed__preview-scroll">
            <MarkdownView :body="form.body" />
          </div>
        </div>
      </section>
    </template>

    <el-drawer v-model="metaOpen" title="文章信息" size="min(94vw, 480px)">
      <div class="meta">
        <el-form label-position="top" size="small">
          <el-form-item
            :label="`摘要（发布前必填，≤${capabilities.maxSummaryChars} 字）`"
          >
            <el-input
              v-model="form.summary"
              type="textarea"
              :rows="3"
              :maxlength="capabilities.maxSummaryChars"
              show-word-limit
              placeholder="列表和分享卡片上显示的两三行话"
            />
          </el-form-item>
          <el-form-item label="分类">
            <el-select
              v-model="form.category"
              filterable
              allow-create
              clearable
              placeholder="选一个已有分类，或直接输入新的"
              style="width: 100%"
            >
              <el-option
                v-for="category in options.categories"
                :key="category"
                :label="category"
                :value="category"
              />
            </el-select>
          </el-form-item>
          <el-form-item label="标签">
            <el-select
              v-model="form.tags"
              multiple
              filterable
              allow-create
              default-first-option
              placeholder="回车添加，最多 20 个"
              style="width: 100%"
            >
              <el-option
                v-for="tag in options.tags"
                :key="tag"
                :label="tag"
                :value="tag"
              />
            </el-select>
          </el-form-item>
          <el-form-item class="meta__pair">
            <div>
              <p class="ws-meta__label">写作日期</p>
              <el-date-picker
                v-model="form.date"
                type="date"
                value-format="YYYY-MM-DD"
                placeholder="可空"
                style="width: 100%"
              />
            </div>
            <div>
              <p class="ws-meta__label">展示用更新日期</p>
              <el-date-picker
                v-model="form.updated"
                type="date"
                value-format="YYYY-MM-DD"
                placeholder="可空，前台公开字段"
                style="width: 100%"
              />
            </div>
          </el-form-item>
          <template v-if="isEssay">
            <el-form-item label="心境（≤20 字）">
              <el-input
                v-model="form.mood"
                maxlength="20"
                show-word-limit
                placeholder="例如：微凉、笃定"
              />
            </el-form-item>
            <el-form-item label="地点（≤100 字）">
              <el-input
                v-model="form.place"
                maxlength="100"
                show-word-limit
                placeholder="例如：杭州 · 苕溪"
              />
            </el-form-item>
          </template>
          <p class="ws-hint">
            ID
            <span class="ws-mono">{{ detail?.id }}</span>
            创建后固定，不随标题变化。
            修改以上信息只会更新工作稿，发布之后前台才会变。
          </p>
        </el-form>

        <hr class="ws-rule" />
        <div class="meta__assets">
          <p class="ws-panel__title">正文引用的资源</p>
          <p v-if="!detail?.assets?.length" class="ws-hint">
            这篇还没有引用任何文件。在编辑器里点「图片／附件」就能插入。
          </p>
          <div
            v-for="asset in detail?.assets ?? []"
            :key="asset.fileId"
            class="meta__asset"
          >
            <AssetImage
              v-if="asset.kind === 'image'"
              :file-id="asset.visibility === 'private' ? asset.fileId : null"
              :src="asset.publicSrc"
              :alt="asset.name"
              aspect="1 / 1"
              class="meta__thumb"
            />
            <div class="min-w-0">
              <p class="ws-cell-title truncate">{{ asset.name }}</p>
              <p class="ws-cell-sub">
                <StatusPill :value="asset.visibility" kind="visibility" />
                <span class="ws-hint ws-mono">asset:{{ asset.fileId }}</span>
              </p>
            </div>
            <el-button
              link
              size="small"
              @click="
                fetchFileBlob(asset.fileId)
                  .then(r => saveBlob(r.blob, r.filename || asset.name))
                  .catch(() => message('下载失败', { type: 'error' }))
              "
            >
              下载
            </el-button>
          </div>
        </div>
      </div>
    </el-drawer>

    <PublishDialog
      v-model="publishOpen"
      :check="doCheck"
      :publish="doPublish"
      :base-revision="detail?.revision ?? 0"
      :subject="`这篇${resLabel}`"
      :notice="publishNotice"
      @published="onPublished"
      @stale="reopenAfterStale"
    />

    <PublishDialog
      v-model="visibilityOpen"
      action="visibility"
      :target-visibility="visibilityTarget"
      :check="doCheck"
      :publish="applyVisibility"
      :base-revision="detail?.revision ?? 0"
      :subject="`这篇${resLabel}`"
      :notice="visibilityNotice"
      @published="onVisibilityApplied"
      @stale="reopenAfterStale"
    />

    <ConflictDialog
      v-model="conflictOpen"
      :subject="`这篇${resLabel}`"
      :server-revision="conflictServer?.revision ?? null"
      :server-updated-at="
        conflictServer ? formatDateTime(conflictServer.updatedAt) : null
      "
      :local-title="form.title"
      :server-title="conflictServer?.title ?? ''"
      :saving="overwriting"
      @discard="discardMine"
      @overwrite="overwriteMine"
      @compare="compareOpen = true"
    />

    <el-dialog
      v-model="compareOpen"
      title="与线上工作稿的差异"
      width="min(94vw, 760px)"
      append-to-body
    >
      <p class="ws-hint">
        方向是「线上 →
        我现在的内容」。红色是线上有、你这里已经改掉的；绿色是你新写的。
      </p>
      <pre
        class="ed__diff"
      ><template v-for="(part, index) in conflictDiff" :key="index"><span
        :class="part.added ? 'ed__diff-add' : part.removed ? 'ed__diff-del' : ''"
      >{{ part.value }}</span></template></pre>
      <template #footer>
        <el-button @click="compareOpen = false">关闭</el-button>
        <el-button @click="discardMine">放弃我的，载入线上</el-button>
        <el-button type="primary" :loading="overwriting" @click="overwriteMine">
          用我的覆盖
        </el-button>
      </template>
    </el-dialog>

    <VersionHistory
      v-if="detail"
      v-model="versionsOpen"
      :res="res"
      :article-id="articleId"
      :current-body="form.body"
      :current-title="form.title"
      :current-summary="form.summary || null"
      :current-revision="detail.revision"
      :before-restore="beforeRestore"
      @restored="onRestored"
    />
  </div>
</template>

<style scoped>
.ed {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px 18px 24px;
}

.ed__bar {
  position: sticky;
  top: 0;
  z-index: 12;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  padding: 8px 12px;
  background: color-mix(in srgb, var(--void) 88%, transparent);
  border: 1px solid var(--line);
  border-radius: 12px;
  backdrop-filter: blur(12px);
}

.ed__back {
  font: inherit;
  font-size: 12.5px;
  color: var(--bone-2);
  cursor: pointer;
  background: none;
  border: 0;
}

.ed__back:hover {
  color: var(--sol);
}

.ed__crumb {
  font-size: 11.5px;
  color: var(--ash);
}

.ed__state {
  font-size: 12px;
  color: var(--ash);
}

.ed__state.is-dirty {
  color: var(--sol);
}

.ed__state.is-saving {
  color: var(--glacier);
}

.ed__state.is-error {
  color: var(--ember);
}

.ed__state.is-saved {
  color: #8fd3a2;
}

.ed__loading {
  display: flex;
  flex-direction: column;
  gap: 10px;
  align-items: flex-start;
  padding: 24px;
  background: var(--slab);
  border: 1px solid var(--line);
  border-radius: 14px;
}

.ed__head {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.ed__title {
  width: 100%;
  padding: 6px 2px;
  font-family: var(--font-display);
  font-size: clamp(22px, 3vw, 32px);
  line-height: 1.25;
  color: var(--bone);
  outline: none;
  background: transparent;
  border: 0;
  border-bottom: 1px solid var(--line);
}

.ed__title:focus {
  border-bottom-color: color-mix(in srgb, var(--sol) 55%, transparent);
}

.ed__badges {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}

.ed__body {
  display: grid;
  gap: 14px;
  min-height: 0;
}

.ed__body.is-split {
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
}

.ed__body.is-edit,
.ed__body.is-preview {
  grid-template-columns: minmax(0, 1fr);
}

.ed__pane {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 520px;
  background: var(--slab);
  border: 1px solid var(--line);
  border-radius: 14px;
}

.ed__pane--edit {
  padding: 4px;
}

.ed__pane--preview {
  padding: 10px 4px 10px 10px;
}

.ed__pane-head {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: baseline;
  justify-content: space-between;
  padding: 2px 8px 8px;
}

.ed__preview-scroll {
  flex: 1 1 auto;
  min-height: 0;
  padding: 0 10px 16px;
  overflow-y: auto;
}

.ed__diff {
  max-height: 52vh;
  padding: 12px;
  overflow: auto;
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.7;
  color: var(--bone-2);
  white-space: pre-wrap;
  background: rgb(3 4 10 / 55%);
  border: 1px solid var(--line);
  border-radius: 10px;
}

.ed__diff-add {
  color: #8fd3a2;
  background: rgb(143 211 162 / 8%);
}

.ed__diff-del {
  color: #e79a7d;
  background: rgb(231 154 125 / 8%);
}

.ed__danger {
  color: var(--ember);
}

.meta {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.meta__pair {
  display: flex;
  gap: 12px;
}

.meta__pair > div {
  flex: 1 1 0;
  min-width: 0;
}

.meta__assets {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.meta__asset {
  display: flex;
  gap: 10px;
  align-items: center;
  padding: 8px 10px;
  background: rgb(239 232 218 / 3%);
  border: 1px solid var(--line);
  border-radius: 10px;
}

.meta__thumb {
  flex: 0 0 44px;
  width: 44px;
}

.truncate {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

@media (width <= 1100px) {
  .ed {
    padding: 10px 12px 20px;
  }

  .ed__pane {
    min-height: 420px;
  }
}
</style>
