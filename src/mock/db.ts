/**
 * 开发替身的数据层。
 *
 * 这里只有内存状态：刷新页面就回到初始种子数据。
 * 想留下改动可以改成 localStorage，但替身的第一目标是“每个页面都能点开看看”，
 * 因此刻意不引入持久化，避免上一轮实验留下的脏数据让之后的人误判。
 */

import type {
  ArticleDetail,
  ArticleVersion,
  ArticleVersionSummary,
  Capabilities,
  ContentRes,
  FileItem,
  GuestbookMessage,
  ModerationRule,
  ShelfItemAdmin,
  VersionSource
} from "@/api/types";

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

let counter = 0;

export function newId(prefix: string): string {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}`;
}

export const BASE_TIME = Date.parse("2026-10-30T10:00:00+08:00");

/** 相对种子时间偏移若干分钟，让列表看起来有时间层次 */
export function at(minutes: number): string {
  return new Date(BASE_TIME + minutes * 60_000).toISOString();
}

export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** 按 Unicode 码点数字符，与前台口径一致 */
export function charCount(text: string): number {
  return Array.from(text).length;
}

/* ------------------------------------------------------------------ *
 * 文件库
 * ------------------------------------------------------------------ */

const IMAGE_SVG = (label: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="600" viewBox="0 0 960 600">
  <rect width="960" height="600" fill="#0a0d16"/>
  <g fill="none" stroke="#e9bd5e" stroke-opacity="0.5">
    <circle cx="480" cy="300" r="150"/>
    <circle cx="480" cy="300" r="210" stroke-opacity="0.22"/>
    <path d="M120 300h720M480 60v480" stroke-opacity="0.18"/>
  </g>
  <text x="480" y="308" fill="#efe8da" font-family="Songti SC, serif" font-size="42" text-anchor="middle">${label}</text>
  <text x="480" y="360" fill="#8b93a7" font-family="monospace" font-size="18" text-anchor="middle">entroaxiom · dev stub</text>
</svg>`;

export const fileBytes = new Map<string, Blob>();

export const files: FileItem[] = [
  {
    id: "f_img_cover",
    name: "星图-封面.svg",
    ext: "svg",
    kind: "image",
    size: 2048,
    updatedAt: at(-40),
    description: "随笔头图，公开使用",
    visibility: "public",
    revision: 2,
    createdAt: at(-4320),
    referenceCount: 0,
    publicSrc: "/uploads/public/f_img_cover.svg"
  },
  {
    id: "f_img_chart",
    name: "轨道计算草图.png",
    ext: "png",
    kind: "image",
    size: 389_120,
    updatedAt: at(-180),
    description: "笔记里那张手绘草图，只给自己看",
    visibility: "private",
    revision: 1,
    createdAt: at(-2880),
    referenceCount: 0,
    publicSrc: null
  },
  {
    id: "f_img_orbit",
    name: "轨道示意图.svg",
    ext: "svg",
    kind: "image",
    size: 5120,
    updatedAt: at(-60),
    description: "配图，公开",
    visibility: "public",
    revision: 3,
    createdAt: at(-1440),
    referenceCount: 0,
    publicSrc: "/uploads/public/f_img_orbit.svg"
  },
  {
    id: "f_pdf_note",
    name: "航海年表-勘误.pdf",
    ext: "pdf",
    kind: "pdf",
    size: 1_204_224,
    updatedAt: at(-300),
    description: "外部资料，公开引用",
    visibility: "public",
    revision: 1,
    createdAt: at(-5760),
    referenceCount: 0,
    publicSrc: "/uploads/public/f_pdf_note.pdf"
  },
  {
    id: "f_doc_draft",
    name: "未完成的手稿.docx",
    ext: "docx",
    kind: "doc",
    size: 44_032,
    updatedAt: at(-20),
    description: "私密草稿，还没想好要不要公开",
    visibility: "private",
    revision: 1,
    createdAt: at(-90),
    referenceCount: 0,
    publicSrc: null
  },
  {
    id: "f_zip_assets",
    name: "旧站资源备份.zip",
    ext: "zip",
    kind: "archive",
    size: 8_388_608,
    updatedAt: at(-1000),
    description: "迁移时留下的包，备份用",
    visibility: "private",
    revision: 1,
    createdAt: at(-6000),
    referenceCount: 0,
    publicSrc: null
  }
];

