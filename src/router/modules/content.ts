const Layout = () => import("@/layout/index.vue");

/**
 * 内容。
 *
 * 列表页是同一个组件（按 meta.res 区分笔记／随笔），
 * 编辑页也复用一份，但编辑页必须知道自己在改哪一类，
 * 所以这里给两类各注册一条隐藏路由（meta.res 各自写死），
 * 而不是用一条 `/content/:res/:id` 让页面自己去猜。
 */
export default {
  path: "/content",
  name: "Content",
  component: Layout,
  redirect: "/content/notes",
  meta: {
    icon: "ep:notebook",
    title: "内容",
    rank: 1
  },
  children: [
    {
      path: "/content/notes",
      name: "ContentNotes",
      component: () => import("@/views/content/list.vue"),
      meta: {
        title: "笔记",
        res: "notes"
      }
    },
    {
      path: "/content/essays",
      name: "ContentEssays",
      component: () => import("@/views/content/list.vue"),
      meta: {
        title: "随笔",
        res: "essays"
      }
    },
    {
      path: "/content/notes/:id",
      name: "ContentNotesEdit",
      component: () => import("@/views/content/edit.vue"),
      meta: {
        title: "编辑笔记",
        res: "notes",
        showLink: false,
        activePath: "/content/notes"
      }
    },
    {
      path: "/content/essays/:id",
      name: "ContentEssaysEdit",
      component: () => import("@/views/content/edit.vue"),
      meta: {
        title: "编辑随笔",
        res: "essays",
        showLink: false,
        activePath: "/content/essays"
      }
    }
  ]
} satisfies RouteConfigsTable;
