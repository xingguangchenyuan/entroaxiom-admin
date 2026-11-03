# 构建阶段：Node 版本与 .nvmrc 的主版本保持一致。
# pnpm 这里仍用 latest（模板的 pnpm-workspace.yaml 用了较新的 pnpm 配置项）；建议改成你本机 `pnpm -v` 的版本，例如 pnpm@10.x.y，让构建可复现
FROM node:22-alpine AS build-stage

WORKDIR /app
RUN corepack enable
RUN corepack prepare pnpm@latest --activate

# 国内网络可以在构建时覆盖：docker build --build-arg NPM_REGISTRY=https://registry.npmmirror.com .
ARG NPM_REGISTRY=https://registry.npmjs.org
RUN npm config set registry ${NPM_REGISTRY}

COPY .npmrc package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

# 运行阶段：只提供静态文件。/api 的转发见 docs/DEPLOY.md（Nginx 反向代理到后端）
FROM nginx:stable-alpine AS production-stage

COPY --from=build-stage /app/dist /usr/share/nginx/html
EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