fileBytes.set(
  "f_img_cover",
  new Blob([IMAGE_SVG("星图 封面")], { type: "image/svg+xml" })
);
fileBytes.set(
  "f_img_chart",
  new Blob([IMAGE_SVG("轨道草图（私密）")], { type: "image/svg+xml" })
);
fileBytes.set(
  "f_img_orbit",
  new Blob([IMAGE_SVG("轨道示意")], { type: "image/svg+xml" })
);
fileBytes.set(
  "f_pdf_note",
  new Blob(["%PDF-1.4\n（开发替身占位）\n"], { type: "application/pdf" })
);
fileBytes.set(
  "f_doc_draft",
  new Blob(["（开发替身占位）"], { type: "application/octet-stream" })
);
fileBytes.set(
  "f_zip_assets",
  new Blob(["（开发替身占位）"], { type: "application/zip" })
);

export function fileById(id: string): FileItem | undefined {
  return files.find(file => file.id === id);
}

/* ------------------------------------------------------------------ *
 * 文章
 * ------------------------------------------------------------------ */

export interface ArticleRecord extends ArticleDetail {
  res: ContentRes;
  /** 发布时留下的只读快照，撤回发布后仍保留最后一份，便于对照 */
  published: {
    title: string;
    summary: string | null;
    category: string | null;
    tags: string[] | null;
    date: string | null;
    updated: string | null;
    body: string;
    /**
     * 发布快照的对外正文：`asset:` 引用已按站长决定换成公开地址或"图片未公开"。
     * 公开接口只能读这一份；`body` 保留内部引用形式，供引用计数与差异比较使用。
     */
    publicBody?: string;
    visibility: string;
    mood?: string | null;
    place?: string | null;
    publishedAt: string;
    publishedRevision: number;
  } | null;
}

const NOTE_BODY = `## 为什么要记这条

读《天体机械》时看到一个说法：**轨道的“形状”比“速度”更稳定**。
这解释了为什么我总记不住日期，却记得住那张图。

- 第一层：观测数据
- 第二层：拟合出的轨道根数
- 第三层：由根数反推的位置

| 量 | 符号 | 单位 |
| --- | --- | --- |
| 半长轴 | $a$ | AU |
| 偏心率 | $e$ | — |
| 倾角 | $i$ | ° |

偏心率公式：$e = \\sqrt{1 - \\frac{b^2}{a^2}}$

![轨道示意](asset:f_img_orbit)

> 记于深夜，可能明天就不同意自己了。

参考资料：[航海年表勘误](asset:f_pdf_note)。`;

const ESSAY_BODY = `## 星图上的空白

小时候以为星图是**完整**的。后来才知道，那些留白不是没画完，而是画不出来——
那里什么都没有，或者太多、太暗，望远镜也看不清。

![星图封面](asset:f_img_cover)

这件事让我对“空白”宽容了一些。

### 三条体会

1. 空白是**信息**，不是缺陷；
2. 空白需要**标注**，否则读者会以为你漏了；
3. 有些空白应该**保留**，解释清楚为什么空着，比强行填满诚实。

最后一句话留给以后的自己：

> 别急着把每一格都填满。`;

const NOTE_BODY_2 = `## 读数笔记

这段还没发布，正在整理。

- 观测时刻：2026-10-28 23:10
- 视宁度：一般
- 备注：风大，三脚架抖

草稿里引用了一张私密图：

![手绘草图](asset:f_img_chart)

以及一份尚未公开的文档，发布前要么替换，要么明确把它转成公开。`;

