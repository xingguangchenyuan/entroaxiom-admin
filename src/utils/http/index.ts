import Axios, {
  type AxiosAdapter,
  type AxiosInstance,
  type AxiosRequestConfig,
  type AxiosResponse,
  type CustomParamsSerializer
} from "axios";
import type {
  PureHttpError,
  RequestMethods,
  PureHttpResponse,
  PureHttpRequestConfig,
  RequestParams
} from "./types.d";
import { stringify } from "qs";
import { message } from "@/utils/message";
import { getToken, getRefreshToken, formatToken } from "@/utils/auth";
import { useUserStoreHook } from "@/store/modules/user";
import {
  toApiErrorAsync,
  envelopeError,
  unwrapEnvelope,
  isAuthUrl,
  type ApiError
} from "./error";

// 相关配置请参考：www.axios-js.com/zh-cn/docs/#axios-request-config-1
const defaultConfig: AxiosRequestConfig = {
  // 所有管理接口都在同一个前缀下（由 .env 里的 VITE_API_BASE 配置，默认 /api/admin）
  baseURL: import.meta.env.VITE_API_BASE || "/api/admin",
  // 请求超时时间；上传／导入／导出这类慢请求在各自的调用里单独放宽
  timeout: 10000,
  headers: {
    Accept: "application/json, text/plain, */*",
    "Content-Type": "application/json",
    "X-Requested-With": "XMLHttpRequest"
  },
  // 数组格式参数序列化（https://github.com/axios/axios/issues/5142）
  paramsSerializer: {
    serialize: stringify as unknown as CustomParamsSerializer
  }
};

/** `FormData` 请求不能带 `application/json`：axios 见到 JSON 头会把表单转成 JSON */
function isFormData(data: unknown): data is FormData {
  return typeof FormData !== "undefined" && data instanceof FormData;
}

class PureHttp {
  constructor() {
    this.httpInterceptorsRequest();
    this.httpInterceptorsResponse();
  }

  /** `token`过期后，暂存待执行的请求（刷新失败时要让它们一起失败，不能一直挂着） */
  private static requests: Array<{
    resolve: (token: string) => void;
    reject: (reason: unknown) => void;
  }> = [];

  /** 防止同时多个请求 401 时重复提示、重复登出 */
  private static isExpiring = false;

  /** 防止重复刷新`token` */
  private static isRefreshing = false;

  /** 初始化配置对象 */
  private static initConfig: PureHttpRequestConfig = {};

  /** 保存当前`Axios`实例对象 */
  private static axiosInstance: AxiosInstance = Axios.create(defaultConfig);

  /**
   * 替换请求适配器。
   * 只有开发测试替身（`src/mock/`）用它，生产构建里没有调用方。
   */
  public static setAdapter(adapter: AxiosAdapter) {
    PureHttp.axiosInstance.defaults.adapter = adapter;
  }

  /** 重连原始请求 */
  private static retryOriginalRequest(config: PureHttpRequestConfig) {
    return new Promise((resolve, reject) => {
      PureHttp.requests.push({
        resolve: (token: string) => {
          config.headers["Authorization"] = formatToken(token);
          resolve(config);
        },
        reject
      });
    });
  }

  /** 会话失效（401）：清掉登录状态并回到登录页，同时只提示一次 */
  private static handleSessionExpired(error: ApiError) {
    if (PureHttp.isExpiring) return;
    PureHttp.isExpiring = true;
    // 会话过期与“站长主动退出”不同：过期时把未保存的编辑留在内存里，重新登录同一账号后可恢复
    useUserStoreHook().logOut("expired");
    message(error.message, { type: "warning" });
    setTimeout(() => (PureHttp.isExpiring = false), 1500);
  }

  /** 统一的失败处理：401 回登录页，其余弹错误提示（`silent` 的请求由页面自己处理） */
  private static handleError(error: ApiError, config?: PureHttpRequestConfig) {
    if (error.status === 401 && !isAuthUrl(config?.url)) {
      PureHttp.handleSessionExpired(error);
      return;
    }
    if (!config?.silent) message(error.message, { type: "error" });
  }

