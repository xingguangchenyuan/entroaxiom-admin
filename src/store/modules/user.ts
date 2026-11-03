import { defineStore } from "pinia";
import {
  type userType,
  store,
  router,
  resetRouter,
  routerArrays,
  storageLocal
} from "../utils";
import {
  type UserResult,
  type RefreshTokenResult,
  getLogin,
  logoutApi,
  refreshTokenApi
} from "@/api/user";
import { useMultiTagsStoreHook } from "./multiTags";
import { type DataInfo, setToken, removeToken, userKey } from "@/utils/auth";
import { emitter } from "@/utils/mitt";

/** 退出原因：主动退出要清空草稿，会话过期则留在内存里等重新登录后恢复 */
export type LogoutReason = "manual" | "expired";

export const useUserStore = defineStore("pure-user", {
  state: (): userType => ({
    // 头像
    avatar: storageLocal().getItem<DataInfo<number>>(userKey)?.avatar ?? "",
    // 用户名
    username: storageLocal().getItem<DataInfo<number>>(userKey)?.username ?? "",
    // 昵称
    nickname: storageLocal().getItem<DataInfo<number>>(userKey)?.nickname ?? "",
    // 页面级别权限
    roles: storageLocal().getItem<DataInfo<number>>(userKey)?.roles ?? [],
    // 按钮级别权限
    permissions:
      storageLocal().getItem<DataInfo<number>>(userKey)?.permissions ?? [],
    // 是否勾选了登录页的免登录
    isRemembered: false,
    // 登录页的免登录存储几天，默认7天
    loginDay: 7
  }),
  actions: {
    /** 存储头像 */
    SET_AVATAR(avatar: string) {
      this.avatar = avatar;
    },
    /** 存储用户名 */
    SET_USERNAME(username: string) {
      this.username = username;
    },
    /** 存储昵称 */
    SET_NICKNAME(nickname: string) {
      this.nickname = nickname;
    },
    /** 存储角色 */
    SET_ROLES(roles: Array<string>) {
      this.roles = roles;
    },
    /** 存储按钮级别权限 */
    SET_PERMS(permissions: Array<string>) {
      this.permissions = permissions;
    },
    /** 存储是否勾选了登录页的免登录 */
    SET_ISREMEMBERED(bool: boolean) {
      this.isRemembered = bool;
    },
    /** 设置登录页的免登录存储几天 */
    SET_LOGINDAY(value: number) {
      this.loginDay = Number(value);
    },
    /** 登入 */
    async loginByUsername(data) {
      return new Promise<UserResult>((resolve, reject) => {
        getLogin(data)
          .then(data => {
            // 拦截器已脱壳：这里就是会话载荷
            if (data?.accessToken) setToken(data);
            resolve(data);
          })
          .catch(error => {
            reject(error);
          });
      });
    },
    /**
     * 登出。
     *
     * - `manual`（默认）：站长自己点“退出登录”。清本地会话、清私密缓存、清未保存草稿。
     * - `expired`：令牌失效被踢回登录页。同样清本地会话与私密缓存，
     *   但**保留**内存里的未保存编辑内容，重新登录同一账号后可以恢复（见 utils/draftVault.ts）。
     *
     * `silent` 用于响应拦截器里已经提示过的情况，避免重复提示。
     */
    logOut(reason: LogoutReason = "manual", options?: { silent?: boolean }) {
      const wasLoggedIn = !!this.username || !!this.roles?.length;
      // 服务端撤销是后端依赖，失败也照常退出（前端不能因为接口不通就退不出去）
      if (wasLoggedIn) logoutApi().catch(() => undefined);

      this.username = "";
      this.roles = [];
      this.permissions = [];
      this.avatar = "";
      this.nickname = "";
      removeToken();
      useMultiTagsStoreHook().handleTags("equal", [...routerArrays]);
      resetRouter();
      // 通知业务缓存层：释放对象 URL、清掉私密实体缓存
      emitter.emit(
        reason === "expired" ? "session:expired" : "session:cleared"
      );
      if (!options?.silent || reason === "manual") {
        // 主动退出不需要提示，会话过期由拦截器提示过
      }
      router.push("/login");
    },
    /** 刷新`token` */
    async handRefreshToken(data) {
      return new Promise<RefreshTokenResult>((resolve, reject) => {
        refreshTokenApi(data)
          .then(data => {
            if (data?.accessToken) {
              setToken(data);
              resolve(data);
            } else {
              // 后端没给 accessToken 也必须有个结论：只 resolve 不 reject 的话
              // 这个 promise 永远不会落定，排队等 token 的请求会一起卡死。
              reject(new Error("刷新登录态失败：响应里没有 accessToken"));
            }
          })
          .catch(error => {
            reject(error);
          });
      });
    }
  }
});

export function useUserStoreHook() {
  return useUserStore(store);
}
