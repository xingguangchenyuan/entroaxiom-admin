/**
 * 开发替身的安装入口。
 *
 * 只在 `VITE_MOCK=true` 时被 main.ts 动态引入，因此生产包里这块代码既不执行，
 * 也不会因为静态依赖被打进首屏 chunk。
 */

import { setHttpAdapter } from "@/utils/http";

let installed = false;

export async function installMock(): Promise<void> {
  if (installed) return;
  installed = true;

  const { mockAdapter, MOCK_SEED_SUMMARY } = await import("./adapter");
  setHttpAdapter(mockAdapter);

  // 站长需要在控制台一眼看出“现在连的是替身，不是真后端”
  console.info(
    "%c[entroaxiom] 开发替身已接管 /api/admin",
    "color:#0b0e17;background:#e9bd5e;padding:2px 6px;border-radius:3px",
    MOCK_SEED_SUMMARY
  );
  console.info(
    "[entroaxiom] 登录账号任意，密码至少 6 位；数据只存在内存里，刷新即重置。"
  );
}

export { resetMockState } from "./adapter";
