<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import { ElMessageBox } from "element-plus";
import {
  getCloudflareEvents,
  getSecuritySummary,
  listLogs
} from "@/api/logs";
import type {
  CloudflareView,
  LogEntry,
  LogKind,
  LogLevel,
  LogPage,
  LogQuery,
  LogSource,
  SecurityBucket,
  SecuritySummary
} from "@/api/types";
import {
  LOG_KIND_LABEL,
  LOG_LEVEL_LABEL,
  SECURITY_WINDOWS
} from "@/api/types";
import { formatDateTime } from "@/utils/format";
import { saveBlob } from "@/utils/media";
import { message } from "@/utils/message";
import PageHeader from "@/components/Manager/PageHeader.vue";
import EmptyState from "@/components/Manager/EmptyState.vue";

/**
 * 日志中心。
 *
 * 三件事要说在前面，界面上也照这个口径写：
 *  1. 这是**只读**的观测窗口，没有任何删除／清空按钮。能删日志的后台，等于帮入侵者擦脚印。
 *  2. 程序日志与 Nginx 日志都只读**尾部**（后端最多读最后 512KB），更早的记录在服务器上按日轮转，
 *     页面上的「共 N 条」是这段窗口里的条数，不是全部历史。
 *  3. 这里的 IP、UA 是访客的隐私数据，别把整张表随意外发。
 */

const KIND_TONE: Record<LogKind, string> = {
  access: "ws-pill--mute",
  error: "ws-pill--warn",
  app: "ws-pill--public",
  backup: "ws-pill--draft"
};

const LEVEL_TONE: Record<LogLevel, string> = {
  debug: "ws-pill--mute",
  info: "ws-pill--public",
  warn: "ws-pill--warn",
  error: "ws-pill--danger"
};

const TAIL_OPTIONS = [200, 500, 1000, 2000];

/**
 * Cloudflare 的 action 是英文枚举（block / challenge / managedChallenge / jsChallenge…），
 * 原样铺进表格会把 120px 的列撑破。这里只翻常见几个，没见过的保留原文，
 * 免得 Cloudflare 新增一种动作时界面显示空白。
 */
const CF_ACTION_LABEL: Record<string, string> = {
  block: "拦截",
  challenge: "挑战",
  managedChallenge: "托管挑战",
  jsChallenge: "JS 挑战",
  jschallenge: "JS 挑战",
  allow: "放行",
  log: "仅记录",
  skip: "跳过"
};

const cfActionLabel = (action: string) =>
  CF_ACTION_LABEL[action] ?? CF_ACTION_LABEL[action.toLowerCase()] ?? action;

/* ------------------------------ 访问／程序日志 ------------------------------ */

const query = reactive<LogQuery>({
  source: "",
  tail: 200,
  keyword: "",
  level: undefined,
  status: undefined,
  suspect: false
});

const page = ref<LogPage | null>(null);
const loading = ref(false);
const loadError = ref("");
const sources = ref<LogSource[]>([]);

const items = computed<LogEntry[]>(() => page.value?.items ?? []);

/**
 * 前端分页。后端返回的是「尾部 N 条」，最多 2000 行：
 * 一次性铺进 el-table 会让浏览器卡住，所以只渲染当前页，
 * 但「共 N 条」「导出」「统计」都按完整的这一批算，不按当前页算。
 */
const pageSize = 50;
const currentPage = ref(1);
const pagedItems = computed(() => {
  const start = (currentPage.value - 1) * pageSize;
  return items.value.slice(start, start + pageSize);
});
const suspiciousCount = computed(
  () => items.value.filter(item => item.suspect).length
);

async function load() {
  loading.value = true;
  loadError.value = "";
  try {
    const result = await listLogs(query);
    page.value = result;
    currentPage.value = 1;
    if (result.sources.length) sources.value = result.sources;
  } catch (error) {
    // 后端没部署或 nginx 日志读不到时，接口会整体失败：
    // 这里保留上一份数据，只把错误写在页面上，不清空成空白让人以为「真的没有日志」。
    loadError.value = (error as { message?: string })?.message ?? "读取失败";
  } finally {
    loading.value = false;
  }
}

/** 清空筛选后重查（下拉里「全部来源」是空字符串，直接清 query 再调） */
function resetFilters() {
  query.source = "";
  query.keyword = "";
  query.level = undefined;
  query.status = undefined;
  query.suspect = false;
  load();
}

