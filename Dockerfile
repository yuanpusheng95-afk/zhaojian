# api 与 worker 共用同一镜像,角色由 compose 的 command 区分。
# 纯 ESM 无构建步骤:装依赖、拷源码即完。
FROM node:22-alpine
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY public ./public
COPY scripts ./scripts
COPY migrations ./migrations

ENV NODE_ENV=production
# 容器内日志直达 docker logs,不做文件轮转
CMD ["node", "src/api/main.mjs"]
