import type {
  Method,
  AxiosError,
  AxiosResponse,
  AxiosRequestConfig
} from "axios";

export type resultType = {
  accessToken?: string;
};

export type RequestMethods = Extract<
  Method,
  "get" | "post" | "put" | "delete" | "patch" | "option" | "head"
>;

export interface PureHttpError extends AxiosError {
  isCancelRequest?: boolean;
}

export interface PureHttpResponse extends AxiosResponse {
  config: PureHttpRequestConfig;
}

export interface PureHttpRequestConfig extends AxiosRequestConfig {
  /** 请求失败时不自动弹出错误提示（页面自己处理时用） */
  silent?: boolean;
  /**
   * 返回完整响应而不是 `response.data`。
   * 二进制读取／下载需要它来拿 `Content-Disposition` 与 `Content-Type`。
   */
  rawResponse?: boolean;
  beforeRequestCallback?: (request: PureHttpRequestConfig) => void;
  beforeResponseCallback?: (response: PureHttpResponse) => void;
}

/**
 * 请求参数。
 *
 * 既允许 axios 自己的 data/params/headers/timeout，也允许本项目附加的
 * `silent`／`rawResponse`——否则调用方把 `{ silent: true }` 传进 get 的
 * 第二参会因为“未知属性”报类型错。
 */
export type RequestParams<P = unknown> = AxiosRequestConfig<P> &
  Pick<PureHttpRequestConfig, "silent" | "rawResponse">;

export default class PureHttp {
  request<T>(
    method: RequestMethods,
    url: string,
    param?: RequestParams,
    axiosConfig?: PureHttpRequestConfig
  ): Promise<T>;
  post<T, P = unknown>(
    url: string,
    params?: RequestParams<P>,
    config?: PureHttpRequestConfig
  ): Promise<T>;
  get<T, P = unknown>(
    url: string,
    params?: RequestParams<P>,
    config?: PureHttpRequestConfig
  ): Promise<T>;
}