export const articles: ArticleRecord[] = [
  {
    res: "essays",
    id: "e_starmap",
    title: "星图上的空白",
    summary: "留白不是没画完，而是画不出来。",
    category: "随笔",
    tags: ["天文", "写作"],
    date: "2026-10-20",
    updated: "2026-10-26",
    body: ESSAY_BODY,
    mood: "平静",
    place: "书房",
    visibility: "public",
    status: "published",
    hasUnpublishedChanges: false,
    revision: 7,
    createdAt: at(-9000),
    updatedAt: at(-240),
    publishedAt: at(-240),
    publishedRevision: 6,
    assets: [],
    published: null
  },
  {
    res: "notes",
    id: "n_orbit",
    title: "轨道形状为什么更稳定",
    summary: "读《天体机械》的一条笔记：形状比速度稳定。",
    category: "天体力学",
    tags: ["轨道", "笔记"],
    date: "2026-10-18",
    updated: "2026-10-24",
    body: NOTE_BODY,
    visibility: "public",
    status: "published",
    hasUnpublishedChanges: true,
    revision: 5,
    createdAt: at(-7200),
    updatedAt: at(-120),
    publishedAt: at(-600),
    publishedRevision: 4,
    assets: [],
    published: null
  },
  {
    res: "notes",
    id: "n_reading",
    title: "十月读数笔记",
    summary: null,
    category: "观测记录",
    tags: ["观测"],
    date: "2026-10-28",
    updated: null,
    body: NOTE_BODY_2,
    visibility: "private",
    status: "draft",
    hasUnpublishedChanges: true,
    revision: 2,
    createdAt: at(-400),
    updatedAt: at(-30),
    publishedAt: null,
    publishedRevision: null,
    assets: [],
    published: null
  },
  {
    res: "essays",
    id: "e_quiet",
    title: "把话说小一点",
    summary: "关于克制的旧文，只保留在后台。",
    category: "随笔",
    tags: ["写作"],
    date: "2026-09-30",
    updated: "2026-09-30",
    body: "## 旧稿\n\n这篇被我自己撤回了发布。留着当提醒。\n",
    mood: "迟疑",
    place: "路上",
    visibility: "private",
    status: "draft",
    hasUnpublishedChanges: true,
    revision: 3,
    createdAt: at(-14000),
    updatedAt: at(-4000),
    publishedAt: null,
    publishedRevision: null,
    assets: [],
    published: null
  },
  {
    res: "notes",
    id: "n_tools",
    title: "工具链梳理",
    summary: "把写作、排版、发布三件事拆开。",
    category: "工程",
    tags: ["工具", "流程"],
    date: "2026-10-12",
    updated: "2026-10-12",
    body: "## 三件事\n\n1. 写：本地 Markdown\n2. 排：统一渲染管线\n3. 发：快照 + 权限\n",
    visibility: "public",
    status: "published",
    hasUnpublishedChanges: false,
    revision: 4,
    createdAt: at(-5000),
    updatedAt: at(-1500),
    publishedAt: at(-1500),
    publishedRevision: 4,
    assets: [],
    published: null
  }
];

export function articleById(
  res: ContentRes,
  id: string
): ArticleRecord | undefined {
  return articles.find(article => article.res === res && article.id === id);
}

/* ---------- 版本历史 ---------- */

export const versions: Record<string, ArticleVersion[]> = {};

/** 历史版本存的是当时完整的可读字段，缺一项就会在版本预览里露出 undefined */
function seedVersion(
  res: ContentRes,
  articleId: string,
  version: number,
  source: VersionSource,
  minutes: number,
  fields: Omit<ArticleVersion, "versionId" | "version" | "source" | "createdAt">
) {
  const key = `${res}:${articleId}`;
  versions[key] ||= [];
  versions[key].push({
    versionId: `v_${articleId}_${version}`,
    version,
    source,
    createdAt: at(minutes),
    ...fields
  });
}

