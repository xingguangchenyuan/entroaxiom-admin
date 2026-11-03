import { defineStore } from "pinia";
import { getCapabilities, FALLBACK_CAPABILITIES } from "@/api/capabilities";
import type { Capabilities } from "@/api/types";

/**
 * 服务端能力。
 *
 * 页面里的“上限”一律从这里取：上传大小、允许格式、正文长度、版本保留数……
 * 读取失败不会让页面报错，而是退回保守默认值，并让界面明确显示“限制值暂不可用”，
 * 这样站长不会因为一个 8 秒的超时看到半残的界面，也不会误以为真能传 100 MB。
 */
export const useCapabilitiesStore = defineStore("capabilities", {
  state: () => ({
    data: FALLBACK_CAPABILITIES as Capabilities,
    /** 是否成功读到服务端能力 */
    authoritative: false,
    /** 首次读取是否已结束（无论成功失败） */
    loaded: false,
    loading: false,
    error: "" as string
  }),
  getters: {
    maxFileBytes: state => state.data.upload.maxFileBytes,
    allowedExtensions: state => state.data.upload.allowedExtensions,
    maxBodyBytes: state => state.data.content.maxBodyBytes,
    maxTitleChars: state => state.data.content.maxTitleChars,
    maxSummaryChars: state => state.data.content.maxSummaryChars,
    versionRetention: state => state.data.content.versionRetention,
    features: state => state.data.features
  },
  actions: {
    async ensure(): Promise<void> {
      if (this.loaded || this.loading) return;
      this.loading = true;
      try {
        const result = await getCapabilities();
        if (result) {
          this.data = { ...FALLBACK_CAPABILITIES, ...result };
          this.authoritative = true;
          this.error = "";
        }
      } catch (error) {
        // 不发全局提示：能力读不到不致命，界面上有明确标注
        this.error = (error as Error)?.message ?? "限制值读取失败";
        this.authoritative = false;
      } finally {
        this.loading = false;
        this.loaded = true;
      }
    },
    /** 退出登录后清回默认值，避免把上一个账号环境的能力沿用 */
    reset() {
      this.data = FALLBACK_CAPABILITIES;
      this.authoritative = false;
      this.loaded = false;
      this.loading = false;
      this.error = "";
    }
  }
});
