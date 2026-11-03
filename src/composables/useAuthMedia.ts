import { ref, watch, onScopeDispose, type Ref } from "vue";
import { resolveFileUrl } from "@/utils/media";

export type MediaState = "idle" | "loading" | "ready" | "error";

/**
 * 组件里读取私密资源。
 *
 * 为什么需要它：`<img src="/api/files/xxx">` 不会自动带 Authorization 头，
 * 私密图片会 401。这里统一走“带鉴权的请求 → 对象 URL”，并且：
 *  - 同一个文件在多个组件里只请求一次（utils/media.ts 里做了并发合并与缓存）；
 *  - 卸载或切换文件时忽略迟到的结果，不会把 A 图显示成 B；
 *  - 失败有明确状态，可重试，不会显示裂图。
 */
export function useAuthMedia(fileId: Ref<string | null | undefined>) {
  const src = ref<string | null>(null);
  const state = ref<MediaState>("idle");
  const error = ref<string>("");
  let token = 0;

  const load = async () => {
    const id = fileId.value;
    token += 1;
    const current = token;
    error.value = "";
    if (!id) {
      src.value = null;
      state.value = "idle";
      return;
    }
    state.value = "loading";
    try {
      const url = await resolveFileUrl(id);
      if (current !== token) return;
      src.value = url;
      state.value = "ready";
    } catch (err) {
      if (current !== token) return;
      src.value = null;
      state.value = "error";
      error.value = (err as Error)?.message ?? "图片读取失败";
    }
  };

  watch(fileId, load, { immediate: true });

  let disposed = false;
  onScopeDispose(() => {
    disposed = true;
    token += 1;
  });

  return {
    src,
    state,
    error,
    retry: () => {
      if (!disposed) load();
    }
  };
}