  /** 请求拦截 */
  private httpInterceptorsRequest(): void {
    PureHttp.axiosInstance.interceptors.request.use(
      async (config: PureHttpRequestConfig): Promise<any> => {
        // 上传使用 FormData：交给浏览器生成 multipart boundary，
        // 否则 axios 看到 application/json 会把表单序列化成 JSON（后端只能收到空文件）
        if (isFormData(config.data)) {
          delete config.headers["Content-Type"];
        }
        // 二进制响应不需要 JSON 的 Accept，避免个别代理按 JSON 报错
        if (config.responseType === "blob") {
          config.headers["Accept"] = "*/*";
        }
        // 优先判断post/get等方法是否传入回调，否则执行初始化设置等回调
        if (typeof config.beforeRequestCallback === "function") {
          config.beforeRequestCallback(config);
          return config;
        }
        if (PureHttp.initConfig.beforeRequestCallback) {
          PureHttp.initConfig.beforeRequestCallback(config);
          return config;
        }
        /** 请求白名单，放置一些不需要`token`的接口（通过设置请求白名单，防止`token`过期后再请求造成的死循环问题） */
        const whiteList = ["/refresh-token", "/login"];
        return whiteList.some(url => config.url.endsWith(url))
          ? config
          : new Promise((resolve, reject) => {
              const data = getToken();
              if (data) {
                const now = new Date().getTime();
                const expired = parseInt(data.expires) - now <= 0;
                if (expired) {
                  const refreshToken = getRefreshToken();
                  if (!refreshToken) {
                    // 长期凭证只存在内存里，刷新页面后必然拿不到：
                    // 与其发一个 body 为空的刷新请求（必然 401），不如直接回登录页。
                    // 这里必须 reject 而不是 resolve(config)：放行只会拿到真正的 401，
                    // 于是 handleSessionExpired 再跑一次，用户会看到两次「已失效」。
                    const expired = {
                      status: 401,
                      code: "SESSION_EXPIRED",
                      message: "登录状态已失效，请重新登录",
                      isCancelRequest: false,
                      __handled: true
                    } as ApiError & { __handled?: boolean };
                    PureHttp.handleSessionExpired(expired);
                    reject(expired);
                    return;
                  }
                  if (!PureHttp.isRefreshing) {
                    PureHttp.isRefreshing = true;
                    // token过期刷新
                    useUserStoreHook()
                      .handRefreshToken({ refreshToken })
                      .then(res => {
                        const token = res.accessToken;
                        config.headers["Authorization"] = formatToken(token);
                        PureHttp.requests.forEach(cb => cb.resolve(token));
                        PureHttp.requests = [];
                      })
                      .catch(error => {
                        // 刷新失败：排队的请求一起失败，并回到登录页
                        const queued = PureHttp.requests;
                        PureHttp.requests = [];
                        queued.forEach(cb => cb.reject(error));
                        PureHttp.handleSessionExpired(error);
                      })
                      .finally(() => {
                        PureHttp.isRefreshing = false;
                      });
                  }
                  resolve(PureHttp.retryOriginalRequest(config));
                } else {
                  config.headers["Authorization"] = formatToken(
                    data.accessToken
                  );
                  resolve(config);
                }
              } else {
                resolve(config);
              }
            });
      },
      error => {
        return Promise.reject(error);
      }
    );
  }

