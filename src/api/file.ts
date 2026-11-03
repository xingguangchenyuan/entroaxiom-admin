import { http } from "@/utils/http";
import { enc, ifMatch, pagedQuery } from "./query";
import type {
  DeletedResult,
  FileItem,
  FileListQuery,
  FileReference,
  FileUpdatePayload,
  Paged,
  Visibility
} from "./types";

/** 文件列表 */
export const listFiles = (query: FileListQuery = {}) => {
  return http.get<Paged<FileItem>>("/files", { params: pagedQuery(query) });
};

/** 文件详情（单一真源；列表里的字段可能滞后） */
export const getFile = (fileId: string) => {
  return http.get<FileItem>(`/files/${enc(fileId)}`);
};

export interface UploadFileOptions {
  /** 展示名；不传时后端用原文件名 */
  name?: string;
  description?: string | null;
  visibility?: Visibility;
  onProgress?: (percent: number) => void;
  signal?: AbortSignal;
}

/**
 * 上传单个文件。
 *
 * 注意点：
 *  - 这里**不设置** Content-Type，让浏览器生成 multipart boundary（拦截器里已统一处理）；
 *  - 文件名用 `encodeURIComponent` 放在 FormData 的第三个参数里已由浏览器处理，
 *    不要手动拼 header，否则中文名会变成乱码；
 *  - 进度回调来自 axios 的 `onUploadProgress`，取消用 `AbortSignal`。
 */
export const uploadFile = (file: File, options: UploadFileOptions = {}) => {
  const form = new FormData();
  // 顺序很重要：普通字段先 append，文件最后 append。
  // 反过来的话，服务端在解析文件流之前读不到这些字段（大文件的 multipart 分块里
  // 字段会排在文件之后），上传就会被静默降级成 private。
  if (options.name) form.append("name", options.name);
  if (options.description) form.append("description", options.description);
  if (options.visibility) form.append("visibility", options.visibility);
  // 后端按 `file` 字段取内容
  form.append("file", file, file.name);

  return http.upload<FileItem>("/files", form, {
    signal: options.signal,
    onUploadProgress: event => {
      if (!options.onProgress) return;
      if (!event.total) {
        // 没有 content-length（分块传输）时无法算百分比，交给调用方显示“上传中”
        return;
      }
      const percent = Math.round((event.loaded / event.total) * 100);
      options.onProgress(Math.min(99, Math.max(0, percent)));
    }
  });
};

/** 修改名称／说明／可见范围（不改内容，因此不产生新版本） */
export const updateFile = (fileId: string, payload: FileUpdatePayload) => {
  return http.put<FileItem>(`/files/${enc(fileId)}`, { data: payload });
};

/**
 * 删除文件。
 * 仍被引用时后端返回 409 + FILE_IN_USE，并把引用清单放在 error.details 里，
 * 界面据此显示“被谁引用”，而不是笼统报错。
 */
export const deleteFile = (fileId: string, baseRevision: number) => {
  return http.delete<DeletedResult>(`/files/${enc(fileId)}`, {
    headers: ifMatch(baseRevision)
  });
};

/** 文件被哪些内容引用（删除前的安全检查、发布前的资源检查都会用） */
export const listFileReferences = (fileId: string) => {
  return http.get<FileReference[]>(`/files/${enc(fileId)}/references`);
};
