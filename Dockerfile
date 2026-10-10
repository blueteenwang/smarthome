# =============================================================================
# Smart Home AI Dashboard — Synology / Linux Docker image
# =============================================================================
# Base: node:22-bookworm-slim
#   - 包含 Node.js 22 LTS + 内置 SQLite + glibc + apt 包管理
#   - 比 alpine 大 ~80MB，但可直接 apt 装 ffmpeg（无需自己编 musl 兼容的 ffmpeg）
#   - 跨平台稳定，arm64/amd64 都能跑
#
# 装 ffmpeg：用 Debian 官方的 ffmpeg，含 libx264 / libx265 / 必要 demuxer/muxer
#   - 体积约 +85MB；对群晖来说毫无压力
#
# 运行时只暴露 8090 端口；配置、媒体缓存与 SQLite 账本走 volume 挂载
# =============================================================================

FROM node:22-bookworm-slim

# 系统层依赖：ffmpeg 必装，curl 可选（健康检查用），ca-certificates 必装（DashScope HTTPS）
# tini 让 PID 1 处理 SIGTERM/SIGINT 干净退出（ffmpeg 子进程才会被 reap）
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        ffmpeg \
        ca-certificates \
        tini \
        curl \
        tzdata && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# 时区 — 群晖默认 UTC，HA 时间日志会差 8 小时
ENV TZ=Asia/Shanghai
RUN ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && echo $TZ > /etc/timezone

# 工作目录
WORKDIR /app

# 复制项目源码
# 注意：.dockerignore 把无关文件（before/, redesign/, *.bak, .DS_Store）排除掉
COPY server.js ./
COPY lib ./lib
COPY index-world.html ./
COPY index.html ./
COPY index-v2.html ./
COPY mse-test.html ./
COPY scripts ./scripts
COPY config.json.example ./config.json.example

# config.json 不进镜像 — 走 volume 挂载，避免泄露 token / RTSP 密码
# 第一次启动时容器内 config.json 不存在，需要从挂载点提供，否则 server.js 会 panic

# 持久化目录：snapshots/ + audio/ 容器创建时为空，由代码运行时写入
RUN mkdir -p /app/snapshots /app/audio && \
    chown -R node:node /app

# 用 node 用户跑，避免 root（群晖 docker 通常用 PUID=1026/PGID=100，可在 compose 里 override）
USER node

# 暴露后端端口（与 config.json 里 server.port 默认 8090 对齐）
EXPOSE 8090

# 健康检查：30s 一次打 /api/snapshot.json，2 次失败认为不健康
# 群晖 Container Manager 会读这个状态显示绿/黄/红
HEALTHCHECK --interval=30s --timeout=8s --start-period=20s --retries=2 \
    CMD-SHELL curl -fsS --max-time 5 -H "Authorization: Bearer ${HOMESENSE_ACCESS_TOKEN:-${HAVENMIND_ACCESS_TOKEN:-$NOVA_ACCESS_TOKEN}}" http://127.0.0.1:8090/api/media/status > /dev/null || exit 1

# tini 作 PID 1 — 转发信号给 node，node 退出后 ffmpeg 子进程也会随 OOM/SIGKILL 一起死，避免僵尸
ENTRYPOINT ["/usr/bin/tini", "--"]

CMD ["node", "server.js"]