function statusTone(status: number | null) {
  if (status === null) return "ws-pill--mute";
  if (status >= 500) return "ws-pill--danger";
  if (status >= 400) return "ws-pill--warn";
  return "ws-pill--public";
}

/* ------------------------------ 自动刷新 ------------------------------ */

const autoRefresh = ref(false);
const REFRESH_MS = 15000;
let timer: ReturnType<typeof setInterval> | null = null;

function stopTimer() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

function toggleAutoRefresh(value: boolean) {
  stopTimer();
  if (!value) return;
  timer = setInterval(() => {
    if (document.hidden) return; // 切到后台就别再打服务器了
    load();
    if (tab.value === "security") loadSecurity();
  }, REFRESH_MS);
}

/* ------------------------------ 攻击面 ------------------------------ */

const tab = ref("access");
const securityHours = ref(24);
const security = ref<SecuritySummary | null>(null);
const securityLoading = ref(false);

async function loadSecurity() {
  securityLoading.value = true;
  try {
    security.value = await getSecuritySummary(securityHours.value);
  } catch {
    security.value = null;
  } finally {
    securityLoading.value = false;
  }
}

function pickWindow(hours: number) {
  securityHours.value = hours;
  loadSecurity();
  loadCloudflare();
}

/* ------------------------------ Cloudflare ------------------------------ */

const cloudflare = ref<CloudflareView | null>(null);
const cloudflareLoading = ref(false);

async function loadCloudflare() {
  cloudflareLoading.value = true;
  try {
    cloudflare.value = await getCloudflareEvents(securityHours.value);
  } catch {
    cloudflare.value = null;
  } finally {
    cloudflareLoading.value = false;
  }
}

/* ------------------------------ 导出 ------------------------------ */

/**
 * 只导出当前屏幕上这一批（过滤后的尾部日志）。
 * 不做「导出全部历史」：那需要后端支持翻页读整个文件，而日志里有访客 IP，
 * 一次性全量下载的风险与收益不成比例。
 */
