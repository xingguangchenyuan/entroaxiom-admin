import { http } from "@/utils/http";
import { buildQuery } from "./query";
import type {
  CloudflareView,
  LogPage,
  LogQuery,
  LogSource,
  SecuritySummary
} from "./types";

/**
 * 日志中心。
 *
 * 这些接口**只读**：没有任何写入、删除、清空日志的端点，后端也只做「读文件尾部」。
 * 之所以刻意不给「清空日志」，是因为那等于给后台加了一个能抹掉入侵痕迹的按钮。
 *
 * 另外注意：日志里含有访客 IP 与 UA，属于隐私数据。界面不提供「导出全部」的一键下载，
 * 只导出当前筛选结果，并且导出的文件由站长自己保管。
 */

/** 可选的日志来源（不含真实路径） */
export const listLogSources = () => {
  return http.get<LogSource[]>("/logs/sources");
};

/** 取某来源的尾部日志；不传 source 时后端按默认来源返回 */
export const listLogs = (query: LogQuery = {}) => {
  return http.get<LogPage>("/logs", {
    params: buildQuery({
      source: query.source,
      tail: query.tail,
      q: query.keyword,
      level: query.level,
      status: query.status,
      suspect: query.suspect
    })
  });
};

/** 近 N 小时的攻击面聚合 */
export const getSecuritySummary = (hours = 24) => {
  return http.get<SecuritySummary>("/logs/security", {
    params: buildQuery({ hours })
  });
};

/** Cloudflare 防火墙事件；后端缓存 10 分钟，前端不需要自己再节流 */
export const getCloudflareEvents = (hours = 24) => {
  return http.get<CloudflareView>("/logs/cloudflare", {
    params: buildQuery({ hours })
  });
};
