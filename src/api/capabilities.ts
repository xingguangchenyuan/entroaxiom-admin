import { http } from "@/utils/http";
import type { Capabilities } from "./types";

/**
 * 服务端能力与限制。
 *
 * 界面上所有“上限”都从这里读，不在前端写死：
 * 上传大小、允许的格式、导入包解压上限、正文字数口径……
 * 前端写死的数字迟早和后端校验不一致，结果是站长填完才被打回。
 */
export const getCapabilities = () => {
  return http.get<Capabilities>("/capabilities", undefined, {
    // 能力读不到时页面要给明确提示，这里不弹全局 toast
    silent: true,
    timeout: 8000
  });
};

/**
 * 兜底的本地默认值：只在 `/capabilities` 不可用时使用，
 * 并且必须偏**保守**（宁可比后端小，也不要让站长以为能传更大的文件）。
 * 界面在使用兜底值时会显示“限制值暂不可用，按默认值处理”。
 */
export const FALLBACK_CAPABILITIES: Capabilities = {
  upload: {
    maxFileBytes: 10 * 1024 * 1024,
    allowedKinds: ["image", "pdf", "archive", "doc", "other"],
    allowedExtensions: [
      "jpg",
      "jpeg",
      "png",
      "webp",
      "gif",
      "avif",
      "pdf",
      "zip",
      "md",
      "txt"
    ],
    maxConcurrent: 3
  },
  import: {
    maxArchiveBytes: 20 * 1024 * 1024,
    maxExpandedBytes: 200 * 1024 * 1024,
    maxEntries: 2000
  },
  content: {
    maxBodyBytes: 1024 * 1024,
    versionRetention: 20,
    maxTitleChars: 120,
    maxSummaryChars: 500,
    charCounting: "Unicode 码点"
  },
  features: {
    importZip: false,
    exportZip: false,
    versionRestore: false,
    moderationTest: false,
    serverLogout: false,
    authenticatedMedia: true
  },
  policyVersion: null
};
