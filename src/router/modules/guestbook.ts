const Layout = () => import("@/layout/index.vue");

/** 留言：审阅、回复、放行／隐藏，全部在一个抽屉里完成 */
export default {
  path: "/guestbook",
  name: "Guestbook",
  component: Layout,
  redirect: "/guestbook/index",
  meta: {
    title: "留言",
    rank: 4
  },
  children: [
    {
      path: "/guestbook/index",
      name: "GuestbookPage",
      component: () => import("@/views/guestbook/index.vue"),
      meta: {
        title: "留言",
        icon: "ep:chat-dot-round"
      }
    }
  ]
} satisfies RouteConfigsTable;
