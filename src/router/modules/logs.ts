const Layout = () => import("@/layout/index.vue");

/**
 * 日志中心。
 *
 * 单独占一个顶级分组，而不是塞进「内容管理」之类的地方：
 * 它读的是服务器上的文件与 Cloudflare，和站点的业务数据没有关系。
 */
export default {
  path: "/logs",
  name: "Logs",
  component: Layout,
  redirect: "/logs/index",
  meta: {
    title: "日志中心",
    rank: 7
  },
  children: [
    {
      path: "/logs/index",
      name: "LogsPage",
      component: () => import("@/views/logs/index.vue"),
      meta: {
        title: "日志中心",
        icon: "ep:document"
      }
    }
  ]
} satisfies RouteConfigsTable;
