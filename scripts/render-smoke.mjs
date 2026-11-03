/**
 * Markdown 渲染管线冒烟测试
 *
 * 目的：AC-04 要求"与前台支持范围一致、无原始 HTML 脚本执行"。
 * 这里直接跑 src/utils/markdown 的真实管线（unified + remark/rehype + sanitize），
 * 把渲染结果当字符串断言，不需要浏览器。
 *
 * 用法：node scripts/render-smoke.mjs
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { adminRoot, bundleModule } from "./lib/bundle.mjs";

const outDir = mkdtempSync(join(tmpdir(), "render-smoke-"));
const bundle = join(outDir, "markdown.mjs");

await bundleModule({
  entryPoints: [join(adminRoot, "src/utils/markdown/index.ts")],
  outfile: bundle
});

const { renderMarkdown, countChars, countParagraphs } = await import(
  pathToFileURL(bundle).href
);

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

/* 1. 基础语法 */
const basic = await renderMarkdown(
  "# 标题\n\n正文**加粗**，`行内码`。\n\n- 甲\n- 乙\n"
);
check("标题渲染成 h1", basic.includes("<h1"));
check("加粗渲染成 strong", basic.includes("<strong>加粗</strong>"));
check("行内码渲染成 code", basic.includes("<code>行内码</code>"));
check("无序列表渲染成 li", (basic.match(/<li>/g) ?? []).length === 2);

/* 2. GFM 表格与任务列表 */
const gfm = await renderMarkdown(
  "| 列 A | 列 B |\n| --- | --- |\n| 1 | 2 |\n\n- [x] 已完成\n- [ ] 未完成\n"
);
check("表格渲染成 table", gfm.includes("<table>"));
check("表格有表头 th", gfm.includes("<th>"));
check("任务列表渲染成复选框", gfm.includes('type="checkbox"'));
check("已完成项带 checked", gfm.includes("checked"));

/* 3. 公式（行内 + 块级） */
const math = await renderMarkdown(
  "行内 $a^2+b^2=c^2$ 与块级：\n\n$$\n\\int_0^1 x dx\n$$\n"
);
check("行内公式渲染成 katex", math.includes("katex"));
check("块级公式渲染成 katex-display", math.includes("katex-display"));
check("公式带 MathML 备份", math.includes("<math"));

/* 4. 锚点 id（与前台一致，不带 user-content- 前缀） */
const anchored = await renderMarkdown("## 一段中文标题\n\n## Another Title\n");
const anchorIds = [...anchored.matchAll(/<h2[^>]*id="([^"]+)"/g)].map(
  m => m[1]
);
check("两个 h2 都带 id", anchorIds.length === 2, anchored.slice(0, 200));
check("锚点 id 未被 clobber 前缀改写", !anchored.includes("user-content-"));

/* 5. 私密资源写法 asset:<fileId> */
const asset = await renderMarkdown("![图](asset:f_img_chart)");
check(
  "asset 引用转成 data-asset-id",
  asset.includes('data-asset-id="f_img_chart"')
);
check("asset 引用保留 asset ref", asset.includes("data-asset-ref"));
check("asset 引用不直接指向私有地址", !asset.includes('src="asset:'));
check("asset 占位图用 data URI", asset.includes('src="data:image'));

/* 5b. 附件下载链接写法 [名字](asset:<fileId>) */
const assetLink = await renderMarkdown("[下载附件](asset:f_doc_draft)");
check(
  "附件链接保留 asset 协议 href（不被 sanitize 剥掉）",
  assetLink.includes('href="asset:f_doc_draft"')
);
check(
  "附件链接带 data-asset-id",
  assetLink.includes('data-asset-id="f_doc_draft"')
);
check("附件链接不换行成别的标签", /<a [^>]*>下载附件<\/a>/.test(assetLink));

/* 6. XSS：原始 HTML 一律丢弃 */
const xss = await renderMarkdown(
  '<script>alert(1)</script>\n\n<img src=x onerror="alert(2)">\n\n[链接](javascript:alert(3))\n\n<iframe src="https://evil.example"></iframe>\n'
);
check("script 标签被丢弃", !xss.includes("<script"));
check("onerror 属性被丢弃", !xss.includes("onerror"));
check(
  "javascript: 链接被丢弃",
  !xss.includes("javascript:"),
  xss.slice(0, 300)
);
check("iframe 被丢弃", !xss.includes("<iframe"));

/* 7. 外链与图片 */
const links = await renderMarkdown(
  "[站内](/notes/abc) [站外](https://example.com/x)\n"
);
check("站内链接保留 href", links.includes('href="/notes/abc"'));
check("站外链接保留 href", links.includes('href="https://example.com/x"'));
check("链接没有 target 注入（由组件层加）", !links.includes("target="));

/* 8. 纯文本与空输入 */
check("空输入返回空串", (await renderMarkdown("")).trim() === "");
check(
  "纯文本包成段落",
  (await renderMarkdown("只有一行字")).includes("<p>只有一行字</p>")
);
check("字符数按码点计算", countChars("星野🌌") === 3);
check(
  "段落数按空行切分",
  countParagraphs("第一段\n\n第二段\n\n\n第三段") === 3
);

/* 9. 脚注（remark-gfm） */
const foot = await renderMarkdown("正文[^1]\n\n[^1]: 脚注内容\n");
check("脚注渲染出 footnotes 区块", foot.includes("footnotes"));

rmSync(outDir, { recursive: true, force: true });

console.log("\nMarkdown 渲染冒烟测试\n");
for (const line of results) console.log(line);
console.log(
  `\n${results.length - failures}/${results.length} 通过${failures ? `，${failures} 项失败` : ""}\n`
);
process.exit(failures ? 1 : 0);
