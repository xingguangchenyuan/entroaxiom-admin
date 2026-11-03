const Layout = () => import("@/layout/index.vue");

/** 留言过滤规则：词表维护 + 样例测试 */
export default {
  path: "/moderation",
  name: "Moderation",
  component: Layout,
  redirect: "/moderation/index",
  meta: {
    title: "过滤规则",
    rank: 5
  },
  children: [
    {
      path: "/moderation/index",
      name: "ModerationPage",
      component: () => import("@/views/moderation/index.vue"),
      meta: {
        title: "过滤规则",
        icon: "ep:filter"
      }
    }
  ]
} satisfies RouteConfigsTable;
