/**
 * 用 esbuild 的 JS API 打包一段被测源码。
 *
 * 为什么不用 `node_modules/.pnpm/@esbuild+win32-x64@x.y.z/node_modules/@esbuild/win32-x64/esbuild.exe`：
 * 那条路径同时写死了 pnpm 的内部版本目录、平台包名和 Windows 可执行文件名，
 * 在 Linux/WSL（@esbuild/linux-x64/esbuild）或 pnpm 升级后必然失败。
 * JS API 由 esbuild 自己按当前平台挑选二进制，Windows / Linux / macOS 都成立。
 *
 * esbuild 已在本仓库声明为直接 devDependency（见 package.json），
 * 因此 `import { build } from "esbuild"` 在安装完成后总能解析到。
 */
import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** admin 仓库根目录（scripts/lib/ 的上两级）。 */
export const adminRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  ".."
);

/**
 * @param {object} options
 * @param {string[]} options.entryPoints 入口文件（绝对路径或相对 cwd 的路径）
 * @param {string} options.outfile 输出文件
 * @param {"esm" | "cjs"} [options.format]
 * @param {"node" | "browser" | "neutral"} [options.platform]
 * @returns {Promise<string>} outfile
 */
export async function bundleModule({
  entryPoints,
  outfile,
  format = "esm",
  platform = "node"
}) {
  await build({
    entryPoints,
    outfile,
    bundle: true,
    format,
    platform,
    logLevel: "warning",
    sourcemap: false,
    // 被测代码只用 TS 语法，不需要额外的 loader 配置
    target: "node20"
  });
  return outfile;
}
