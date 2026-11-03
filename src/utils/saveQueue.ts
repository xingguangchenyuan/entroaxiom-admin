/**
 * 串行化任务队列（v2 修复方案 R2 的支撑工具）。
 *
 * 同一时刻只允许一个任务在飞：后到的任务排队，前一个结束后才跑下一个；
 * awaitIdle() 等已排队的全部结束。保存请求通过它串行化，
 * “晚返回的旧请求覆盖新输入”不可能发生。
 */

export interface SaveQueue {
  /** 排一个任务；返回该任务的 Promise（失败会 reject，由调用方处理） */
  enqueue<T>(task: () => Promise<T>): Promise<T>;
  /** 等已排队的任务全部结束（不吞结果，也等待失败任务之后的清理） */
  awaitIdle(): Promise<void>;
}

export function createSaveQueue(): SaveQueue {
  let chain: Promise<unknown> = Promise.resolve();
  return {
    enqueue<T>(task: () => Promise<T>): Promise<T> {
      const run = chain.then(task);
      chain = run.then(
        () => undefined,
        () => undefined
      );
      return run;
    },
    awaitIdle(): Promise<void> {
      return chain.then(() => undefined);
    }
  };
}
