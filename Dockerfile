# syntax=docker/dockerfile:1.6
# CaptureHub - 小红书 + 抖音 + 哔哩哔哩直播自动录制系统
# Alpine 基础镜像:与 telegram-bot-api 预编译二进制(musl libc)兼容
# 构建时间 < 2 分钟
# 安全:基础镜像与 telegram-bot-api 镜像均钉住具体版本标签,避免可变标签
# (latest) 带来的不可复现构建与上游变更/投毒风险;如需更强保障,可进一步
# 使用镜像 digest(如 node:20.19-alpine@sha256:...) 进行不可变引用。

# ---- Stage 1: Build Node.js application ----
FROM node:20.19-alpine AS build
WORKDIR /build

# 安装编译依赖(better-sqlite3 需要 python3 + make + g++)
RUN apk add --no-cache python3 make g++ ca-certificates

# 先复制 package.json 以利用 Docker 层缓存
COPY package.json package-lock.json ./
COPY server/package.json ./server/
COPY client/package.json ./client/

# 安装依赖(使用 BuildKit 缓存加速)
RUN --mount=type=cache,target=/root/.npm \
    npm ci --no-audit --no-fund

# 复制源码并构建
COPY server/tsconfig.json ./server/
COPY server/src ./server/src
COPY client ./client
RUN npm run build -w server && npm run build -w client

# ---- Stage 2: Runtime ----
FROM node:20.19-alpine

# 使用预编译的 telegram-bot-api 二进制(从 aiogram 官方镜像获取)
# Alpine 镜像使用 musl libc,与 aiogram 预编译二进制完全兼容
# 注意:aiogram/telegram-bot-api 只发布 <版本号(如 10.2)> 与 latest 标签,
# 不存在 stable 标签(此前构建失败即因 stable 未找到)。
# 此处钉住具体版本 10.2(多架构 manifest:amd64/arm64/armv6/armv7/386/ppc64le),
# 避免可变标签 latest(每天自动重建)带来的不可复现构建。
# 发布新版本后如需升级,请显式修改此处版本号。
COPY --from=aiogram/telegram-bot-api:10.2 /usr/local/bin/telegram-bot-api /usr/local/bin/telegram-bot-api

ENV NODE_ENV=production \
    PORT=3780 \
    HOST=0.0.0.0 \
    CAPTUREHUB_ROOT=/app \
    CAPTUREHUB_DATA_DIR=/data \
    CAPTUREHUB_RECORDINGS_DIR=/recordings \
    CAPTUREHUB_LOGS_DIR=/logs \
    CAPTUREHUB_CLIENT_DIST=/app/client/dist \
    RCLONE_CONFIG=/config/rclone/rclone.conf \
    TELEGRAM_BOT_API_PATH=/usr/local/bin/telegram-bot-api \
    HOME=/home/node

WORKDIR /app

# 安装运行时依赖 + 创建目录(合并为单层减少构建时间)
RUN apk add --no-cache ca-certificates curl tini ffmpeg openssl zlib libstdc++ su-exec \
    && mkdir -p /data /recordings /logs /config/rclone /data/scripts /home/node/.config/rclone

# 复制构建产物
COPY --from=build /build/package.json /app/package.json
COPY --from=build /build/node_modules /app/node_modules
COPY --from=build /build/server/dist /app/server/dist
COPY --from=build /build/client/dist /app/client/dist
COPY --from=build /build/server/package.json /app/server/package.json

COPY scripts/entrypoint.sh /entrypoint.sh
COPY scripts/verify.sh /app/verify.sh

RUN chmod +x /entrypoint.sh /app/verify.sh \
    && if [ ! -d /app/server/node_modules ]; then ln -s ../node_modules /app/server/node_modules; fi \
    && chown -R node:node /app /data /recordings /logs /config /home/node

VOLUME ["/data","/recordings","/logs","/config"]
EXPOSE 3780

ENTRYPOINT ["/sbin/tini","--","/entrypoint.sh"]
CMD ["node","/app/server/dist/index.js"]
