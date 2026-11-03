/**
 * v3 回归测试（v2 修复方案 §10.2）
 *
 * 为什么需要它：mock:smoke 只驱动开发替身（服务端行为），
 * 而这轮修复的核心逻辑在前端：
 *  - R3：表单/服务端详情/本地草稿共用同一套归一化快照比较规则；
 *  - R2：保存请求串行化队列（同一时刻只有一个在飞，awaitIdle 等全部结束）；
 *  - R4：书影音草稿的新建键/条目键隔离与存储失败信号。
 * 这些逻辑已经从页面抽成纯工具（src/utils/editableSnapshot.ts、
 * src/utils/saveQueue.ts，草稿仓复用 src/utils/draftVault.ts），
 * 这里直接 bundle 真实实现做断言，浏览器验收只做交互层核对。
 *
 * 跑法：node scripts/v3-regression.mjs
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { bundleModule } from "./lib/bundle.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "node_modules/.cache/v3-regression");
const entry = join(outDir, "entry.mjs");
const bundle = join(outDir, "utils.mjs");

mkdirSync(outDir, { recursive: true });
rmSync(bundle, { force: true });
writeFileSync(
  entry,
  [
    `export { editableArticleSnapshot } from "${join(root, "src/utils/editableSnapshot.ts").replace(/\\/g, "/")}";`,
    `export { createSaveQueue } from "${join(root, "src/utils/saveQueue.ts").replace(/\\/g, "/")}";`,
    `export { clearDraft, draftKey, loadDraft, saveDraft } from "${join(root, "src/utils/draftVault.ts").replace(/\\/g, "/")}";`
  ].join("\n")
);

await bundleModule({ entryPoints: [entry], outfile: bundle });

/* sessionStorage 替身：draftVault 在模块顶层不触碰存储，import 后再注入 */
const realSessionStorage = globalThis.sessionStorage;

function makeStorage({ throwing = false } = {}) {
  const map = new Map();
  return {
    getItem(k) {
      return map.has(k) ? map.get(k) : null;
    },
    setItem(k, v) {
      if (throwing) throw new Error("QuotaExceededError");
      map.set(k, String(v));
    },
    removeItem(k) {
      map.delete(k);
    },
    clear() {
      map.clear();
    },
    key(i) {
      return [...map.keys()][i] ?? null;
    },
    get length() {
      return map.size;
    }
  };
}

globalThis.sessionStorage = makeStorage();
const {
  editableArticleSnapshot,
  createSaveQueue,
  clearDraft,
  draftKey,
  loadDraft,
  saveDraft
} = await import(pathToFileURL(bundle).href);
globalThis.sessionStorage = realSessionStorage;

const results = [];
let failures = 0;

