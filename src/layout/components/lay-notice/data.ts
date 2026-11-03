export interface ListItem {
  avatar: string;
  title: string;
  datetime: string;
  type: string;
  description: string;
  status?: "primary" | "success" | "warning" | "info" | "danger";
  extra?: string;
}

export interface TabItem {
  key: string;
  name: string;
  list: ListItem[];
  emptyText: string;
}

/**
 * 通知栏数据。模板自带的演示数据（含指向第三方站点的头像地址）已清空。
 * 之后可以把“待审核的留言数”等真实内容接到这里。
 */
export const noticesData: TabItem[] = [
  { key: "1", name: "通知", list: [], emptyText: "暂无通知" },
  { key: "2", name: "消息", list: [], emptyText: "暂无消息" },
  { key: "3", name: "待办", list: [], emptyText: "暂无待办" }
];
