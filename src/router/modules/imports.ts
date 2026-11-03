const Layout = () => import("@/layout/index.vue");

/** 导入：上传 → 预检 → 提交，三步在当前页完成，不落独立子路由 */
export default {
  path: "/imports",
  name: "Imports",
  component: Layout,
  redirect: "/imports/index",
  meta: {
    title: "导入",
    rank: 6
  },
  children: [
    {
      path: "/imports/index",
      name: "ImportsPage",
      component: () => import("@/views/imports/index.vue"),
      meta: {
        title: "导入",
        icon: "ep:upload-filled"
      }
    }
  ]
} satisfies RouteConfigsTable;