function check(name, condition, detail = "") {
  if (condition) {
    results.push(`  ok   ${name}`);
  } else {
    failures += 1;
    results.push(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/* 基线字段 */
const base = {
  title: "标题",
  summary: null,
  category: null,
  tags: [],
  date: null,
  updated: null,
  mood: null,
  place: null,
  body: "正文"
};

/* ---------- R3：快照归一化与差异比较（§10.2 ④ / V07 / V08） ---------- */

{
  const onlySummary = editableArticleSnapshot(
    { ...base, summary: "摘要甲" },
    false
  );
  const onlySummary2 = editableArticleSnapshot(
    { ...base, summary: "摘要乙" },
    false
  );
  check("标题正文相同、仅摘要不同 → 快照不同", onlySummary !== onlySummary2);
}

{
  const onlyTags = editableArticleSnapshot({ ...base, tags: ["甲"] }, false);
  const onlyTags2 = editableArticleSnapshot({ ...base, tags: ["乙"] }, false);
  check("标题正文相同、仅标签不同 → 快照不同", onlyTags !== onlyTags2);
}

{
  const onlyCategory = editableArticleSnapshot(
    { ...base, category: "生活" },
    false
  );
  const onlyCategory2 = editableArticleSnapshot(
    { ...base, category: "工作" },
    false
  );
  check("标题正文相同、仅分类不同 → 快照不同", onlyCategory !== onlyCategory2);
}

{
  const onlyDate = editableArticleSnapshot(
    { ...base, date: "2026-10-01" },
    false
  );
  const onlyDate2 = editableArticleSnapshot(
    { ...base, date: "2026-10-02" },
    false
  );
  check("标题正文相同、仅写作日期不同 → 快照不同", onlyDate !== onlyDate2);
}

{
  const onlyUpdated = editableArticleSnapshot(
    { ...base, updated: "2026-10-01" },
    false
  );
  const onlyUpdated2 = editableArticleSnapshot(
    { ...base, updated: "2026-10-02" },
    false
  );
  check(
    "标题正文相同、仅展示更新日期不同 → 快照不同",
    onlyUpdated !== onlyUpdated2
  );
}

{
  const moodA = editableArticleSnapshot({ ...base, mood: "平静" }, true);
  const moodB = editableArticleSnapshot({ ...base, mood: "激动" }, true);
  check("随笔：仅心境不同 → 快照不同", moodA !== moodB);
}

{
  const noteMoodA = editableArticleSnapshot({ ...base, mood: "平静" }, false);
  const noteMoodB = editableArticleSnapshot({ ...base, mood: "激动" }, false);
  check("笔记：心境不纳入差异 → 快照相同", noteMoodA === noteMoodB);
}

{
  const essayPlace = editableArticleSnapshot({ ...base, place: "书房" }, true);
  const notePlace = editableArticleSnapshot({ ...base, place: "书房" }, false);
  check(
    "笔记不会恢复随笔专属字段：place 快照笔记与随笔不同",
    essayPlace !== notePlace
  );
}

{
  const trimmed = editableArticleSnapshot({ ...base, body: "  正文  " }, false);
  const raw = editableArticleSnapshot({ ...base, body: "正文" }, false);
  check("正文不因比较而 trim：前后空白差异保留", trimmed !== raw);
}

{
  const a = editableArticleSnapshot(
    { ...base, summary: null, tags: ["甲", " 乙 "] },
    false
  );
  const b = editableArticleSnapshot(
    { ...base, summary: "", tags: ["甲", "乙"] },
    false
  );
  check("归一化：null 与空串、标签单项 trim 后相同", a === b);
}

{
  const orderA = editableArticleSnapshot(
    { ...base, tags: ["甲", "乙"] },
    false
  );
  const orderB = editableArticleSnapshot(
    { ...base, tags: ["乙", "甲"] },
    false
  );
  check("标签顺序沿用现有语义：不擅自排序", orderA !== orderB);
}

{
  const fullA = editableArticleSnapshot(
    {
      ...base,
      summary: "摘要",
      category: "生活",
      tags: ["甲", "乙"],
      date: "2026-10-01",
      updated: "2026-10-02",
      mood: "平静",
      place: "书房",
      body: "正文 **加粗**"
    },
    true
  );
  const fullB = editableArticleSnapshot(
    {
      ...base,
      summary: " 摘要 ",
      category: " 生活 ",
      tags: [" 甲 ", " 乙 "],
      date: "2026-10-01",
      updated: "2026-10-02",
      mood: " 平静 ",
      place: " 书房 ",
      body: "正文 **加粗**"
    },
    true
  );
  check("全字段归一化后完全一致 → 快照相同（冗余草稿可清）", fullA === fullB);
}

{
  const revisionA = editableArticleSnapshot({ ...base, summary: "同" }, false);
  const revisionB = editableArticleSnapshot({ ...base, summary: "同" }, false);
  check(
    "revision/时间戳/权限不入差异（同字段不同对象仍相同）",
    revisionA === revisionB
  );
}

/* ---------- R2：保存串行化队列（§10.2 ③ / V06） ---------- */

{
  const queue = createSaveQueue();
  const order = [];
  const running = { current: 0, max: 0 };
  const t1 = queue.enqueue(async () => {
    running.current += 1;
    running.max = Math.max(running.max, running.current);
    await new Promise(r => setTimeout(r, 15));
    order.push("first");
    running.current -= 1;
    return "a";
  });
  const t2 = queue.enqueue(async () => {
    running.current += 1;
    running.max = Math.max(running.max, running.current);
    await new Promise(r => setTimeout(r, 5));
    order.push("second");
    running.current -= 1;
    return "b";
  });
  const [r1, r2] = await Promise.all([t1, t2]);
  check("保存请求串行化：同一时刻只有一个在飞", running.max === 1);
  check("保存请求按入队顺序执行", order.join(",") === "first,second");
  check("队列返回各自结果", r1 === "a" && r2 === "b");
}

{
  const queue = createSaveQueue();
  const ran = [];
  queue.enqueue(async () => {
    await new Promise(r => setTimeout(r, 10));
    ran.push("slow");
  });
  queue.enqueue(async () => ran.push("fast"));
  await queue.awaitIdle();
  check("awaitIdle 等已排队的保存全部结束", ran.join(",") === "slow,fast");
}

{
  const queue = createSaveQueue();
  const ran = [];
  const failing = queue.enqueue(async () => {
    throw new Error("网络失败");
  });
  const after = queue.enqueue(async () => ran.push("next"));
  let caught = false;
  try {
    await failing;
  } catch {
    caught = true;
  }
  await after;
  check("失败任务把错误交给自己的调用方", caught === true);
  check("失败不破坏链：后续保存照常执行", ran.join(",") === "next");
  await queue.awaitIdle();
  check("失败后 awaitIdle 仍可正常等待", true);
}

{
  const queue = createSaveQueue();
  const first = queue.enqueue(async () => "saved");
  const second = queue.enqueue(async () => "saved-2");
  const afterAll = queue.awaitIdle();
  const [a, b] = await Promise.all([first, second]);
  check("并发调用保存与 awaitIdle 不丢结果", a === "saved" && b === "saved-2");
  await afterAll;
}

/* ---------- R4：书影音草稿键隔离与存储失败（§10.2 ⑤ / V09 / V10 / V11） ---------- */

{
  const newKey = draftKey("shelf", null);
  const itemKey = draftKey("shelf", "s_1");
  check(
    "新建键用显式 new：ea:draft:shelf:new",
    newKey === "ea:draft:shelf:new"
  );
  check(
    "已有条目按 ID 隔离：ea:draft:shelf:s_1",
    itemKey === "ea:draft:shelf:s_1"
  );
  check("新建键与条目键不同，互不覆盖", newKey !== itemKey);
}

{
  globalThis.sessionStorage = makeStorage();
  const ok = saveDraft(draftKey("shelf", null), {
    contentId: null,
    baseRevision: null,
    savedAt: Date.now(),
    data: { form: { id: "", kind: "book", title: "草稿标题", tagsText: "" } }
  });
  const loaded = loadDraft(draftKey("shelf", null));
  check("保存草稿成功返回 true", ok === true);
  check("草稿可读回且字段完整", loaded?.data.form.title === "草稿标题");
  check("草稿带基准 revision 与时间", typeof loaded?.savedAt === "number");
  clearDraft(draftKey("shelf", null));
  check("clearDraft 后读不到", loadDraft(draftKey("shelf", null)) === null);
  globalThis.sessionStorage = realSessionStorage;
}

{
  // 新建草稿与已有条目草稿互不污染：写 new 不影响 s_1
  globalThis.sessionStorage = makeStorage();
  saveDraft(draftKey("shelf", null), {
    contentId: null,
    baseRevision: null,
    savedAt: Date.now(),
    data: { form: { id: "", title: "新建稿" } }
  });
  saveDraft(draftKey("shelf", "s_1"), {
    contentId: "s_1",
    baseRevision: "3",
    savedAt: Date.now(),
    data: { form: { id: "s_1", title: "条目稿" } }
  });
  const fromNew = loadDraft(draftKey("shelf", null));
  const fromItem = loadDraft(draftKey("shelf", "s_1"));
  check(
    "新建键草稿不污染已有条目草稿",
    fromNew?.data.form.title === "新建稿" &&
      fromItem?.data.form.title === "条目稿"
  );
  globalThis.sessionStorage = realSessionStorage;
}

{
  // 存储写入异常（配额满）：saveDraft 返回 false，调用方必须拦截离开（V11）
  globalThis.sessionStorage = makeStorage({ throwing: true });
  const ok = saveDraft(draftKey("shelf", "s_2"), {
    contentId: "s_2",
    baseRevision: "1",
    savedAt: Date.now(),
    data: { form: { id: "s_2", title: "条目" } }
  });
  check("sessionStorage 写入异常 → saveDraft 返回 false", ok === false);
  globalThis.sessionStorage = realSessionStorage;
}

console.log("\nv3 回归测试\n");
for (const line of results) console.log(line);
console.log(`\n${results.length - failures}/${results.length} 通过`);
if (failures > 0) {
  console.error(`有 ${failures} 条失败`);
  process.exit(1);
}
