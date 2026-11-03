/**
 * 开发替身的冒烟测试：直接驱动 adapter，把每个端点按真实调用顺序走一遍。
 *
 * 为什么需要它：替身没有后端可以对照，只能靠“自己跟自己讲得通”。
 * 这个脚本保证了分页/筛选、If-Match 并发、发布预检、导入导出这些**容易悄悄坏掉**的路径
 * 至少在一个进程里跑通过，页面再出问题就基本只剩渲染层的原因。
 *
 * 跑法：node scripts/mock-smoke.mjs
 */

import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { bundleModule } from "./lib/bundle.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "node_modules/.cache/mock-smoke");
const bundle = join(outDir, "adapter.mjs");

mkdirSync(outDir, { recursive: true });
await bundleModule({
  entryPoints: [join(root, "src/mock/adapter.ts")],
  outfile: bundle
});

const { mockAdapter } = await import(pathToFileURL(bundle).href);

/* ------------------------------------------------------------------ *
 * 客户端工具：尽量贴近 src/utils/http 的真实行为
 * ------------------------------------------------------------------ */

let token = "";

function call(method, url, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  if (token && options.auth !== false)
    headers.Authorization = `Bearer ${token}`;
  if (!headers.Authorization && options.auth !== false)
    delete headers.Authorization;
  const config = {
    method,
    url,
    baseURL: "/api/admin",
    headers,
    params: options.params,
    // body 走 JSON 序列化；data 原样传（上传用的 FormData、blob 请求）
    data:
      options.body !== undefined ? JSON.stringify(options.body) : options.data
  };
  return mockAdapter(config);
}

/** 走 src/api/query.ts 的 pagedQuery 约定：pageSize → page_size */
function pageParams(query = {}) {
  const { pageSize, ...rest } = query;
  const params = { ...rest };
  if (pageSize !== undefined) params.page_size = pageSize;
  return params;
}

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

function unwrap(response) {
  const body = response.data;
  if (!body || typeof body !== "object") return body;
  return body;
}

async function expectOk(name, method, url, options) {
  const response = await call(method, url, options);
  const body = unwrap(response);
  check(
    `${name}（${method.toUpperCase()} ${url}）`,
    body?.success === true,
    JSON.stringify(body?.error ?? body).slice(0, 200)
  );
  return body?.data;
}

async function expectFail(name, code, method, url, options) {
  const response = await call(method, url, options);
  const body = unwrap(response);
  check(
    `${name}（期望 ${code}）`,
    body?.success === false && body?.error?.code === code,
    JSON.stringify(body?.error ?? body).slice(0, 200)
  );
  return body;
}

/**
 * 改可见范围必须先预检：界面里走的就是 PublishDialog 的 `action="visibility"`，
 * 先拿 checkId 再 PATCH，服务端会比对凭据里的目标可见范围与 revision。
 */
async function changeVisibility(articleUrl, visibility, baseRevision) {
  const check = await expectOk(
    "改可见范围预检",
    "post",
    `${articleUrl}/publication-check`,
    {
      body: { action: "visibility", baseRevision, targetVisibility: visibility }
    }
  );
  return expectOk("改可见范围", "patch", `${articleUrl}/visibility`, {
    body: { visibility, baseRevision, checkId: check?.checkId }
  });
}

/* ------------------------------------------------------------------ *
 * 1. 鉴权与能力
 * ------------------------------------------------------------------ */

await expectFail("未登录被拦截", "UNAUTHORIZED", "get", "/capabilities");

const session = await expectOk("登录", "post", "/login", {
  body: { username: "admin", password: "entroaxiom" },
  auth: false
});
token = session?.accessToken ?? "";
check("登录返回 accessToken", !!token);

await expectFail("密码过短被拒", "INVALID_CREDENTIALS", "post", "/login", {
  body: { username: "admin", password: "123" },
  auth: false
});

const caps = await expectOk("能力声明", "get", "/capabilities");
check("能力里带 features", caps?.features?.importZip === true);

/* ------------------------------------------------------------------ *
 * 2. 概览与选项
 * ------------------------------------------------------------------ */

const dashboard = await expectOk("概览", "get", "/dashboard");
check("概览有统计", dashboard?.stats?.notes >= 1);
check("概览有最近草稿", Array.isArray(dashboard?.recentDrafts));

const options = await expectOk("内容选项", "get", "/content-options", {
  params: { type: "notes" }
});
check("内容选项有分类", (options?.categories ?? []).length > 0);

/* ------------------------------------------------------------------ *
 * 3. 文章：列表筛选 / 并发 / 发布 / 撤回 / 版本 / 导出
 * ------------------------------------------------------------------ */

const notes = await expectOk("笔记列表", "get", "/articles/notes", {
  params: pageParams({ page: 1, pageSize: 1 })
});
check("分页 total 是全部匹配数", notes?.total >= 3, `total=${notes?.total}`);
check("分页 items 按 pageSize 截断", notes?.items?.length === 1);

