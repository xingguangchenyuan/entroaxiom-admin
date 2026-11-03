import { http } from "@/utils/http";
import { enc } from "./query";
import type {
  ContentRes,
  ImportCommitPayload,
  ImportCommitResult,
  ImportPreview
} from "./types";

/**
 * Markdown / ZIP 导入。
 *
 * 三步，任何一步都不能跳：
 *  1. 上传包 → 后端只做**预检**（不解压到站点目录、不写库），返回候选与资源映射；
 *  2. 选择候选（ZIP 里有多篇 Markdown 时必须由站长指定），拿到该篇的草稿预览；
 *  3. 提交：可以新建，也可以更新同 ID 的既有内容（更新要带 baseRevision）。
 *
 * `importId` 是临时的：过期或页面刷新后必须重新上传，前端不把它持久化。
 */

export interface ImportUploadOptions {
  onProgress?: (percent: number) => void;
  signal?: AbortSignal;
}

/**
 * 上传待导入的 .md 或 .zip。
 * 这里只传文件本身，类型（随笔／笔记）由站长在界面上选后随 commit 一起下发。
 */
export const uploadImport = (
  file: File,
  type: ContentRes,
  options: ImportUploadOptions = {}
) => {
  const form = new FormData();
  // 顺序很重要：type 先 append，文件最后 append（服务端已改成顺序无关，这里是双保险）
  form.append("type", type);
  form.append("file", file, file.name);

  return http.upload<ImportPreview>("/imports/preview", form, {
    signal: options.signal,
    timeout: 180000,
    onUploadProgress: event => {
      if (!options.onProgress || !event.total) return;
      options.onProgress(
        Math.min(99, Math.round((event.loaded / event.total) * 100))
      );
    }
  });
};

/** 选定 ZIP 里的某一篇 Markdown，返回该篇的预检结果 */
export const selectImportCandidate = (importId: string, path: string) => {
  return http.post<ImportPreview>(`/imports/${enc(importId)}/select`, {
    data: { path }
  });
};

/** 提交导入 */
export const commitImport = (
  importId: string,
  payload: ImportCommitPayload
) => {
  return http.post<ImportCommitResult>(`/imports/${enc(importId)}/commit`, {
    data: payload,
    timeout: 120000
  });
};

/** 放弃这次导入（释放后端暂存文件） */
export const cancelImport = (importId: string) => {
  return http.delete<void>(`/imports/${enc(importId)}`, { silent: true });
};
