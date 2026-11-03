const Layout = () => import("@/layout/index.vue");

/** 文件库：图片／PDF／音视频的私密存储，前台通过鉴权接口读取 */
export default {
  path: "/library",
  name: "Library",
  component: Layout,
  redirect: "/library/index",
  meta: {
    title: "文件库",
    rank: 2
  },
  children: [
    {
      path: "/library/index",
      name: "LibraryPage",
      component: () => import("@/views/library/index.vue"),
      meta: {
        title: "文件库",
        icon: "ep:folder-opened"
      }
    }
  ]
} satisfies RouteConfigsTable;