seedVersion("essays", "e_starmap", 6, "publish", -240, {
  title: "星图上的空白",
  summary: "留白不是没画完，而是画不出来。",
  category: "随笔",
  tags: ["天文", "写作"],
  date: "2026-10-20",
  updated: "2026-10-26",
  body: ESSAY_BODY,
  mood: "平静",
  place: "书房"
});
seedVersion("essays", "e_starmap", 5, "manual", -600, {
  title: "星图上的留白",
  summary: "初稿标题还没定。",
  category: "随笔",
  tags: ["天文"],
  date: "2026-10-19",
  updated: null,
  body: ESSAY_BODY.replace("## 星图上的空白", "## 星图上的留白"),
  mood: "平静",
  place: "书房"
});
seedVersion("notes", "n_orbit", 4, "publish", -600, {
  title: "轨道形状为什么更稳定",
  summary: "读《天体机械》的一条笔记。",
  category: "天体力学",
  tags: ["轨道", "笔记"],
  date: "2026-10-18",
  updated: "2026-10-24",
  body: NOTE_BODY,
  mood: null,
  place: null
});
seedVersion("notes", "n_orbit", 3, "manual", -1200, {
  title: "轨道形状为什么更稳定",
  summary: null,
  category: "天体力学",
  tags: ["轨道"],
  date: "2026-10-18",
  updated: null,
  body: NOTE_BODY.replace("| 倾角 | $i$ | ° |\n", ""),
  mood: null,
  place: null
});

export function versionSummaries(
  res: ContentRes,
  articleId: string
): ArticleVersionSummary[] {
  const list = versions[`${res}:${articleId}`] ?? [];
  return [...list]
    .sort((a, b) => b.version - a.version)
    .map(item => ({
      versionId: item.versionId,
      version: item.version,
      source: item.source,
      createdAt: item.createdAt,
      title: item.title,
      summary: item.summary,
      size: new Blob([item.body]).size
    }));
}

export function pushVersion(
  record: ArticleRecord,
  source: VersionSource
): string {
  const key = `${record.res}:${record.id}`;
  versions[key] ||= [];
  const next =
    versions[key].reduce((max, item) => Math.max(max, item.version), 0) + 1;
  versions[key].push({
    versionId: `v_${record.id}_${next}`,
    version: next,
    source,
    createdAt: new Date().toISOString(),
    title: record.title,
    summary: record.summary,
    category: record.category,
    tags: record.tags ? [...record.tags] : null,
    date: record.date,
    updated: record.updated,
    body: record.body,
    mood: record.mood ?? null,
    place: record.place ?? null
  });
  return `v_${record.id}_${next}`;
}

/* ------------------------------------------------------------------ *
 * 书影音
 * ------------------------------------------------------------------ */

export const shelf: ShelfItemAdmin[] = [
  {
    id: "s_dune",
    kind: "book",
    title: "沙丘",
    creator: "弗兰克·赫伯特",
    year: 1965,
    rating: 9,
    status: "done",
    date: "2026-10-02",
    tags: ["科幻", "政治"],
    quote: "恐惧是思维的杀手。",
    review: "读第二遍才发现，宗教线其实是在讲信息如何被垄断。",
    cover: "asset:f_img_cover",
    link: null,
    publicationStatus: "published",
    visibility: "public",
    revision: 4,
    createdAt: at(-2200),
    updatedAt: at(-200),
    coverVisibility: "public",
    coverShared: false
  },
  {
    id: "s_orbit",
    kind: "film",
    title: "星际穿越",
    creator: "克里斯托弗·诺兰",
    year: 2014,
    rating: 8,
    status: "done",
    date: "2026-09-18",
    tags: ["科幻", "电影"],
    quote: null,
    review: "配乐比剧情更耐听。",
    cover: "asset:f_img_orbit",
    link: null,
    publicationStatus: "published",
    visibility: "public",
    revision: 2,
    createdAt: at(-3400),
    updatedAt: at(-900),
    coverVisibility: "public",
    coverShared: false
  },
  {
    id: "s_winter",
    kind: "book",
    title: "冬泳",
    creator: "班宇",
    year: 2023,
    rating: null,
    status: "doing",
    date: "2026-10-20",
    tags: ["小说"],
    quote: null,
    review: null,
    cover: "asset:f_img_chart",
    link: null,
    publicationStatus: "draft",
    visibility: "private",
    revision: 1,
    createdAt: at(-400),
    updatedAt: at(-90),
    coverVisibility: "private",
    coverShared: false
  },
  {
    id: "s_ambient",
    kind: "music",
    title: "Music for Space",
    creator: "未知",
    year: 2021,
    rating: 7,
    status: "want",
    date: null,
    tags: ["环境"],
    quote: null,
    review: null,
    cover: null,
    link: "https://example.com/music-for-space",
    publicationStatus: "draft",
    visibility: "private",
    revision: 1,
    createdAt: at(-120),
    updatedAt: at(-120),
    coverVisibility: null,
    coverShared: false
  }
];