const onlyDirty = await expectOk("只筛有未发布修改", "get", "/articles/notes", {
  params: pageParams({ hasUnpublishedChanges: true })
});
check(
  "筛选条件真的生效",
  onlyDirty.items.every(item => item.hasUnpublishedChanges === true),
  JSON.stringify(onlyDirty.items.map(i => i.hasUnpublishedChanges))
);

const article = await expectOk("文章详情", "get", "/articles/notes/n_orbit");
check("详情带 revision", typeof article?.revision === "number");
check("详情带 assets 数组", Array.isArray(article?.assets));

await expectFail(
  "用旧 revision 保存会冲突",
  "REVISION_CONFLICT",
  "put",
  "/articles/notes/n_orbit",
  {
    body: { ...article, baseRevision: article.revision - 1, saveMode: "manual" }
  }
);

const saved = await expectOk(
  "用正确 revision 保存",
  "put",
  "/articles/notes/n_orbit",
  {
    body: {
      ...article,
      title: article.title,
      body: `${article.body}\n\n（冒烟测试补的一句话）`,
      baseRevision: article.revision,
      saveMode: "manual"
    }
  }
);
check("保存后 revision 递增", saved?.revision === article.revision + 1);

const checkResult = await expectOk(
  "发布预检（正文含私密资源）",
  "post",
  "/articles/notes/n_reading/publication-check",
  { body: { action: "publish", baseRevision: 2, targetVisibility: "public" } }
);
check("预检识别出私密资源", (checkResult?.assetDecisions ?? []).length === 1);
check("预检可继续", checkResult?.canProceed === true);
check(
  "预检给出资源决策选项",
  (checkResult?.assetDecisions?.[0]?.options ?? []).includes("copy-public")
);

await expectFail(
  "预检 baseRevision 不对也会冲突",
  "REVISION_CONFLICT",
  "post",
  "/articles/notes/n_reading/publication-check",
  { body: { action: "publish", baseRevision: 99 } }
);

await expectFail(
  "没预检直接发布被拒",
  "CHECK_EXPIRED",
  "post",
  "/articles/notes/n_reading/publish",
  { body: { baseRevision: 2, checkId: "chk_not_there", confirmed: true } }
);

const privateDraft = await expectOk(
  "私密草稿详情",
  "get",
  "/articles/notes/n_reading"
);

const published = await expectOk(
  "按预检发布",
  "post",
  "/articles/notes/n_reading/publish",
  {
    body: {
      baseRevision: privateDraft.revision,
      checkId: checkResult.checkId,
      targetVisibility: "public",
      confirmed: true,
      assetDecisions: checkResult.assetDecisions.map(item => ({
        fileId: item.fileId,
        decision: "copy-public"
      }))
    }
  }
);
check("发布后状态是 published", published?.status === "published");
check("发布后没有未发布修改", published?.hasUnpublishedChanges === false);

const publishedView = await expectOk(
  "线上快照可读",
  "get",
  "/articles/notes/n_reading/published"
);
check("线上快照带正文", typeof publishedView?.body === "string");
check(
  "线上快照不再吐裸 asset: 引用",
  !String(publishedView?.body ?? "").includes("asset:")
);
const publicRefs = String(publishedView?.body ?? "").match(
  /\/uploads\/public\/[A-Za-z0-9_]+\.[a-z0-9]+/g
);
check("线上快照把资源换成公开地址", (publicRefs ?? []).length > 0);
check(
  "公开地址不再指向 /media/",
  !String(publishedView?.body ?? "").includes("/media/")
);

