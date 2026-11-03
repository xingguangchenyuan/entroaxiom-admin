import Cookies from "js-cookie";
import { useUserStoreHook } from "@/store/modules/user";
import { storageLocal, isString, isIncludeAllChildren } from "@pureadmin/utils";

export interface DataInfo<T> {
  /** token */
  accessToken: string;
  /** `accessToken`的过期时间（时间戳） */
  expires: T;
  /** 用于调用刷新accessToken的接口时所需的token */
  refreshToken: string;
  /** 头像 */
  avatar?: string;
  /** 用户名 */
  username?: string;
  /** 昵称 */
  nickname?: string;
  /** 当前登录用户的角色 */
  roles?: Array<string>;
  /** 当前登录用户的按钮级别权限 */
  permissions?: Array<string>;
}

export const userKey = "user-info";
export const TokenKey = "authorized-token";

/**
 * `refreshToken` 只驻留内存，不落 cookie / localStorage。
 *
 * 以前它和 `accessToken` 一起塞进同一个 JS 可读的 cookie：一次 XSS 就能拿到长期凭证，
 * 换出永不过期的会话，等于把 accessToken 短有效期的设计整个作废。
 * 现在内存里丢了就按“需要重新登录”处理 —— 宁可多登一次，也不留可被读走的长期凭证。
 *
 * 真正的终态是后端下发 `HttpOnly; Secure; SameSite=Strict` 的会话 cookie，
 * 前端完全不接触任何令牌、刷新由浏览器自动带 cookie 完成，见 `docs/ADMIN_API.md`
 * 「鉴权契约」一节。
 */
let refreshTokenInMemory = "";

export function getRefreshToken(): string {
  return refreshTokenInMemory;
}

export function setRefreshTokenInMemory(token: string) {
  refreshTokenInMemory = token ?? "";
}

/**
 * 通过`multiple-tabs`是否在`cookie`中，判断用户是否已经登录系统，
 * 从而支持多标签页打开已经登录的系统后无需再登录。
 * 浏览器完全关闭后`multiple-tabs`将自动从`cookie`中销毁，
 * 再次打开浏览器需要重新登录系统
 * */
export const multipleTabsKey = "multiple-tabs";

/**
 * 获取`token`。
 * 返回 `undefined` 表示“没有可用凭证”，调用方必须按未登录处理 ——
 * 不要返回一个没有 accessToken 的空壳对象，否则会发出 `Authorization: Bearer undefined` 的请求。
 */
export function getToken(): DataInfo<number> | undefined {
  const raw = Cookies.get(TokenKey);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as DataInfo<number>;
      if (typeof parsed?.accessToken === "string" && parsed.accessToken) {
        if (parsed.refreshToken) {
          // 老版本写进 cookie 的 refreshToken：迁到内存后立刻从 cookie 里抹掉，
          // 避免"升级后仍然带着可读长期凭证"这种半新半旧状态。
          setRefreshTokenInMemory(parsed.refreshToken);
          Cookies.set(
            TokenKey,
            JSON.stringify({
              accessToken: parsed.accessToken,
              expires: parsed.expires
            }),
            {
              sameSite: "Strict",
              secure: window.location.protocol === "https:"
            }
          );
        }
        return { ...parsed, refreshToken: "" };
      }
    } catch {
      // Cookie 被写坏：清掉，按未登录处理
      Cookies.remove(TokenKey);
    }
  }
  // 退化为“只读资料”的本地副本（不含令牌），用于页面刷新后立刻渲染昵称／头像
  const fallback = storageLocal().getItem<DataInfo<number>>(userKey);
  return fallback?.accessToken ? fallback : undefined;
}

