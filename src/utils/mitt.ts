import type { Emitter } from "mitt";
import mitt from "mitt";

/** 全局公共事件需要在此处添加类型 */
type Events = {
  openPanel: string;
  tagOnClick: string;
  logoChange: boolean;
  tagViewsChange: string;
  changLayoutRoute: string;
  tagViewsShowModel: string;
  /** 会话被主动结束（站长点了退出）：清空私密业务缓存与未保存草稿 */
  "session:cleared": void;
  /** 会话过期（401）：清空私密业务缓存，但保留内存里的未保存草稿供重新登录后恢复 */
  "session:expired": void;
  /** 另一个标签页退出了登录：本页要停止请求并清空私密缓存 */
  "session:external-logout": void;
};

export const emitter: Emitter<Events> = mitt<Events>();