  /** 响应拦截 */
  private httpInterceptorsResponse(): void {
    const instance = PureHttp.axiosInstance;
    instance.interceptors.response.use(
      (response: PureHttpResponse) => {
        const $config = response.config;
        // 优先判断post/get等方法是否传入回调，否则执行初始化设置等回调
        if (typeof $config.beforeResponseCallback === "function") {
          $config.beforeResponseCallback(response);
          return response.data;
        }
        if (PureHttp.initConfig.beforeResponseCallback) {
          PureHttp.initConfig.beforeResponseCallback(response);
          return response.data;
        }
        // 二进制读取／下载：调用方要自己拿 headers，不做信封判断
        if ($config.rawResponse) return response;
        // HTTP 200 但后端返回 success: false：当成失败处理，调用方不用再逐个判断
        const failed = envelopeError(response.data, response.status);
        if (failed) {
          PureHttp.handleError(failed, $config);
          return Promise.reject(failed);
        }
        // 成功响应统一脱壳：业务层拿到的是 data 本身，不是信封
        return unwrapEnvelope(response.data);
      },
      // 异步：二进制接口的失败体是 Blob 里的 JSON，必须先解码再判断
      async (error: PureHttpError) => {
        // 主动取消的请求不提示、不处理
        if (Axios.isCancel(error)) {
          return Promise.reject(error);
        }
        // 请求拦截器已经处理并提示过（例如会话已判定失效），不再重复提示与登出
        if ((error as { __handled?: boolean })?.__handled) {
          return Promise.reject(error);
        }
        const apiError = await toApiErrorAsync(error);
        PureHttp.handleError(apiError, error.config as PureHttpRequestConfig);
        return Promise.reject(apiError);
      }
    );
  }

  /** 通用请求工具函数 */
  public request<T>(
    method: RequestMethods,
    url: string,
    param?: RequestParams,
    axiosConfig?: PureHttpRequestConfig
  ): Promise<T> {
    const config = {
      method,
      url,
      ...param,
      ...axiosConfig
    } as PureHttpRequestConfig;

    // 单独处理自定义请求/响应回调
    return new Promise((resolve, reject) => {
      PureHttp.axiosInstance
        .request(config)
        .then((response: undefined) => {
          resolve(response);
        })
        .catch(error => {
          reject(error);
        });
    });
  }

  /** 单独抽离的`post`工具函数 */
  public post<T, P = unknown>(
    url: string,
    params?: RequestParams<P>,
    config?: PureHttpRequestConfig
  ): Promise<T> {
    return this.request<T>("post", url, params, config);
  }

  /** 单独抽离的`get`工具函数 */
  public get<T, P = unknown>(
    url: string,
    params?: RequestParams<P>,
    config?: PureHttpRequestConfig
  ): Promise<T> {
    return this.request<T>("get", url, params, config);
  }

  /** `put`：整体更新（保存工作稿、修改规则等） */
  public put<T, P = unknown>(
    url: string,
    params?: RequestParams<P>,
    config?: PureHttpRequestConfig
  ): Promise<T> {
    return this.request<T>("put", url, params, config);
  }

  /** `patch`：局部变更（状态、可见范围） */
  public patch<T, P = unknown>(
    url: string,
    params?: RequestParams<P>,
    config?: PureHttpRequestConfig
  ): Promise<T> {
    return this.request<T>("patch", url, params, config);
  }

  /**
   * `delete`。
   * DELETE 不适合带请求体，并发前提用 `If-Match` 传 revision（格式见 docs/ADMIN_API.md）。
   */
  public delete<T>(
    url: string,
    params?: RequestParams,
    config?: PureHttpRequestConfig
  ): Promise<T> {
    return this.request<T>("delete", url, params, config);
  }

  /**
   * 二进制读取：返回完整响应，调用方自己处理 Blob 与响应头。
   * 失败时若后端回了 JSON 信封，会被解码成 `ApiError`，不会当成图片／附件。
   */
  public blob(
    url: string,
    config?: PureHttpRequestConfig
  ): Promise<AxiosResponse<Blob>> {
    return this.request<AxiosResponse<Blob>>(
      "get",
      url,
      { responseType: "blob" },
      { ...config, rawResponse: true }
    );
  }

  /**
   * Multipart 上传。
   * 进度、取消（AbortSignal）与超时都由调用方给；这里只保证 Content-Type 交给浏览器生成。
   */
  public upload<T>(
    url: string,
    form: FormData,
    config?: PureHttpRequestConfig
  ): Promise<T> {
    return this.request<T>(
      "post",
      url,
      { data: form, timeout: 120000 },
      config
    );
  }
}

export const http = new PureHttp();

/** 供开发测试替身替换适配器（生产构建中不会调用） */
export const setHttpAdapter = (adapter: AxiosAdapter) =>
  PureHttp.setAdapter(adapter);
