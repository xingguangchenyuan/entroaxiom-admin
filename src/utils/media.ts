import { ref } from "vue";
import { http } from "@/utils/http";
import { emitter } from "@/utils/mitt";

/**
 * 私密资源的内存读取层。
 *
 * 为什么不能直接把地址写进 `<img src>`：管理端用 `Authorization: Bearer ...` 认证，
 * 普通 `<img>`、PDF `<object>` 和 `<a download>` 不会自动带这个请求头，
 * 所以私密图片／PDF 必须先用带鉴权的请求取回 Blob，再换成有生命周期的对象 URL。
 *
 * 边界：
 *  - 只存内存，不写 localStorage / IndexedDB / Cache Storage；
 *  - 以“会话 + 文件 ID”为边界，退出登录即全部释放并中止未完成请求；
 *  - token 绝不进入 URL、正文或日志。
 */

/** 正文里的稳定资源引用写法：`asset:<fileId>` */
const ASSET_PREFIX = "asset:";

export function makeAssetRef(fileId: string): string {
  return `${ASSET_PREFIX}${fileId}`;
}

/** 判断一个 Markdown 里的地址是不是稳定资源引用 */
export function isAssetRef(value: string | null | undefined): boolean {
  return typeof value === "string" && value.startsWith(ASSET_PREFIX);
}

/** 从稳定引用里取出文件 ID；不是资源引用时返回 null */
export function assetIdOf(value: string | null | undefined): string | null {
  if (!isAssetRef(value)) return null;
  const id = value.slice(ASSET_PREFIX.length).trim();
  return id || null;
}

interface CacheEntry {
  url: string;
  bytes: number;
  lastUsed: number;
}

/** 对象 URL 上限；超出后按最近最少使用淘汰（正文里图片不多，够用且不会无限涨） */
const MAX_ENTRIES = 80;

const cache = new Map<string, CacheEntry>();
const inflight = new Map<
  string,
  { controller: AbortController; promise: Promise<string> }
>();

/**
 * 会话世代。退出登录后自增：
 * 旧世代发起的请求即使晚返回，也不会把内容回填到新会话的界面里。
 */
let epoch = 0;
export const mediaEpoch = ref(0);

function remember(fileId: string, url: string, bytes: number) {
  cache.set(fileId, { url, bytes, lastUsed: Date.now() });
  if (cache.size <= MAX_ENTRIES) return;
  // 按最近最少使用淘汰，至少腾出一格
  const entries = [...cache.entries()].sort(
    (a, b) => a[1].lastUsed - b[1].lastUsed
  );
  const overflow = cache.size - MAX_ENTRIES;
  for (let i = 0; i < overflow && i < entries.length; i++) {
    const [key, entry] = entries[i];
    URL.revokeObjectURL(entry.url);
    cache.delete(key);
  }
}

/**
 * 取回一个私密文件的临时可访问地址。
 * 同一文件并发调用只会真的请求一次；失败不会留下“看起来成功”的地址。
 */
export async function resolveFileUrl(fileId: string): Promise<string> {
  const hit = cache.get(fileId);
  if (hit) {
    hit.lastUsed = Date.now();
    return hit.url;
  }
  const pending = inflight.get(fileId);
  if (pending) return pending.promise;

  const controller = new AbortController();
  const startEpoch = epoch;
  const promise = (async () => {
    try {
      const res = await http.blob(
        `/files/${encodeURIComponent(fileId)}/content`,
        {
          // 读取失败由调用方在界面上显示占位，不弹全局提示
          silent: true,
          signal: controller.signal,
          // 20 MiB 默认上限下整文件读取即可，不引入流式系统
          timeout: 60000
        }
      );
      if (startEpoch !== epoch) {
        throw new Error("会话已结束，请重新登录后再查看");
      }
      const blob = res.data;
      if (!(blob instanceof Blob) || blob.size === 0) {
        throw new Error("文件内容为空或无法读取");
      }
      const url = URL.createObjectURL(blob);
      remember(fileId, url, blob.size);
      return url;
    } finally {
      inflight.delete(fileId);
    }
  })();
  inflight.set(fileId, { controller, promise });
  return promise;
}

/** 释放单个文件的对象 URL（替换预览时用） */
export function releaseFileUrl(fileId: string) {
  const entry = cache.get(fileId);
  if (!entry) return;
  URL.revokeObjectURL(entry.url);
  cache.delete(fileId);
}

/** 终止某个文件正在进行的读取 */
export function abortFileRead(fileId: string) {
  const pending = inflight.get(fileId);
  if (!pending) return;
  pending.controller.abort();
  inflight.delete(fileId);
}

/** 清空所有临时地址与未完成请求（退出登录、跨标签页退出时调用） */
export function clearMediaCache() {
  epoch += 1;
  mediaEpoch.value = epoch;
  inflight.forEach(entry => entry.controller.abort());
  inflight.clear();
  cache.forEach(entry => URL.revokeObjectURL(entry.url));
  cache.clear();
}

/** 取回文件二进制用于下载；失败时抛 ApiError（不会把 JSON 错误当成文件保存） */
export async function fetchFileBlob(fileId: string): Promise<{
  blob: Blob;
  filename: string | null;
}> {
  const res = await http.blob(`/files/${encodeURIComponent(fileId)}/content`, {
    silent: true,
    timeout: 60000
  });
  return {
    blob: res.data,
    filename: filenameFromDisposition(res.headers?.["content-disposition"])
  };
}

/** 从 `Content-Disposition` 里取文件名，兼容 `filename*=UTF-8''...`（中文名） */
export function filenameFromDisposition(disposition: unknown): string | null {
  if (typeof disposition !== "string") return null;
  const star = /filename\*\s*=\s*([^;]+)/i.exec(disposition);
  if (star) {
    const raw = star[1].trim().replace(/^["']|["']$/g, "");
    // 形如 UTF-8''%E4%B8%AD%E6%96%87.zip
    const parts = raw.split("''");
    const encoded = parts.length > 1 ? parts[1] : raw;
    try {
      return decodeURIComponent(encoded);
    } catch {
      return encoded;
    }
  }
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(disposition);
  return plain ? plain[1].trim() : null;
}

/** 把 Blob 存成本地文件；用完立刻回收对象 URL */
export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 交给浏览器读取，下一帧回收足够
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

// 会话结束（主动退出或过期）时立即释放私密媒体
emitter.on("session:cleared", clearMediaCache);
emitter.on("session:expired", clearMediaCache);
emitter.on("session:external-logout", clearMediaCache);