/* ------------------------------------------------------------------ *
 * 留言
 * ------------------------------------------------------------------ */

export const guestbook: GuestbookMessage[] = [
  {
    id: "g_1",
    name: "阿岚",
    email: "alan@example.com",
    site: "https://example.com/alan",
    body: "星图那篇的留白说法，正好解了我最近写稿的结。谢谢。",
    sigil: "jupiter",
    status: "approved",
    reply: {
      body: "谢谢你把这句话接住了。留白那部分我改了三次才敢发。",
      createdAt: at(-1800),
      updatedAt: null
    },
    evidence: null,
    ipHash: "9f2c1a77c4de08b3",
    createdAt: at(-2000),
    revision: 2
  },
  {
    id: "g_2",
    name: "匿名",
    email: null,
    site: null,
    body: "加我微信，教你一个月涨粉十万，稳赚不赔……（推广）",
    sigil: null,
    status: "blocked",
    reply: null,
    evidence: {
      ruleId: "r_ad",
      ruleText: "加我微信",
      field: "body",
      reason: "命中自定义屏蔽词",
      policyVersion: "stub-2026-10-30",
      matchedAt: at(-1500)
    },
    ipHash: "1b7d9e0c22a4f6a5",
    createdAt: at(-1500),
    revision: 1
  },
  {
    id: "g_3",
    name: "老周",
    email: null,
    site: null,
    body: "你上次说的那个轨道例子，能不能贴一下公式？我算出来偏心率是负的。",
    sigil: "moon",
    status: "approved",
    reply: null,
    evidence: null,
    ipHash: "44a0c9f13b7e2d10",
    createdAt: at(-800),
    revision: 1
  },
  {
    id: "g_4",
    name: "路过的人",
    email: null,
    site: null,
    body: "这篇我先藏了，不想让人看见我说过这话，抱歉。",
    sigil: null,
    status: "hidden",
    reply: null,
    evidence: null,
    ipHash: "7c53aa9b0e1f8d22",
    createdAt: at(-320),
    revision: 2
  }
];

/* ------------------------------------------------------------------ *
 * 过滤规则
 * ------------------------------------------------------------------ */

export const rules: ModerationRule[] = [
  {
    id: "r_ad",
    text: "加我微信",
    matchMode: "contains",
    fields: ["body"],
    category: "自定义屏蔽",
    enabled: true,
    revision: 1,
    createdAt: at(-5000),
    updatedAt: at(-5000)
  },
  {
    id: "r_insult",
    text: "智商盆地",
    matchMode: "contains",
    fields: ["body"],
    category: "辱骂",
    enabled: true,
    revision: 2,
    createdAt: at(-4800),
    updatedAt: at(-900)
  },
  {
    id: "r_name",
    text: "管理员",
    matchMode: "exact",
    fields: ["name"],
    category: "自定义屏蔽",
    enabled: true,
    revision: 1,
    createdAt: at(-4000),
    updatedAt: at(-4000)
  },
  {
    id: "r_old",
    text: "测试词",
    matchMode: "contains",
    fields: ["body"],
    category: "自定义屏蔽",
    enabled: false,
    revision: 1,
    createdAt: at(-3000),
    updatedAt: at(-3000)
  }
];

/* ------------------------------------------------------------------ *
 * 能力声明
 * ------------------------------------------------------------------ */

export const POLICY_VERSION = "stub-2026-10-30";

