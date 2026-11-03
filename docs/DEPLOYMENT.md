# 部署（根路径 / 独立子域名 / /admin/ 子路径）

后台是纯静态产物（`dist/`），部署路径有三种形态，**三种的构建产物不一样**，不要混用同一个 zip。

| 形态 | 构建命令 | 读哪个 env | 产物 base | 访问地址 | Nginx 根 |
|---|---|---|---|---|---|
| 根路径（默认） | `pnpm build` | `.env.production` | `/` | `https://entroaxiom.com/` | `root /srv/entroaxiom` |
| **独立子域名（当前生产）** | `pnpm build:admin:subdomain` | `.env.admin-subdomain` | `/` | `https://admin.entroaxiom.com/` | `root /srv/entroaxiom/admin` |
| 子路径 | `pnpm build:admin` | `.env.admin` | `/admin/` | `https://entroaxiom.com/admin/` | `alias /srv/entroaxiom/admin/` |

三种模式互斥，**不要**用同一个 `dist/` 应付两种地址：`VITE_PUBLIC_PATH` 决定 `index.html` 里 JS/CSS 的前缀，写错就是白屏。

## 独立子域名模式（`admin.entroaxiom.com`）

```bash
pnpm install --frozen-lockfile
pnpm build:admin:subdomain
# 产物在 dist/，整个目录的内容复制到 /srv/entroaxiom/admin
```

`.env.admin-subdomain` 里的五个值必须一起满足：

```
VITE_PUBLIC_PATH = /                 # 子域名根部，不是 /admin/
VITE_ROUTER_HISTORY = "hash"         # 不写 /admin/ 前缀
VITE_MOCK = false                    # 生产不能带内存替身
VITE_API_BASE = /api/admin           # 同源相对路径，由 Nginx 反代到后端
VITE_CDN = false                     # 资源走本站 /static/
```

```bash
# 自检（子域名模式）
grep -o 'src="[^"]*"' dist/index.html     # 应当出现 /static/js/index-xxxx.js
grep -c '/admin/' dist/index.html          # 0
grep -rc 'mockAdapter\|MOCK_NOT_IMPLEMENTED' dist/static/js/ | grep -v ':0'   # 应当没有输出
```

后端需要放行这个来源，否则所有写请求会被 403（`src/plugins/auth.ts` 校验 `Origin`/`Referer`）：

```
PUBLIC_ORIGIN=https://entroaxiom.com
ALLOWED_ORIGINS=https://admin.entroaxiom.com
```

会话 Cookie 是 host-only（后端不设 `Domain`），所以 `admin.entroaxiom.com` 与 `entroaxiom.com` 各自持有一份 `sid`，
但两边请求的是同一个后端、同一份数据库。不要为了"共用登录"给 Cookie 加 `Domain=.entroaxiom.com`：
那会让前台也能收到后台会话，反而扩大暴露面。

## 子路径模式（`/admin/`）

`build:admin` 读 `.env.admin`，里面两个值必须成对出现：

```
VITE_PUBLIC_PATH = /admin/            # JS/CSS/字体的前缀
VITE_ROUTER_HISTORY = "hash,/admin/"  # 路由 base
```

只改 `VITE_PUBLIC_PATH` 不改 `VITE_ROUTER_HISTORY`：页面能打开但路由全部 404（hash 路由的 base 不对）。
只改 `VITE_ROUTER_HISTORY` 不改 `VITE_PUBLIC_PATH`：`index.html` 里的 `/static/...` 依然指向域名根，白屏。

```bash
pnpm build:admin
grep -o 'src="[^"]*"' dist/index.html      # 应当出现 /admin/static/js/...
grep -c '/static/js/' dist/index.html      # 0（不该再有不带前缀的绝对路径）
```

## Nginx：独立子域名部署（当前生产形态）

```nginx
upstream entroaxiom_api {
    server 127.0.0.1:8000;
    keepalive 16;
}

server {
    listen 443 ssl;
    http2 on;
    server_name admin.entroaxiom.com;

    root /srv/entroaxiom/admin;
    index index.html;

    # 后台不要被搜索引擎收录
    add_header X-Robots-Tag "noindex, nofollow" always;

    location / {
        try_files $uri $uri/ /index.html;
    }

    # 带内容哈希的资源可以长缓存
    location /static/ {
        add_header Cache-Control "public, max-age=31536000, immutable" always;
        add_header X-Content-Type-Options "nosniff" always;
        try_files $uri =404;
    }

    # 管理接口：同一个后端，保留来源与真实 IP，导入预览要留足超时
    location /api/ {
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Cookie $http_cookie;
        proxy_set_header Connection "";
        proxy_read_timeout 180s;
        proxy_send_timeout 180s;
        proxy_buffering off;
        proxy_pass http://entroaxiom_api;
    }

    # 后台也要能显示公开图片（接口返回的是同源相对地址 /uploads/public/...）
    location /uploads/public/ {
        alias /srv/entroaxiom/shared/uploads/public/;
        autoindex off;
        add_header Cache-Control "public, max-age=604800" always;
        add_header X-Content-Type-Options "nosniff" always;
    }

    # 私密文件永远不由 Nginx 提供
    location /uploads/private/ { return 404; }
    location = /uploads/ { return 404; }
}
```

## Nginx：根路径 / 子路径部署

```nginx
server {
    listen 443 ssl;
    server_name entroaxiom.com;

    root /srv/entroaxiom/site;
    index index.html;

    location / { try_files $uri $uri/ /index.html; }

    # 子路径模式才需要（独立子域名模式下后台有自己的 server 块）
    # location /admin/ {
    #     alias /srv/entroaxiom/admin/;
    #     try_files $uri $uri/ /admin/index.html;
    # }

    location /api/ {
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Cookie $http_cookie;
        proxy_read_timeout 180s;
        proxy_pass http://entroaxiom_api;
    }
}
```

要点：

- 子路径模式里 `location /admin/` 必须用 `alias`（不是 `root`），否则实际路径会变成 `/srv/.../admin/admin/static/...`。
- **不要**把后台挂到 `/admin`（不带斜杠）：`/admin/static/...` 会解析错位，Nginx 需要 301 补斜杠。
- 后端的 `Origin` 校验要放行实际访问地址：独立子域名要把 `https://admin.entroaxiom.com` 写进 `ALLOWED_ORIGINS`；
  子路径模式只要 `https://entroaxiom.com` 在 `PUBLIC_ORIGIN`/`ALLOWED_ORIGINS` 里即可。
- 任何 location 里只要写了 `add_header`，就不再继承上层的 `add_header`，所以 `X-Content-Type-Options: nosniff` 要逐 location 重复声明。
- `/uploads/private/` 必须显式 404；不要用 `location /uploads/` 整个目录 `alias` 出去。

## 与前台一起部署时的公开文件

- 前台 Nginx 只反代 `/api/` 与 `/uploads/`；后台产出的公开地址统一是 `/uploads/public/<fileId>.<ext>`。
- 若历史上存在 `/media/` 目录，不要再往那里写；前台没有对应的 location，请求会落到 SPA 的 `index.html`，
  浏览器拿到 200 HTML 当图片解码失败（表现为"图片裂了但网络面板看着是 200"）。