function exportCurrent() {
  if (!items.value.length) {
    message("当前没有可导出的日志", { type: "warning" });
    return;
  }
  const header = ["时间", "来源", "级别", "状态", "方法", "路径", "IP", "摘要"];
  const escape = (value: unknown) => {
    const text = value === null || value === undefined ? "" : String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const rows = items.value.map(item =>
    [
      item.time ?? "",
      item.sourceLabel,
      item.level ? LOG_LEVEL_LABEL[item.level] : "",
      item.status ?? "",
      item.method ?? "",
      item.path ?? "",
      item.ip ?? "",
      item.message
    ]
      .map(escape)
      .join(",")
  );
  const csv = `\ufeff${[header.join(","), ...rows].join("\r\n")}`;
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  saveBlob(new Blob([csv], { type: "text/csv;charset=utf-8" }), `logs-${stamp}.csv`);
  message("已导出当前筛选结果", { type: "success" });
}

/* ------------------------------ 行展开 ------------------------------ */

const expanded = ref<string[]>([]);

function toggleDetail(row: LogEntry) {
  const index = expanded.value.indexOf(row.id);
  if (index >= 0) expanded.value.splice(index, 1);
  else expanded.value.push(row.id);
}

async function confirmRequestAccess() {
  await ElMessageBox.alert(
    "这一页只读：不会改动、删除或轮转任何日志文件。要清空历史请登录服务器，按 logrotate 的配置处理。",
    "关于只读",
    { confirmButtonText: "知道了", type: "info" }
  );
}

onMounted(() => {
  load();
  loadSecurity();
  loadCloudflare();
});

onBeforeUnmount(stopTimer);
</script>

<template>
  <div class="ws-page">
    <PageHeader
      eyebrow="Logs"
      title="日志中心"
      subtitle="服务器上的原始日志：谁访问了什么、程序报了什么错、Cloudflare 拦了什么。这里只读——能删日志的后台，等于给入侵者递了块抹布。"
    >
      <template #actions>
        <el-button size="small" @click="confirmRequestAccess">只读说明</el-button>
        <el-button
          type="primary"
          size="small"
          :loading="loading"
          @click="load"
          >刷新</el-button
        >
      </template>
    </PageHeader>

    <p v-if="loadError" class="ws-hint ws-hint--danger">
      读取日志失败：{{ loadError }}
      <span class="ws-hint">
        （多半是后端还没重启、或运行用户不在 adm 组里读不到 nginx 日志）
      </span>
    </p>

    <section class="ws-panel">
      <div class="ws-toolbar">
        <el-select
          v-model="query.source"
          size="small"
          placeholder="全部来源"
          clearable
          style="width: 150px"
          @change="load"
        >
          <el-option
            v-for="item in sources"
            :key="item.id"
            :label="item.label"
            :value="item.id"
          />
        </el-select>
        <el-select
          v-model="query.level"
          size="small"
          placeholder="全部级别"
          clearable
          style="width: 120px"
          @change="load"
        >
          <el-option
            v-for="(label, value) in LOG_LEVEL_LABEL"
            :key="value"
            :label="label"
            :value="value"
          />
        </el-select>
        <el-input
          v-model="query.status"
          size="small"
          clearable
          placeholder="状态码"
          style="width: 100px"
          @keyup.enter="load"
          @clear="load"
        />
        <el-input
          v-model="query.keyword"
          size="small"
          clearable
          placeholder="搜路径、IP、内容"
          style="max-width: 200px"
          @keyup.enter="load"
          @clear="load"
        />
        <el-checkbox v-model="query.suspect" size="small" @change="load"
          >只看疑似攻击</el-checkbox
        >
        <el-select
          v-model="query.tail"
          size="small"
          style="width: 110px"
          @change="load"
        >
          <el-option
            v-for="n in TAIL_OPTIONS"
            :key="n"
            :label="`尾部 ${n} 条`"
            :value="n"
          />
        </el-select>
        <span class="ws-toolbar__spacer" />
        <span class="ws-hint">
          共 {{ page?.total ?? 0 }} 条 / 已载入 {{ items.length }}
          <template v-if="page?.truncated">
            · 只读了文件尾部，更早的请上服务器看
          </template>
        </span>
      </div>

      <div class="ws-toolbar">
        <el-switch
          v-model="autoRefresh"
          size="small"
          :active-text="`自动刷新（${REFRESH_MS / 1000}s）`"
          @change="v => toggleAutoRefresh(Boolean(v))"
        />
        <span v-if="page?.generatedAt" class="ws-hint">
          抓取于 {{ formatDateTime(page.generatedAt) }}
        </span>
        <span class="ws-toolbar__spacer" />
        <el-button size="small" :disabled="!items.length" @click="exportCurrent"
          >导出当前结果</el-button
        >
        <el-button size="small" @click="resetFilters">清空筛选</el-button>
      </div>

      <el-table
        v-loading="loading"
        :data="pagedItems"
        size="small"
        row-key="id"
        class="ws-table"
        :row-class-name="({ row }) => (row.suspect ? 'is-suspect' : '')"
      >
        <el-table-column label="时间" width="150">
          <template #default="{ row }">
            <span class="ws-hint">{{ formatDateTime(row.time) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="来源" width="110">
          <template #default="{ row }">
            <span class="ws-pill" :class="KIND_TONE[row.kind as LogKind]">
              {{ row.sourceLabel }}
            </span>
          </template>
        </el-table-column>
        <el-table-column label="级别" width="88">
          <template #default="{ row }">
            <span
              v-if="row.level"
              class="ws-pill"
              :class="LEVEL_TONE[row.level as LogLevel]"
            >
              {{ LOG_LEVEL_LABEL[row.level as LogLevel] }}
            </span>
            <span v-else class="ws-hint">—</span>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="76">
          <template #default="{ row }">
            <span class="ws-pill" :class="statusTone(row.status as number)">
              {{ row.status ?? "—" }}
            </span>
          </template>
        </el-table-column>
        <el-table-column label="请求" min-width="260">
          <template #default="{ row }">
            <p class="ws-cell-title ws-mono">
              <span v-if="row.method" class="ws-hint">{{ row.method }} </span>
              {{ row.path ?? "—" }}
            </p>
            <p class="ws-cell-sub">{{ row.message }}</p>
          </template>
        </el-table-column>
        <el-table-column label="IP" width="140">
          <template #default="{ row }">
            <span class="ws-mono ws-hint">{{ row.ip ?? "—" }}</span>
          </template>
        </el-table-column>
        <el-table-column label="标记" width="88">
          <template #default="{ row }">
            <span v-if="row.suspect" class="ws-pill ws-pill--danger"
              >疑似</span
            >
            <span v-else class="ws-hint">—</span>
          </template>
        </el-table-column>
        <el-table-column label="详情" width="76" fixed="right">
          <template #default="{ row }">
            <el-button link size="small" @click="toggleDetail(row)">
              {{ expanded.includes(row.id) ? "收起" : "展开" }}
            </el-button>
          </template>
        </el-table-column>
        <template #empty>
          <EmptyState
            v-if="loadError"
            glyph="⚠"
            title="读不到日志"
            description="后端 /api/admin/logs 没有响应。先确认新版本已部署，且 entroaxiom 用户在 adm 组里。"
            action-text="重试"
            @action="load"
          />
          <EmptyState
            v-else
            glyph="⌕"
            title="这段时间没有日志"
            description="换个来源或清空筛选看看；如果服务器刚部署，日志要等第一次请求之后才会出现。"
            action-text="清空筛选"
            @action="resetFilters"
          />
        </template>
      </el-table>

      <div v-if="items.length > pageSize" class="logs-pager">
        <el-pagination
          v-model:current-page="currentPage"
          :page-size="pageSize"
          :total="items.length"
          layout="prev, pager, next, jumper, total"
          small
          background
        />
      </div>

      <div v-if="expanded.length" class="logs-detail">
        <article v-for="row in pagedItems" :key="row.id">
          <template v-if="expanded.includes(row.id)">
            <p class="ws-cell-title ws-mono">
              {{ row.sourceLabel }} · {{ formatDateTime(row.time) }}
            </p>
            <pre class="logs-detail__body">{{ row.detail }}</pre>
          </template>
        </article>
      </div>

      <p class="ws-hint logs-note">
        共 {{ suspiciousCount }} 条疑似攻击记录在本次结果里。判定依据是扫描器常打的路径
        （<code>.env</code>、<code>.git</code>、<code>wp-admin</code> 等）与 401/403/429
        这类拦截状态；普通 404 不算攻击。
      </p>
    </section>

    <section class="ws-panel">
      <div class="ws-toolbar">
        <span class="ws-title">攻击面概览</span>
        <el-select
          v-model="securityHours"
          size="small"
          style="width: 130px"
          @change="(v: number) => pickWindow(v)"
        >
          <el-option
            v-for="hours in SECURITY_WINDOWS"
            :key="hours"
            :label="`近 ${hours} 小时`"
            :value="hours"
          />
        </el-select>
        <span class="ws-toolbar__spacer" />
        <span class="ws-hint">
          统计范围 {{ LOG_KIND_LABEL.access }} + {{ LOG_KIND_LABEL.app }} +
          {{ LOG_KIND_LABEL.error }} 三类日志里的疑似记录
        </span>
      </div>

      <div v-loading="securityLoading" class="ws-stats">
        <div class="ws-stat">
          <p class="ws-stat__label">疑似请求</p>
          <p class="ws-stat__value">{{ security?.total ?? 0 }}</p>
        </div>
        <div class="ws-stat">
          <p class="ws-stat__label">独立 IP</p>
          <p class="ws-stat__value">{{ security?.ips.length ?? 0 }}</p>
        </div>
        <div class="ws-stat">
          <p class="ws-stat__label">被探测路径</p>
          <p class="ws-stat__value">{{ security?.paths.length ?? 0 }}</p>
        </div>
        <div class="ws-stat">
          <p class="ws-stat__label">拦截类状态</p>
          <p class="ws-stat__value">{{ security?.statuses.length ?? 0 }}</p>
        </div>
      </div>

      <div class="ws-split">
        <div>
          <p class="ws-sub">最常来的 IP</p>
          <el-table
            :data="(security?.ips ?? []).slice(0, 10)"
            size="small"
            class="ws-table"
          >
            <el-table-column
              prop="key"
              label="IP"
              min-width="130"
              class-name="ws-mono"
            />
            <el-table-column prop="count" label="次数" width="80" />
            <el-table-column label="最近" width="150">
              <template #default="{ row }">
                <span class="ws-hint">{{
                  formatDateTime((row as SecurityBucket).lastSeen)
                }}</span>
              </template>
            </el-table-column>
          </el-table>
        </div>
        <div>
          <p class="ws-sub">被探测最多的路径</p>
          <el-table
            :data="(security?.paths ?? []).slice(0, 10)"
            size="small"
            class="ws-table"
          >
            <el-table-column
              prop="key"
              label="路径"
              min-width="180"
              class-name="ws-mono"
            />
            <el-table-column prop="count" label="次数" width="80" />
            <el-table-column label="最近" width="150">
              <template #default="{ row }">
                <span class="ws-hint">{{
                  formatDateTime((row as SecurityBucket).lastSeen)
                }}</span>
              </template>
            </el-table-column>
          </el-table>
        </div>
      </div>
    </section>

    <section class="ws-panel">
      <div class="ws-toolbar">
        <span class="ws-title">Cloudflare 拦截</span>
        <span class="ws-toolbar__spacer" />
        <span v-if="cloudflare?.configured" class="ws-hint">
          拦截 {{ cloudflare.totals.blocked }} · 挑战
          {{ cloudflare.totals.challenged }} · 其他
          {{ cloudflare.totals.other }}
        </span>
        <el-button
          size="small"
          :loading="cloudflareLoading"
          @click="loadCloudflare"
          >重查</el-button
        >
      </div>

      <p
        v-if="cloudflare && !cloudflare.configured"
        class="ws-hint ws-hint--warn"
      >
        {{ cloudflare.note }}
      </p>

      <el-table
        v-loading="cloudflareLoading"
        :data="cloudflare?.events ?? []"
        size="small"
        row-key="datetime"
        class="ws-table"
      >
        <el-table-column label="时间" width="150">
          <template #default="{ row }">
            <span class="ws-hint">{{ formatDateTime(row.datetime) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="动作" width="130">
          <template #default="{ row }">
            <span class="ws-pill ws-pill--danger">{{
              cfActionLabel(row.action)
            }}</span>
          </template>
        </el-table-column>
        <el-table-column label="IP" width="140">
          <template #default="{ row }">
            <span class="ws-mono ws-hint">{{ row.clientIP ?? "—" }}</span>
          </template>
        </el-table-column>
        <el-table-column label="路径" min-width="200">
          <template #default="{ row }">
            <span class="ws-mono">{{ row.path ?? "—" }}</span>
          </template>
        </el-table-column>
        <el-table-column label="次数" width="80" prop="count" />
        <el-table-column label="规则" width="150">
          <template #default="{ row }">
            <!-- 规则 id 是 32 位十六进制，整串放不下会折成两行把行高撑开；
                 这里截断显示，完整值放进 title，需要时鼠标悬停即可看到。 -->
            <span class="ws-mono ws-hint cf-rule" :title="row.ruleId ?? ''">
              {{ row.ruleId ?? "—" }}
            </span>
          </template>
        </el-table-column>
        <template #empty>
          <EmptyState
            glyph="◔"
            title="没有拦截记录"
            description="要么这段时间真的没人来探路，要么 Cloudflare 那侧没配规则。这里只展示 CF 防火墙事件，不含应用层限流。"
          />
        </template>
      </el-table>
    </section>
  </div>
</template>

<style scoped>
.logs-pager {
  display: flex;
  justify-content: flex-end;
  padding-top: 12px;
}

.logs-detail {
  margin-top: 14px;
  display: grid;
  gap: 10px;
}

.logs-detail__body {
  margin: 6px 0 0;
  padding: 12px 14px;
  max-height: 260px;
  overflow: auto;
  font-size: 12px;
  line-height: 1.6;
  color: var(--el-text-color-regular);
  background: rgb(255 255 255 / 3%);
  border: 1px solid var(--line);
  border-radius: 10px;
  white-space: pre-wrap;
  word-break: break-all;
}

.logs-note {
  margin: 12px 0 0;
  line-height: 1.7;
}

.logs-note code {
  padding: 1px 5px;
  font-size: 11px;
  border-radius: 4px;
  background: rgb(255 255 255 / 6%);
}

.cf-rule {
  display: block;
  max-width: 150px;
  overflow: hidden;
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

:deep(.is-suspect) {
  background: rgb(239 132 86 / 6%);
}
</style>
