import { ref, reactive, computed, type Ref } from "vue";
import type { ApiError } from "@/utils/http/error";
import type { Paged } from "@/api/types";

export interface PageState<Q> {
  query: Q;
  page: number;
  pageSize: number;
}

/**
 * 列表页通用装载器。
 *
 * 这个后台的列表都有一个共同点：筛选条件 + 分页 + 竞态。
 * 常见的坑是“快速改筛选后，前一个请求晚返回，把新结果覆盖掉”，
 * 所以每次加载都带一个递增序号，只有最新一次的结果会被采纳。
 *
 * 另外明确区分两种空：
 *  - 没有任何数据（total === 0 且没有筛选）→ “还没有内容”
 *  - 筛选后为空 → “没有匹配的结果”，并给出“清空筛选”的出口
 */
export function usePagedList<T, Q extends object>(options: {
  fetcher: (query: Q & { page: number; pageSize: number }) => Promise<Paged<T>>;
  initialQuery: Q;
  pageSize?: number;
  /** 立即加载 */
  immediate?: boolean;
}) {
  const items = ref<T[]>([]) as Ref<T[]>;
  const total = ref(0);
  const page = ref(1);
  const pageSize = ref(options.pageSize ?? 20);
  const loading = ref(false);
  const error = ref<ApiError | Error | null>(null);
  const query = reactive({ ...options.initialQuery }) as Q;
  let seq = 0;
  let mounted = true;

  const isFiltered = computed(() =>
    Object.values(query as Record<string, unknown>).some(v => {
      // false 表示开关没打开，不是筛选条件；否则“全部数据为空”会被误判成“筛选无结果”
      if (v === undefined || v === null || v === "" || v === false)
        return false;
      if (Array.isArray(v)) return v.length > 0;
      return true;
    })
  );

  const load = async () => {
    seq += 1;
    const current = seq;
    loading.value = true;
    error.value = null;
    try {
      const result = await options.fetcher({
        ...(query as Q),
        page: page.value,
        pageSize: pageSize.value
      });
      if (!mounted || current !== seq) return;
      items.value = result?.items ?? [];
      total.value = result?.total ?? 0;
    } catch (err) {
      if (!mounted || current !== seq) return;
      error.value = err as Error;
      items.value = [];
      total.value = 0;
    } finally {
      if (mounted && current === seq) loading.value = false;
    }
  };

  /** 修改筛选条件后自动回到第一页 */
  const search = () => {
    page.value = 1;
    return load();
  };

  const reset = () => {
    Object.assign(query, options.initialQuery);
    page.value = 1;
    return load();
  };

  const setPage = (next: number) => {
    page.value = next;
    return load();
  };

  /**
   * 删除一条之后刷新。
   * 当前页被删空且不在第一页时回退一页，否则站长会停在空白页，误以为数据全没了。
   */
  const loadAfterRemove = () => {
    if (items.value.length <= 1 && page.value > 1) page.value -= 1;
    return load();
  };

  const setPageSize = (next: number) => {
    pageSize.value = next;
    page.value = 1;
    return load();
  };

  if (options.immediate !== false) load();

  return {
    items,
    total,
    page,
    pageSize,
    loading,
    error,
    query,
    isFiltered,
    load,
    search,
    reset,
    setPage,
    setPageSize,
    loadAfterRemove,
    /** 组件卸载时调用，避免卸载后 setState */
    dispose: () => {
      mounted = false;
      seq += 1;
    }
  };
}