export const capabilities: Capabilities = {
  upload: {
    maxFileBytes: 20 * 1024 * 1024,
    allowedKinds: ["image", "pdf", "archive", "doc", "other"],
    allowedExtensions: [
      "png",
      "jpg",
      "jpeg",
      "webp",
      "gif",
      "svg",
      "avif",
      "pdf",
      "zip",
      "md",
      "txt",
      "doc",
      "docx",
      "xls",
      "xlsx",
      "ppt",
      "pptx"
    ],
    maxConcurrent: 3
  },
  import: {
    maxArchiveBytes: 40 * 1024 * 1024,
    maxExpandedBytes: 120 * 1024 * 1024,
    maxEntries: 500
  },
  content: {
    maxBodyBytes: 512 * 1024,
    versionRetention: 20,
    maxTitleChars: 200,
    maxSummaryChars: 300,
    charCounting: "按 Unicode 码点计数"
  },
  features: {
    importZip: true,
    exportZip: true,
    versionRestore: true,
    moderationTest: true,
    serverLogout: true,
    authenticatedMedia: true
  },
  policyVersion: POLICY_VERSION
};

/* ------------------------------------------------------------------ *
 * 引用关系（发布检查与文件删除都要用）
 * ------------------------------------------------------------------ */

/** 正文里出现的 `asset:<id>` 引用 */
export function assetRefsIn(text: string): string[] {
  const found = new Set<string>();
  const pattern = /asset:([A-Za-z0-9_]+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) found.add(match[1]);
  return [...found];
}

export function referencesFor(fileId: string): Array<{
  usage: "working" | "published" | "version" | "cover";
  owner: "notes" | "essays" | "shelf";
  targetId: string;
  title: string;
  version: number | null;
  isPublic: boolean;
}> {
  const refs: ReturnType<typeof referencesFor> = [];

  for (const article of articles) {
    if (assetRefsIn(article.body).includes(fileId)) {
      refs.push({
        usage: "working",
        owner: article.res,
        targetId: article.id,
        title: article.title,
        version: null,
        isPublic:
          article.visibility === "public" && article.status === "published"
      });
    }
    if (
      article.published &&
      assetRefsIn(article.published.body).includes(fileId)
    ) {
      const already = refs.some(
        ref =>
          ref.targetId === article.id && ref.usage === "working" && ref.isPublic
      );
      if (!already) {
        refs.push({
          usage: "published",
          owner: article.res,
          targetId: article.id,
          title: article.title,
          version: null,
          isPublic: article.published.visibility === "public"
        });
      }
    }
  }

  for (const key of Object.keys(versions)) {
    for (const item of versions[key]) {
      if (!assetRefsIn(item.body).includes(fileId)) continue;
      const [owner, targetId] = key.split(":") as ["notes" | "essays", string];
      const host = articleById(owner, targetId);
      refs.push({
        usage: "version",
        owner,
        targetId,
        title: host?.title ?? "（已删除的内容）",
        version: item.version,
        isPublic: false
      });
    }
  }

  for (const item of shelf) {
    if (item.cover === `asset:${fileId}`) {
      refs.push({
        usage: "cover",
        owner: "shelf",
        targetId: item.id,
        title: item.title,
        version: null,
        isPublic:
          item.visibility === "public" && item.publicationStatus === "published"
      });
    }
  }

  return refs;
}

/** 详情里要带出的资源清单 */
export function assetsOf(article: ArticleRecord) {
  const ids = new Set(assetRefsIn(article.body));
  if (article.published) {
    for (const id of assetRefsIn(article.published.body)) ids.add(id);
  }
  return [...ids]
    .map(id => fileById(id))
    .filter((file): file is FileItem => !!file)
    .map(file => ({
      fileId: file.id,
      name: file.name,
      kind: file.kind,
      size: file.size,
      visibility: file.visibility,
      usages: [
        "working",
        ...(file.visibility === "public" ? ["published" as const] : [])
      ],
      publicSrc: file.publicSrc
    }));
}

/** 引用计数保持与实际引用一致，避免替身里出现“删了还能删”的假象 */
export function refreshReferenceCounts() {
  for (const file of files) {
    file.referenceCount = referencesFor(file.id).length;
  }
}

refreshReferenceCounts();
