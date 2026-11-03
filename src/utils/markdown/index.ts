import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkRehype from "remark-rehype";
import rehypeSlug from "rehype-slug";
import rehypeKatex from "rehype-katex";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";
import type { Root, RootContent } from "mdast";
import type { Root as HastRoot } from "hast";

/**
 * 正文渲染管线，与前台完全对齐：
 *  remark-gfm（singleTilde:false） → 表格／任务列表／删除线，且 "4~16 KB" 不会被划掉
 *  remark-math + rehype-katex      → $行内$ / $$块级$$，写错的公式按原文显示
 *  rehype-slug                     → 标题锚点，id 与前台一致，目录可跳转
 *  rehype-sanitize                 → 白名单清洗（前台用 React 组件渲染，天然安全；这里用 v-html，必须清洗）
 *
 * 关键区别：**不允许原始 HTML**（remarkRehype 不开 allowDangerousHtml）。
 * 前台同样不渲染正文里的 HTML，所以管理端预览与线上效果一致，也避免导入的 .md 里藏脚本。
 */

/** 私密资源引用 `asset:<fileId>` 在渲染时标记成 data 属性，由组件异步换成带鉴权的对象 URL */
const ASSET_SCHEME = "asset:";
/** 占位图：1×1 透明 GIF，避免 <img src=""> 触发一次对当前页面的请求 */
const PLACEHOLDER =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

function remarkAssetRefs() {
  return (tree: Root) => {
    const walk = (node: RootContent | Root) => {
      if (
        (node.type === "image" || node.type === "link") &&
        typeof node.url === "string" &&
        node.url.startsWith(ASSET_SCHEME)
      ) {
        const fileId = node.url.slice(ASSET_SCHEME.length).trim();
        node.data = node.data ?? {};
        // 注意：hast 里的属性名用 camelCase（dataAssetId），序列化成 HTML 时
        // 才会输出 data-asset-id；rehype-sanitize 的白名单也是按这个名字匹配的，
        // 写成 "data-asset-id" 会被当成未知属性直接清掉。
        node.data.hProperties = {
          ...(node.data.hProperties ?? {}),
          dataAssetId: fileId
        };
        if (node.type === "image") {
          // 保留原引用在 data 里，组件用它取 Blob；src 先给占位图
          node.url = PLACEHOLDER;
          (node.data.hProperties as Record<string, string>).dataAssetRef =
            `${ASSET_SCHEME}${fileId}`;
        }
      }
      if ("children" in node && Array.isArray(node.children)) {
        node.children.forEach(child => walk(child as RootContent));
      }
    };
    walk(tree);
  };
}

/** KaTeX 输出用到 MathML 与大量 class/style，默认 schema 会把它清空，需要显式放开 */
const KATEX_TAGS = [
  "math",
  "semantics",
  "annotation",
  "mrow",
  "mi",
  "mo",
  "mn",
  "ms",
  "mtext",
  "mspace",
  "mstyle",
  "mfrac",
  "msqrt",
  "mroot",
  "mtable",
  "mtr",
  "mtd",
  "mlabeledtr",
  "mover",
  "munder",
  "munderover",
  "msub",
  "msup",
  "msubsup",
  "mmultiscripts",
  "mprescripts",
  "none",
  "menclose",
  "mpadded",
  "mphantom",
  "mglyph",
  "annotation-xml"
];

const schema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), ...KATEX_TAGS],
  attributes: {
    ...defaultSchema.attributes,
    // 标题锚点
    h2: [...(defaultSchema.attributes?.h2 ?? []), "id"],
    h3: [...(defaultSchema.attributes?.h3 ?? []), "id"],
    h4: [...(defaultSchema.attributes?.h4 ?? []), "id"],
    // 代码高亮 class（language-*）与 katex 的 class/style
    span: [...(defaultSchema.attributes?.span ?? []), "className", "style"],
    div: [...(defaultSchema.attributes?.div ?? []), "className", "style"],
    code: [...(defaultSchema.attributes?.code ?? []), "className"],
    // 私密资源标记
    img: [
      ...(defaultSchema.attributes?.img ?? []),
      "dataAssetId",
      "dataAssetRef",
      "loading",
      "decoding"
    ],
    a: [...(defaultSchema.attributes?.a ?? []), "dataAssetId", "rel"],
    // KaTeX 在 MathML 上用到这些属性
    math: ["xmlns", "display"],
    annotation: ["encoding"],
    semantics: []
  },
  // 图片地址允许 data:（私密资源取回前先用 1×1 占位图，避免 src="" 触发整页请求）；
  // 链接地址允许 asset:（附件下载链接 `[名字](asset:f_xxx)`，配合 dataAssetId 由渲染层接管）
  protocols: {
    ...defaultSchema.protocols,
    src: [...(defaultSchema.protocols?.src ?? []), "data"],
    href: [...(defaultSchema.protocols?.href ?? []), "asset"]
  },
  /**
   * 默认会给 id 加 `user-content-` 前缀（防 DOM clobbering）。
   * 这里关掉：目录锚点与 `#hash` 跳转必须和前台 id 完全一致；
   * 而且正文不允许原始 HTML，标题 id 全由 rehype-slug 从标题文本生成，不是作者可控的任意 id。
   */
  clobberPrefix: ""
};

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm, { singleTilde: false })
  .use(remarkMath)
  .use(remarkAssetRefs)
  .use(remarkRehype)
  .use(rehypeSlug)
  .use(rehypeKatex, { strict: "ignore" })
  .use(rehypeSanitize, schema as never)
  .use(rehypeStringify);

/** 渲染结果缓存：编辑时每次输入都渲染，同一个正文只算一次 */
const htmlCache = new Map<string, string>();
const MAX_CACHE = 40;

export async function renderMarkdown(body: string): Promise<string> {
  const source = body ?? "";
  const cached = htmlCache.get(source);
  if (cached !== undefined) return cached;

  const file = await processor.process(source);
  const html = String(file);
  htmlCache.set(source, html);
  if (htmlCache.size > MAX_CACHE) {
    const oldest = htmlCache.keys().next().value;
    if (oldest !== undefined) htmlCache.delete(oldest);
  }
  return html;
}

export interface HeadingItem {
  id: string;
  text: string;
  level: number;
}

/**
 * 从渲染结果里抽目录。
 * 必须去掉 KaTeX 附带的那份 MathML（读屏用），否则含公式的标题会出现两遍。
 */
export function extractHeadings(html: string): HeadingItem[] {
  if (!html) return [];
  const doc = new DOMParser().parseFromString(html, "text/html");
  return Array.from(doc.querySelectorAll("h2, h3"))
    .filter(el => !!el.id)
    .map(el => {
      const clone = el.cloneNode(true) as HTMLElement;
      clone.querySelectorAll(".katex-mathml").forEach(node => node.remove());
      return {
        id: el.id,
        text: (clone.textContent ?? "").trim(),
        level: el.tagName === "H2" ? 2 : 3
      };
    });
}

/**
 * 字数口径：Unicode 码点（与后端 capabilities.content.charCounting 一致）。
 * 用 Array.from 而不是 length，避免 emoji／扩展汉字被算成两个字符。
 */
export function countChars(text: string | null | undefined): number {
  if (!text) return 0;
  return Array.from(text).length;
}

/** 粗略统计“段落数”，用于空正文提示 */
export function countParagraphs(text: string | null | undefined): number {
  if (!text) return 0;
  return text.split(/\n{2,}/).filter(block => block.trim()).length;
}

export type { HastRoot };