/**
 * @description 设置`token`以及一些必要信息并采用无感刷新`token`方案
 * 无感刷新：后端返回`accessToken`（访问接口使用的`token`）、`refreshToken`（用于调用刷新`accessToken`的接口时所需的`token`，`refreshToken`的过期时间（比如30天）应大于`accessToken`的过期时间（比如2小时））、`expires`（`accessToken`的过期时间）
 * cookie 里只放 `accessToken` + `expires`（过期自动销毁），`refreshToken` 只留在内存（见上方注释）；
 * `avatar`、`username`、`nickname`、`roles`、`permissions` 这些展示信息放在 `user-info` 的 localStorage 里。
 * 同源部署时 cookie 追加 `SameSite=Strict`，https 下再加 `Secure`，避免被第三方页面顺带带上。
 */
export function setToken(data: DataInfo<Date>) {
  let expires = 0;
  const { accessToken, refreshToken } = data;
  const { isRemembered, loginDay } = useUserStoreHook();
  expires = new Date(data.expires).getTime(); // 如果后端直接设置时间戳，将此处代码改为expires = data.expires，然后把上面的DataInfo<Date>改成DataInfo<number>即可
  setRefreshTokenInMemory(refreshToken ?? "");
  const cookieString = JSON.stringify({ accessToken, expires });

  const cookieOptions: Cookies.CookieAttributes = {
    // 同源后台：Strict 让跨站请求根本不带这份 cookie；https 下要求只走加密信道
    sameSite: "Strict",
    secure: window.location.protocol === "https:"
  };

  expires > 0
    ? Cookies.set(TokenKey, cookieString, {
        ...cookieOptions,
        expires: (expires - Date.now()) / 86400000
      })
    : Cookies.set(TokenKey, cookieString, cookieOptions);

  Cookies.set(
    multipleTabsKey,
    "true",
    isRemembered
      ? {
          expires: loginDay
        }
      : {}
  );

  function setUserKey({ avatar, username, nickname, roles, permissions }) {
    useUserStoreHook().SET_AVATAR(avatar);
    useUserStoreHook().SET_USERNAME(username);
    useUserStoreHook().SET_NICKNAME(nickname);
    useUserStoreHook().SET_ROLES(roles);
    useUserStoreHook().SET_PERMS(permissions);
    storageLocal().setItem(userKey, {
      expires,
      avatar,
      username,
      nickname,
      roles,
      permissions
    });
  }

  if (data.username && data.roles) {
    const { username, roles } = data;
    setUserKey({
      avatar: data?.avatar ?? "",
      username,
      nickname: data?.nickname ?? "",
      roles,
      permissions: data?.permissions ?? []
    });
  } else {
    const avatar =
      storageLocal().getItem<DataInfo<number>>(userKey)?.avatar ?? "";
    const username =
      storageLocal().getItem<DataInfo<number>>(userKey)?.username ?? "";
    const nickname =
      storageLocal().getItem<DataInfo<number>>(userKey)?.nickname ?? "";
    const roles =
      storageLocal().getItem<DataInfo<number>>(userKey)?.roles ?? [];
    const permissions =
      storageLocal().getItem<DataInfo<number>>(userKey)?.permissions ?? [];
    setUserKey({
      avatar,
      username,
      nickname,
      roles,
      permissions
    });
  }
}

/** 删除`token`以及key值为`user-info`的localStorage信息 */
export function removeToken() {
  Cookies.remove(TokenKey);
  Cookies.remove(multipleTabsKey);
  storageLocal().removeItem(userKey);
}

/** 格式化token（jwt格式） */
export const formatToken = (token: string): string => {
  return "Bearer " + token;
};

/** 是否有按钮级别的权限（根据登录接口返回的`permissions`字段进行判断）*/
export const hasPerms = (value: string | Array<string>): boolean => {
  if (!value) return false;
  const allPerms = "*:*:*";
  const { permissions } = useUserStoreHook();
  if (!permissions) return false;
  if (permissions.length === 1 && permissions[0] === allPerms) return true;
  const isAuths = isString(value)
    ? permissions.includes(value)
    : isIncludeAllChildren(value, permissions);
  return isAuths ? true : false;
};
