const Layout = () => import("@/layout/index.vue");

/** 书影音：条目少、字段密，编辑走抽屉，不占独立路由 */
export default {
  path: "/shelf",
  name: "Shelf",
  component: Layout,
  redirect: "/shelf/index",
  meta: {
    title: "书影音",
    rank: 3
  },
  children: [
    {
      path: "/shelf/index",
      name: "ShelfPage",
      component: () => import("@/views/shelf/index.vue"),
      meta: {
        title: "书影音",
        icon: "ep:reading"
      }
    }
  ]
} satisfies RouteConfigsTable;
