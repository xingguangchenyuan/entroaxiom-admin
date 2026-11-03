import { http } from "@/utils/http";

/**
 * 登录相关。
 *
 * 注意返回形状：`utils/http` 的响应拦截器会统一脱掉 `{ success, data, error }` 信封，
 * 所以这里拿到的是**会话载荷本身**，不要再写 `.data`。
 */
export type UserSession = {
  /** 头像 */
  avatar: string;
  /** 用户名 */
  username: string;
  /** 昵称 */
  nickname: string;
  /** 当前登录用户的角色 */
  roles: Array<string>;
  /** 按钮级别权限 */
  permissions: Array<string>;
  /** `token` */
  accessToken: string;
  /** 用于调用刷新`accessToken`的接口时所需的`token` */
  refreshToken: string;
  /** `accessToken`的过期时间（格式'xxxx/xx/xx xx:xx:xx'） */
  expires: Date;
};

export type UserResult = UserSession;

export type RefreshTokenResult = Pick<
  UserSession,
  "accessToken" | "refreshToken" | "expires"
>;

/** 登录 */
export const getLogin = (data?: object) => {
  return http.request<UserResult>("post", "/login", { data });
};

/** 刷新`token` */
export const refreshTokenApi = (data?: object) => {
  // 刷新失败由请求拦截器统一处理（回登录页并提示一次），这里不再重复弹错误提示
  return http.request<RefreshTokenResult>(
    "post",
    "/refresh-token",
    { data },
    { silent: true }
  );
};

/**
 * 退出登录：请后端撤销当前会话与刷新凭证。
 * 这是**后端依赖**（见 docs/ADMIN_API.md 的“待后端实现”标记）。
 * 无论请求成功与否，前端都会清空本地会话，所以这里是 best-effort 调用。
 */
export const logoutApi = () => {
  return http.request<{ success: boolean }>(
    "post",
    "/logout",
    undefined,
    // 退出时的错误不打扰站长，也不因为失败就不退出
    { silent: true, timeout: 5000 }
  );
};
