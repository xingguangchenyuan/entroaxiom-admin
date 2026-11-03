import { ref, onBeforeUnmount, onMounted } from "vue";
import { onBeforeRouteLeave } from "vue-router";
import { ElMessageBox } from "element-plus";
import { message } from "@/utils/message";

/**
 * 未保存内容守卫。
 *
 * 三处都要拦，少一处就会丢稿：
 *  1. 站内切换路由（点侧栏、点标签页）；
 *  2. 刷新／关闭标签页（beforeunload）；
 *  3. 页面内的“返回列表”“切换条目”按钮 —— 这些走 `confirmLeave()`。
 *
 * 站长在确认框里选了“暂存草稿并离开”时，会同步调用 `onLeave()`
 * （通常是把当前表单写进草稿箱），让“暂存”承诺在每一条离开路径上都兑现，
 * 而不是只对页面上某一个返回按钮生效。
 *
 * `onLeave()` 返回 false 或抛错＝暂存失败：此时**不放行离开**，保留当前表单，
 * 并提示失败原因。这样“暂存成功才离开”在文章和书影音两条路上语义一致。
 */
export function useUnsavedGuard(options?: {
  /** 给用户看的对象描述，例如“这篇随笔” */
  subject?: () => string;
  /**
   * 站长确认“暂存草稿并离开”后立即调用：把当前内容暂存为草稿。
   * 返回 false 或抛出异常＝暂存失败，本次离开会被取消。
   */
  onLeave?: () => boolean | void | Promise<boolean | void>;
}) {
  const dirty = ref(false);
  const saving = ref(false);
  const subject = options?.subject ?? (() => "当前内容");

  const markDirty = () => {
    dirty.value = true;
  };
  const markClean = () => {
    dirty.value = false;
  };

  const beforeUnload = (event: BeforeUnloadEvent) => {
    if (!dirty.value) return;
    // 浏览器只允许通用文案，不能自定义
    event.preventDefault();
    event.returnValue = "";
  };

  onMounted(() => window.addEventListener("beforeunload", beforeUnload));
  onBeforeUnmount(() =>
    window.removeEventListener("beforeunload", beforeUnload)
  );

  /** 返回 true 表示可以离开；返回 false 表示放弃离开 */
  const confirmLeave = async (): Promise<boolean> => {
    if (!dirty.value) return true;
    try {
      await ElMessageBox.confirm(
        `${subject()}还有未保存的修改。离开会把它们暂存为本地草稿，你可以稍后再回来继续。`,
        "还有未保存的修改",
        {
          confirmButtonText: "暂存草稿并离开",
          cancelButtonText: "留在这里",
          type: "warning",
          distinguishCancelAndClose: true
        }
      );
    } catch {
      // 取消 / 关闭 / Esc：留在当前页面
      return false;
    }
    // 兑现“暂存草稿并离开”：确认离开的同时把内容存进草稿箱，
    // 这样无论从哪个路径离开（返回按钮、侧栏、标签页切换）都不会丢稿。
    try {
      const result = await options?.onLeave?.();
      if (result === false) {
        message("暂存失败，已取消离开。请检查后再试。", { type: "error" });
        return false;
      }
      return true;
    } catch {
      message("暂存失败，已取消离开。请检查后再试。", { type: "error" });
      return false;
    }
  };

  onBeforeRouteLeave(async () => {
    if (!dirty.value) return true;
    return await confirmLeave();
  });

  return { dirty, saving, markDirty, markClean, confirmLeave };
}
