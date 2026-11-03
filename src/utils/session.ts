import { userKey } from "@/utils/auth";
import { emitter } from "@/utils/mitt";

/**
 * 跨标签页会话一致性。
 *
 * 纯后台常见的事故：A 标签页退出登录，B 标签页仍拿旧凭证继续请求，
 * 或者 B 标签页已经换了账号，A 标签页还在渲染上一个人的数据。
 *
 * 这里监听 `localStorage` 的 `storage` 事件（key = user-info，退出时被删除），
 * 在**其它**标签页里同步收尾：释放私密媒体缓存、中止在途请求、回到登录页。
 * 注意 `storage` 事件只在“别的标签页改了存储”时触发，本页自己改不会触发，天然不会误伤。
 */
export function installSessionWatch(options: {
  /** 本页当前是否认为自己处于登录状态 */
  isLoggedIn: () => boolean;
  /** 确认会话已失效时执行（清缓存 + 跳登录页） */
  onExternalLogout: () => void;
}) {
  const { isLoggedIn, onExternalLogout } = options;

  window.addEventListener("storage", event => {
    // 只在被删除／被清空时触发（重新登录会写入新的 user-info）
    if (event.key !== userKey || event.newValue) return;
    if (!isLoggedIn()) return;
    emitter.emit("session:external-logout");
    onExternalLogout();
  });

  // 页面从后台回到前台时检查凭证是否还在
  // （覆盖 storage 事件不可用的情况：某些隐私模式、或另一个标签页被整体关闭）
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    if (!isLoggedIn()) return;
    const hasUserInfo = !!localStorage.getItem(userKey);
    const hasCookie = document.cookie
      .split(";")
      .some(item => item.trim().startsWith("authorized-token="));
    if (hasUserInfo || hasCookie) return;
    emitter.emit("session:external-logout");
    onExternalLogout();
  });
}