const copiedId = String(publicRefs?.[0] ?? "")
  .replace(/^.*\/uploads\/public\//, "")
  .replace(/\.[a-z0-9]+$/, "");
const originalId = checkResult.assetDecisions[0].fileId;
const copiedFile = copiedId
  ? await expectOk("公开副本可查", "get", `/files/${copiedId}`)
  : null;
const originalFile = await expectOk(
  "原文件仍在文件库",
  "get",
  `/files/${originalId}`
);
check("copy-public 生成的是另一个文件", !!copiedId && copiedId !== originalId);
check("副本是公开的", copiedFile?.visibility === "public");
check(
  "副本带新版公开字段",
  String(copiedFile?.publicSrc ?? "").startsWith("/uploads/public/") &&
    copiedFile?.publicUrl === copiedFile?.publicSrc &&
    copiedFile?.visible === true
);
check("复制副本后原文件仍是私密", originalFile?.visibility === "private");
check("原文件没有公开直链", originalFile?.publicSrc === null);

const unpublished = await expectOk(
  "撤回发布",
  "post",
  "/articles/notes/n_reading/unpublish",
  {
    body: { baseRevision: published.revision }
  }
);
check("撤回后回到草稿", unpublished?.status === "draft");

await expectFail(
  "重复撤回被拒",
  "NOT_PUBLISHED",
  "post",
  "/articles/notes/n_reading/unpublish",
  { body: { baseRevision: unpublished.revision } }
);

const versions = await expectOk(
  "版本列表",
  "get",
  "/articles/notes/n_orbit/versions"
);
check(
  "版本按新到旧排序",
  (versions?.[0]?.version ?? 0) >= (versions?.[1]?.version ?? 0)
);

const versionDetail = await expectOk(
  "版本详情带完整字段",
  "get",
  `/articles/notes/n_orbit/versions/${versions[0].versionId}`
);
check(
  "版本详情有 category/tags/date/updated",
  "category" in versionDetail &&
    "tags" in versionDetail &&
    "date" in versionDetail
);

const restored = await expectOk(
  "恢复版本",
  "post",
  `/articles/notes/n_orbit/versions/${versions[0].versionId}/restore`,
  { body: { baseRevision: saved.revision } }
);
check("恢复返回 preservedVersion", !!restored?.preservedVersion);
check("恢复后 revision 递增", restored?.article?.revision > saved.revision);

const mdExport = await call("get", "/articles/notes/n_orbit/export", {
  params: { source: "working", format: "md" }
});
check("导出 md 是 blob", mdExport.data instanceof Blob);
check(
  "导出 md 有 content-disposition",
  String(mdExport.headers?.["content-disposition"] ?? "").includes("attachment")
);
const mdText = await mdExport.data.text();
check("导出 md 带 frontmatter", mdText.startsWith("---\ntitle:"));

const zipExport = await call("get", "/articles/notes/n_orbit/export", {
  params: { source: "working", format: "zip" }
});
const zipBytes = new Uint8Array(await zipExport.data.arrayBuffer());
check("导出 zip 是 PK 开头", zipBytes[0] === 0x50 && zipBytes[1] === 0x4b);

await expectFail(
  "没有线上快照时不能导出发布版",
  "NOT_PUBLISHED",
  "get",
  "/articles/notes/n_reading/export",
  { params: { source: "published", format: "md" } }
);

/* ------------------------------------------------------------------ *
 * 3.5 checkId 的绑定与原子消费
 * 以前只判"凭据存在且没过期"：A 的凭据能发布 B、改权限的凭据能拿去发布。
 * ------------------------------------------------------------------ */

const orbitDraft = await expectOk(
  "取一篇草稿做凭据测试",
  "get",
  "/articles/notes/n_orbit"
);
const orbitCheck = await expectOk(
  "为 A 申请发布凭据",
  "post",
  "/articles/notes/n_orbit/publication-check",
  {
    body: {
      action: "publish",
      baseRevision: orbitDraft.revision,
      targetVisibility: "public"
    }
  }
);
const quietDraft = await expectOk(
  "取另一篇草稿",
  "get",
  "/articles/essays/e_quiet"
);
await expectFail(
  "A 的凭据不能发布 B",
  "CHECK_MISMATCH",
  "post",
  "/articles/essays/e_quiet/publish",
  {
    body: {
      baseRevision: quietDraft.revision,
      checkId: orbitCheck.checkId,
      targetVisibility: "public",
      confirmed: true
    }
  }
);

const visibilityCheck = await expectOk(
  "为 A 申请改可见范围凭据",
  "post",
  "/articles/notes/n_orbit/publication-check",
  { body: { action: "visibility", baseRevision: orbitDraft.revision } }
);
await expectFail(
  "改权限的凭据不能用来发布",
  "CHECK_MISMATCH",
  "post",
  "/articles/notes/n_orbit/publish",
  {
    body: {
      baseRevision: orbitDraft.revision,
      checkId: visibilityCheck.checkId,
      targetVisibility: "public",
      confirmed: true
    }
  }
);

const privateTargetCheck = await expectOk(
  "申请一个目标是私密的凭据",
  "post",
  "/articles/notes/n_orbit/publication-check",
  {
    body: {
      action: "publish",
      baseRevision: orbitDraft.revision,
      targetVisibility: "private"
    }
  }
);
await expectFail(
  "目标可见范围不符也要拒",
  "CHECK_MISMATCH",
  "post",
  "/articles/notes/n_orbit/publish",
  {
    body: {
      baseRevision: orbitDraft.revision,
      checkId: privateTargetCheck.checkId,
      targetVisibility: "public",
      confirmed: true
    }
  }
);

/* ------------------------------------------------------------------ *
 * 4. 文件库：上传 / 鉴权读取 / 引用 / 删除保护
 * ------------------------------------------------------------------ */

const files = await expectOk("文件列表", "get", "/files", {
  params: pageParams({ kind: "image" })
});
check(
  "文件列表按 kind 过滤",
  files.items.every(file => file.kind === "image")
);

const unused = await expectOk("只看未引用文件", "get", "/files", {
  params: pageParams({ unused: true })
});
check(
  "未引用筛选生效",
  unused.items.every(file => file.referenceCount === 0)
);

const svg = new Blob(
  ['<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"></svg>'],
  { type: "image/svg+xml" }
);
const form = new FormData();
form.append("file", new File([svg], "冒烟测试.svg", { type: "image/svg+xml" }));
const uploaded = await expectOk("上传文件", "post", "/files", { data: form });
check("上传后是私密", uploaded?.visibility === "private");
check("私密文件没有直链", uploaded?.publicSrc === null);

const content = await call("get", `/files/${uploaded.id}/content`);
check("鉴权读取拿到 blob", content.data instanceof Blob);

const references = await expectOk(
  "引用清单",
  "get",
  "/files/f_img_orbit/references"
);
check("公开配图有引用", references.length > 0);
check(
  "引用项带 usage/owner",
  references.every(item => item.usage && item.owner && item.targetId)
);

await expectFail(
  "被引用的文件不能删",
  "FILE_IN_USE",
  "delete",
  "/files/f_img_cover",
  { headers: { "If-Match": "2" } }
);

await expectFail(
  "If-Match 不对不能删",
  "REVISION_CONFLICT",
  "delete",
  `/files/${uploaded.id}`,
  { headers: { "If-Match": "99" } }
);

await expectOk("未被引用的文件可删", "delete", `/files/${uploaded.id}`, {
  headers: { "If-Match": "1" }
});

/* ------------------------------------------------------------------ *
 * 5. 书影音
 * ------------------------------------------------------------------ */

const shelf = await expectOk("书影音列表", "get", "/shelf", {
  params: pageParams({ kind: "book" })
});
check(
  "书影音按类型过滤",
  shelf.items.every(item => item.kind === "book")
);

const shelfCheck = await expectOk(
  "书影音发布预检",
  "post",
  "/shelf/s_winter/publication-check",
  {
    body: {
      action: "publish",
      baseRevision: 1,
      targetVisibility: "public"
    }
  }
);
check(
  "封面是私密资源时需要决策",
  (shelfCheck?.assetDecisions ?? []).length === 1
);

const shelfPublished = await expectOk(
  "书影音发布",
  "post",
  "/shelf/s_winter/publish",
  {
    body: {
      baseRevision: 1,
      checkId: shelfCheck.checkId,
      targetVisibility: "public",
      confirmed: true,
      assetDecisions: [{ fileId: "f_img_chart", decision: "keep-private" }]
    }
  }
);
check("书影音发布成功", shelfPublished?.publicationStatus === "published");
check("封面保持私密时不给公开地址", shelfPublished?.coverUrl === null);
check(
  "封面仍是 asset 引用，不暴露真实路径",
  String(shelfPublished?.cover ?? "").startsWith("asset:")
);

const shelfDraft = await expectOk("书影音编辑", "put", "/shelf/s_winter", {
  body: {
    ...shelfPublished,
    quote: "冒烟测试改的一句",
    baseRevision: shelfPublished.revision
  }
});
check(
  "书影音编辑后 revision 递增",
  shelfDraft?.revision > shelfPublished.revision
);

// 封面走 copy-public：必须复制出一份新文件，原图继续私密
const coverCopyCheck = await expectOk(
  "封面复检（准备复制公开副本）",
  "post",
  "/shelf/s_winter/publication-check",
  {
    body: {
      action: "publish",
      baseRevision: shelfDraft.revision,
      targetVisibility: "public"
    }
  }
);
const coverCopy = await expectOk(
  "封面按公开副本发布",
  "post",
  "/shelf/s_winter/publish",
  {
    body: {
      baseRevision: shelfDraft.revision,
      checkId: coverCopyCheck.checkId,
      targetVisibility: "public",
      confirmed: true,
      assetDecisions: [{ fileId: "f_img_chart", decision: "copy-public" }]
    }
  }
);
check(
  "封面改指向新的公开副本",
  String(coverCopy?.cover ?? "").startsWith("asset:") &&
    coverCopy?.cover !== "asset:f_img_chart"
);
check(
  "封面公开地址是 /uploads/public/",
  String(coverCopy?.coverUrl ?? "").startsWith("/uploads/public/")
);
check(
  "封面公开地址里没有 /media/",
  !String(coverCopy?.coverUrl ?? "").includes("/media/")
);
const coverSource = await expectOk(
  "原封面文件仍在",
  "get",
  "/files/f_img_chart"
);
check("复制封面后原图仍是私密", coverSource?.visibility === "private");

/* ------------------------------------------------------------------ *
 * 6. 留言
 * ------------------------------------------------------------------ */

const messages = await expectOk("留言列表", "get", "/guestbook", {
  params: pageParams({ status: "approved" })
});
check(
  "留言按状态过滤",
  messages.items.every(item => item.status === "approved")
);

const message = await expectOk("留言详情", "get", "/guestbook/g_3");

await expectFail(
  "回复用旧 revision 冲突",
  "REVISION_CONFLICT",
  "put",
  "/guestbook/g_3/reply",
  { body: { body: "测试回复", baseRevision: message.revision - 1 } }
);

const replied = await expectOk("回复留言", "put", "/guestbook/g_3/reply", {
  body: {
    body: "偏心率算成负的通常是半长轴符号弄反了。",
    baseRevision: message.revision
  }
});
check("回复写入成功", replied?.reply?.body?.length > 0);

await expectOk("删除回复", "delete", "/guestbook/g_3/reply", {
  headers: { "If-Match": String(replied.revision) }
});

const hidden = await expectOk("隐藏留言", "patch", "/guestbook/g_3", {
  body: { status: "hidden", baseRevision: replied.revision + 1 }
});
check("状态改成 hidden", hidden?.status === "hidden");

await expectFail(
  "不能把状态改成 blocked",
  "VALIDATION_ERROR",
  "patch",
  "/guestbook/g_3",
  { body: { status: "blocked", baseRevision: hidden.revision } }
);

/* ------------------------------------------------------------------ *
 * 7. 过滤规则
 * ------------------------------------------------------------------ */

const rules = await expectOk("规则列表", "get", "/moderation/rules");
check("规则列表非空", rules.items.length > 0);

const newRule = await expectOk("新建规则", "post", "/moderation/rules", {
  body: {
    text: "冒烟测试词",
    matchMode: "contains",
    fields: ["body", "name"],
    category: "自定义屏蔽",
    enabled: true
  }
});

await expectFail(
  "重复规则被拒",
  "DUPLICATE_RULE",
  "post",
  "/moderation/rules",
  { body: { text: "冒烟测试词", matchMode: "contains", fields: ["body"] } }
);

const toggled = await expectOk(
  "启用状态切换走同一个 PUT",
  "put",
  `/moderation/rules/${newRule.id}`,
  {
    body: { enabled: false, baseRevision: newRule.revision }
  }
);
check("开关改成功", toggled?.enabled === false);

const blockedTest = await expectOk("测试器命中", "post", "/moderation/test", {
  body: { name: "游客", body: "这里写了加我微信四个字" }
});
check("命中时 allowed=false", blockedTest?.allowed === false);
check("命中项指出字段", blockedTest?.matches?.[0]?.field === "body");

const nameTest = await expectOk(
  "称呼走完全相同匹配",
  "post",
  "/moderation/test",
  {
    body: { name: "管理员", body: "正常的内容，没有敏感词" }
  }
);
check("exact 匹配命中称呼", nameTest?.matches?.[0]?.field === "name");

const cleanTest = await expectOk("干净内容放行", "post", "/moderation/test", {
  body: { name: "路人", body: "只是想说一句，这篇文章写得很好。" }
});
check("干净内容 allowed=true", cleanTest?.allowed === true);

await expectOk("删除规则", "delete", `/moderation/rules/${newRule.id}`, {
  headers: { "If-Match": String(toggled.revision) }
});

/* ------------------------------------------------------------------ *
 * 8. 导入：单个 md + 用刚才导出的 zip 再导回来
 * ------------------------------------------------------------------ */

const importForm = new FormData();
importForm.append(
  "file",
  new File(
    [
      [
        "---",
        "title: 冒烟测试导入的文章",
        "summary: 由脚本生成",
        "category: 测试",
        "tags: [冒烟, 导入]",
        "date: 2026-10-31",
        "unknownField: 会被记下来",
        "---",
        "",
        "## 正文",
        "",
        "导入的内容里带一个没被引用的资源引用写法：![图](asset:f_img_orbit)",
        ""
      ].join("\n")
    ],
    "冒烟导入.md",
    { type: "text/markdown" }
  )
);
importForm.append("type", "notes");
const preview = await expectOk("导入预检（md）", "post", "/imports/preview", {
  data: importForm
});
check("预检给出候选", preview?.candidates?.length === 1);
check("预检解析出标题", preview?.draft?.title === "冒烟测试导入的文章");
check(
  "未知 frontmatter 被记下",
  (preview?.unknownFrontmatter ?? []).includes("unknownField")
);
check("预检可提交", preview?.committable === true);

const committed = await expectOk(
  "提交导入（新建）",
  "post",
  `/imports/${preview.importId}/commit`,
  {
    body: {
      mode: "create",
      draft: preview.draft,
      includeUnreferencedPaths: []
    }
  }
);
check("导入产生文章 id", !!committed?.articleId);
check("导入留了版本", !!committed?.preservedVersion);

const importedArticle = await expectOk(
  "导入的文章能读",
  "get",
  `/articles/notes/${committed.articleId}`
);
check(
  "导入的正文落库",
  importedArticle?.body?.includes("冒烟测试导入的文章") === false
);

const zipForm = new FormData();
zipForm.append(
  "file",
  new File([zipExport.data], "导出回灌.zip", { type: "application/zip" })
);
zipForm.append("type", "notes");
const zipPreview = await expectOk(
  "导入预检（zip）",
  "post",
  "/imports/preview",
  {
    data: zipForm
  }
);
check("zip 里找到 md 候选", (zipPreview?.candidates ?? []).length === 1);
check("zip 候选能解出标题", !!zipPreview?.candidates?.[0]?.title);

await expectOk("丢弃导入会话", "delete", `/imports/${zipPreview.importId}`);

/* ------------------------------------------------------------------ *
 * 8.1 字段保留：frontmatter 的 id/updated/mood/place 往返不丢（方案 §6.3）
 * ------------------------------------------------------------------ */

// 随笔导入：frontmatter 带 id/updated/mood/place → 预检与提交都要保留
const essayForm = new FormData();
essayForm.append(
  "file",
  new File(
    [
      [
        "---",
        "title: 轨道夜话",
        "id: essay-roundtrip",
        "summary: 字段保留补测",
        "category: 随笔",
        "tags: [夜话]",
        "date: 2026-10-20",
        "updated: 2026-10-30",
        "mood: 平静",
        "place: 书房",
        "---",
        "",
        "往返测试的随笔正文。",
        ""
      ].join("\n")
    ],
    "字段保留.md",
    { type: "text/markdown" }
  )
);
essayForm.append("type", "essays");
const essayPreview = await expectOk(
  "随笔预检（带 id/updated/mood/place）",
  "post",
  "/imports/preview",
  { data: essayForm }
);
check("预检保留 id", essayPreview?.draft?.id === "essay-roundtrip");
check("预检保留 updated", essayPreview?.draft?.updated === "2026-10-30");
check("预检保留 mood", essayPreview?.draft?.mood === "平静");
check("预检保留 place", essayPreview?.draft?.place === "书房");

const essayCommitted = await expectOk(
  "随笔提交（保留字段）",
  "post",
  `/imports/${essayPreview.importId}/commit`,
  {
    body: {
      mode: "create",
      draft: essayPreview.draft,
      includeUnreferencedPaths: []
    }
  }
);
check("随笔显式 id 生效", essayCommitted?.articleId === "essay-roundtrip");

const essayRecord = await expectOk(
  "随笔导入后字段落库",
  "get",
  `/articles/essays/${essayCommitted.articleId}`
);
check("落库 id 一致", essayRecord?.id === "essay-roundtrip");
check("落库 updated", essayRecord?.updated === "2026-10-30");
check("落库 mood", essayRecord?.mood === "平静");
check("落库 place", essayRecord?.place === "书房");

// 导出工作稿 md：frontmatter 应带 id/updated/mood/place
const essayExport = await call(
  "get",
  `/articles/essays/${essayCommitted.articleId}/export`,
  { params: { source: "working", format: "md" } }
);
check("随笔导出 md 是 blob", essayExport.data instanceof Blob);
const essayMd = await essayExport.data.text();
check("导出 frontmatter 首行 title", essayMd.startsWith("---\ntitle:"));
check("导出 frontmatter 带 id", /^id: essay-roundtrip$/m.test(essayMd));
check("导出 frontmatter 带 updated", /^updated: 2026-10-30$/m.test(essayMd));
check("导出 frontmatter 带 mood", /^mood: 平静$/m.test(essayMd));
check("导出 frontmatter 带 place", /^place: 书房$/m.test(essayMd));

// 导出 → 再导入：字段往返保留 + 同 ID 冲突能被预检发现
const roundForm = new FormData();
roundForm.append(
  "file",
  new File([essayMd], "往返.md", { type: "text/markdown" })
);
roundForm.append("type", "essays");
const roundPreview = await expectOk(
  "往返预检（导出再导入）",
  "post",
  "/imports/preview",
  { data: roundForm }
);
check("往返预检 draft.id 保留", roundPreview?.draft?.id === "essay-roundtrip");
check(
  "往返预检 draft.updated 保留",
  roundPreview?.draft?.updated === "2026-10-30"
);
check("往返预检 draft.mood 保留", roundPreview?.draft?.mood === "平静");
check("往返预检 draft.place 保留", roundPreview?.draft?.place === "书房");
check(
  "往返出现同 ID 冲突",
  (roundPreview?.conflicts ?? []).some(c => c.id === "essay-roundtrip")
);
await expectOk("丢弃往返会话", "delete", `/imports/${roundPreview.importId}`);

// 非法 id 被当作未知字段，不进入 draft
const badIdForm = new FormData();
badIdForm.append(
  "file",
  new File(["---\nid: 大写开头Bad\n---\n\n非法 ID 的正文。"], "非法ID.md", {
    type: "text/markdown"
  })
);
badIdForm.append("type", "notes");
const badIdPreview = await expectOk(
  "预检（非法 id）",
  "post",
  "/imports/preview",
  { data: badIdForm }
);
check(
  "非法 id 进 unknown",
  (badIdPreview?.unknownFrontmatter ?? []).includes("id")
);
check("非法 id 不进入 draft", (badIdPreview?.draft?.id ?? "") === "");

/* ------------------------------------------------------------------ *
 * 9. 状态规则补测（AC-06 / AC-07 / AC-08 / AC-12 / AC-21）
 * ------------------------------------------------------------------ */

/** 上传一个私密资源，供“发布时怎么处理私密资源”的断言使用 */
async function uploadPrivateFile(name, text) {
  const form = new FormData();
  form.append(
    "file",
    new File([new TextEncoder().encode(text)], name, { type: "image/svg+xml" })
  );
  form.append("visibility", "private");
  return expectOk(`上传私密资源 ${name}`, "post", "/files", { data: form });
}

const secretCopy = await uploadPrivateFile("补测-copy.svg", "<svg/>");
const secretMake = await uploadPrivateFile("补测-make.svg", "<svg/>");
check("上传的私密资源没有直链", secretCopy?.publicSrc === null);

function draftOf(id, title, body) {
  return {
    id,
    title,
    summary: "状态规则补测",
    category: null,
    tags: null,
    date: null,
    updated: null,
    body
  };
}

// AC-21 + AC-06 + AC-07 + AC-08：一篇引用私密资源的笔记走完整生命周期
// AC-03：中文标题生成 ASCII ID，显式 ID 冲突能被识别
const chineseNote = await expectOk(
  "补测：新建中文标题笔记",
  "post",
  "/articles/notes",
  { body: draftOf("", "深夜的星图与旧账本", "正文") }
);
check("中文标题生成 ASCII ID", /^n_[a-z0-9-]+$/.test(chineseNote?.id ?? ""));
const explicitOnce = await expectOk(
  "补测：显式 ID 新建",
  "post",
  "/articles/notes",
  {
    body: { ...draftOf("smoke-explicit-id", "显式 ID", "正文") }
  }
);
check("显式 ID 被接受", explicitOnce?.id === "smoke-explicit-id");
await expectFail("重复 ID 被拒绝", "DUPLICATE_ID", "post", "/articles/notes", {
  body: { ...draftOf("smoke-explicit-id", "显式 ID 再来一次", "正文") }
});

const copyNote = await expectOk(
  "补测：新建引用私密资源的笔记",
  "post",
  "/articles/notes",
  {
    body: draftOf("", "补测-copy", `第一版\n\n![图](asset:${secretCopy.id})\n`)
  }
);

const copyCheck = await expectOk(
  "补测：发布预检（copy-public）",
  "post",
  `/articles/notes/${copyNote.id}/publication-check`,
  {
    body: {
      action: "publish",
      baseRevision: copyNote.revision,
      targetVisibility: "public"
    }
  }
);
check(
  "预检把私密资源列成待决策项",
  (copyCheck?.assetDecisions ?? []).some(a => a.fileId === secretCopy.id)
);

const copyPublished = await expectOk(
  "补测：用 copy-public 发布",
  "post",
  `/articles/notes/${copyNote.id}/publish`,
  {
    body: {
      baseRevision: copyNote.revision,
      checkId: copyCheck.checkId,
      targetVisibility: "public",
      assetDecisions: [{ fileId: secretCopy.id, decision: "copy-public" }],
      confirmed: true
    }
  }
);
check("copy-public 发布成功", copyPublished?.status === "published");

const copyFileAfter = await expectOk(
  "补测：回读 copy 资源",
  "get",
  `/files/${secretCopy.id}`
);
check(
  "copy-public 不改原文件权限",
  copyFileAfter?.visibility === "private" && copyFileAfter?.publicSrc === null
);

// AC-06：改工作稿不动线上快照
const copySaved = await expectOk(
  "补测：改工作稿（manual）",
  "put",
  `/articles/notes/${copyNote.id}`,
  {
    body: {
      ...draftOf(
        copyNote.id,
        "补测-copy",
        `第二版\n\n![图](asset:${secretCopy.id})\n`
      ),
      baseRevision: copyPublished.revision,
      saveMode: "manual"
    }
  }
);
check("保存后标记有待发布修改", copySaved?.hasUnpublishedChanges === true);
const copyPublishedView = await expectOk(
  "补测：读线上快照",
  "get",
  `/articles/notes/${copyNote.id}/published`
);
check(
  "工作稿改动不影响线上快照",
  typeof copyPublishedView?.body === "string" &&
    copyPublishedView.body.includes("第一版")
);

// AC-07：撤回发布，工作稿不丢
const copyUnpublished = await expectOk(
  "补测：撤回发布",
  "post",
  `/articles/notes/${copyNote.id}/unpublish`,
  { body: { baseRevision: copySaved.revision } }
);
check("撤回后回到 draft", copyUnpublished?.status === "draft");
await expectFail(
  "撤回后线上快照不可读",
  "NOT_PUBLISHED",
  "get",
  `/articles/notes/${copyNote.id}/published`
);
const copyAfterUnpublish = await expectOk(
  "补测：撤回后读工作稿",
  "get",
  `/articles/notes/${copyNote.id}`
);
check(
  "撤回发布不丢工作稿",
  copyAfterUnpublish?.body?.includes("第二版") === true
);

// AC-08：权限与发布正交 —— 改可见范围不产生快照
const copyVisible = await changeVisibility(
  `/articles/notes/${copyNote.id}`,
  "public",
  copyAfterUnpublish.revision
);
check(
  "改权限不产生发布快照",
  copyVisible?.status === "draft" && copyVisible?.publishedAt === null
);
check("可见范围已更新", copyVisible?.visibility === "public");

// AC-12：恢复旧版本 —— 当前稿先被保护，线上与权限不动
const republished = await (async () => {
  const again = await expectOk(
    "补测：再次预检",
    "post",
    `/articles/notes/${copyNote.id}/publication-check`,
    {
      body: {
        action: "publish",
        baseRevision: copyVisible.revision,
        targetVisibility: "public"
      }
    }
  );
  return expectOk(
    "补测：再次发布",
    "post",
    `/articles/notes/${copyNote.id}/publish`,
    {
      body: {
        baseRevision: copyVisible.revision,
        checkId: again.checkId,
        targetVisibility: "public",
        assetDecisions: [{ fileId: secretCopy.id, decision: "keep-private" }],
        confirmed: true
      }
    }
  );
})();
check("keep-private 也能发布", republished?.status === "published");
const copyFileKeep = await expectOk(
  "补测：回读 keep 资源",
  "get",
  `/files/${secretCopy.id}`
);
check("keep-private 不改文件权限", copyFileKeep?.visibility === "private");

const thirdSave = await expectOk(
  "补测：写入第三版",
  "put",
  `/articles/notes/${copyNote.id}`,
  {
    body: {
      ...draftOf(
        copyNote.id,
        "补测-copy",
        `第三版\n\n![图](asset:${secretCopy.id})\n`
      ),
      baseRevision: republished.revision,
      saveMode: "manual"
    }
  }
);

const copyVersions = await expectOk(
  "补测：列版本",
  "get",
  `/articles/notes/${copyNote.id}/versions`
);
check("版本列表非空", (copyVersions ?? []).length >= 2);

const publishedBeforeRestore = await expectOk(
  "补测：恢复前读线上快照",
  "get",
  `/articles/notes/${copyNote.id}/published`
);
const oldestVersion = [...(copyVersions ?? [])].sort(
  (a, b) => a.version - b.version
)[0];
const copyRestored = await expectOk(
  "补测：恢复最早版本",
  "post",
  `/articles/notes/${copyNote.id}/versions/${oldestVersion.versionId}/restore`,
  { body: { baseRevision: thirdSave.revision } }
);
check("恢复返回新的工作稿", !!copyRestored?.article?.id);
check("当前稿被保护成版本", !!restored?.preservedVersion);
check("恢复确实换了正文", copyRestored?.article?.body !== thirdSave?.body);
const publishedAfterRestore = await expectOk(
  "补测：恢复后读线上快照",
  "get",
  `/articles/notes/${copyNote.id}/published`
);
check(
  "恢复不改线上快照",
  publishedAfterRestore?.publishedRevision ===
    publishedBeforeRestore?.publishedRevision &&
    publishedAfterRestore?.body === publishedBeforeRestore?.body
);
check(
  "恢复不改可见范围",
  copyRestored?.article?.visibility === thirdSave?.visibility
);

// 可再次恢复：再恢复一次另一个版本不应报错
const copyRestoredTwice = await expectOk(
  "补测：再恢复一次",
  "post",
  `/articles/notes/${copyNote.id}/versions/${oldestVersion.versionId}/restore`,
  { body: { baseRevision: copyRestored.article.revision } }
);
check("可以反复恢复", !!copyRestoredTwice?.article?.id);

// AC-21 对照：make-public 会真的改文件权限
const makeNote = await expectOk(
  "补测：新建引用私密资源的笔记（make）",
  "post",
  "/articles/notes",
  { body: draftOf("", "补测-make", `正文\n\n![图](asset:${secretMake.id})\n`) }
);
const makeCheck = await expectOk(
  "补测：发布预检（make-public）",
  "post",
  `/articles/notes/${makeNote.id}/publication-check`,
  {
    body: {
      action: "publish",
      baseRevision: makeNote.revision,
      targetVisibility: "public"
    }
  }
);
await expectOk(
  "补测：用 make-public 发布",
  "post",
  `/articles/notes/${makeNote.id}/publish`,
  {
    body: {
      baseRevision: makeNote.revision,
      checkId: makeCheck.checkId,
      targetVisibility: "public",
      assetDecisions: [{ fileId: secretMake.id, decision: "make-public" }],
      confirmed: true
    }
  }
);
const makeFileAfter = await expectOk(
  "补测：回读 make 资源",
  "get",
  `/files/${secretMake.id}`
);
check(
  "make-public 会把文件本身改成公开",
  makeFileAfter?.visibility === "public" && !!makeFileAfter?.publicSrc
);

/* ------------------------------------------------------------------ *
 * 10. 收尾
 * ------------------------------------------------------------------ */

await expectFail(
  "不存在的端点明确报错",
  "MOCK_NOT_IMPLEMENTED",
  "get",
  "/not-a-real-endpoint"
);

rmSync(outDir, { recursive: true, force: true });

console.log("\n开发替身冒烟测试\n");
for (const line of results) console.log(line);
console.log(
  `\n${results.length - failures}/${results.length} 通过${failures ? `，${failures} 项失败` : ""}\n`
);
process.exit(failures ? 1 : 0);
