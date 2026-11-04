# v0.3 安装、升级和回退

当前为未发布开发版本。先在测试目录验证，保留旧部署和镜像。

## 新安装

在项目目录执行：

```sh
mkdir -p config runtime snapshots audio
cp config.json.example config/config.json
cp .env.example .env
```

填写 `config/config.json` 和 `.env`，确保四个挂载目录对容器用户（默认 UID 1000）可写；NAS 可在 compose 中设置运行用户为目录拥有者。不要通过开放所有人权限解决问题。

```sh
docker compose build
docker compose up -d
docker compose ps
curl -fsS http://127.0.0.1:8090/healthz
```

本地非 Docker 运行仍兼容根目录 `config.json`。可设置 `HOMESENSE_CONFIG_PATH` 与 `HOMESENSE_DATA_DIR` 分别指定配置和持久化目录。

## 旧版升级

先停止旧服务。停止是备份 SQLite 和多文件数据一致性的前提，工具的确认参数不会自动停止服务。

```sh
docker compose stop
node scripts/data-admin.js backup /absolute/old-deployment /absolute/private-backup --service-stopped
node scripts/data-admin.js migrate /absolute/old-deployment /absolute/new-deployment --service-stopped
```

目标目录必须不存在，且必须位于源目录之外。备份包含配置、家庭反馈、历史、状态、人脸和 SQLite（含 WAL）；不包含可重新生成的媒体缓存。备份存放在私有位置。

旧容器中未挂载的根目录数据可能尚未同步到宿主机。删除或重建旧容器前，先用 `docker cp` 将 `/app/memory.json`、`/app/activity-history.json`、`/app/decision-quality.json`、`/app/home-state.json`、`/app/home-events.json`、`/app/face-data` 中实际存在的内容复制到旧部署目录；已有 `runtime` 目录一并保留。检查文件后再备份和迁移。

将新版源码、Dockerfile、compose 和原有 `.env` 放入新部署目录；保留迁移生成的 config/runtime。确认目录权限，按新安装步骤构建启动。检查规则、反馈、历史和人脸数据，并手工验证已授权规则。不要同时启动新旧两个实例控制同一家庭。

## 回退

停止新版，保留新版数据用于排查。校验并恢复到另一个全新目录：

```sh
node scripts/data-admin.js restore /absolute/private-backup /absolute/restored-deployment --service-stopped
```

恢复工具验证文件清单和 SHA-256，拒绝覆盖已有目录。用原版本源码、原 compose、原 `.env` 和原镜像启动恢复目录。回退使用升级前快照，新版运行期间产生的数据不会自动合并。

## 发布

主分支与 PR 执行测试及 Docker 构建。`v*` 标签通过检查后发布 GHCR 多架构镜像；首次发布后需核对镜像包访问权限。compose 默认使用本地版本镜像，`HOMESENSE_VERSION` 可选择本地版本。正式发布前还需在真实 Docker/NAS 环境验证安装、重启持久化与回退。
