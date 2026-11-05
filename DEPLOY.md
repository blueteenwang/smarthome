# 多平台部署指南

HomeSense 是 Node.js 智能家居应用，可以直接运行，也可以通过 Docker 运行。部署设备可以是电脑、服务器、小主机或具备兼容容器环境的 NAS，不限定群晖品牌或型号。

本文对应 v0.3 开发代码。安装前核对所用分支、版本和配置模板；不要将开发功能当作已发布稳定能力。

## 运行条件与平台边界

| 项目 | 实际要求 |
| --- | --- |
| 直接运行 | Node.js >=22.5，包含内置 node:sqlite |
| 容器运行 | 可运行本项目 Linux 镜像的 Docker 环境；使用 Compose 时需安装相应插件 |
| 视频和音频处理 | 相应功能需要 ffmpeg；Dockerfile 已安装 |
| 设备状态和控制 | 当前通过可访问的 Home Assistant 实例及其访问令牌提供 |
| AI 画面理解与语言解析 | 需要兼容应用请求格式的模型服务，可在本机、局域网或云端运行 |
| 资源容量 | 取决于视频路数、分辨率、编码、推理方式与并发量，没有经过测量的统一最低内存或具体机型要求 |

核心服务与 Docker 路径不限定宿主机品牌。macOS、Linux、Windows 可按运行环境选择方式，但目前没有完整的平台/硬件验收矩阵，不能承诺每一种组合都已经测试。Windows 使用 Linux 容器环境运行项目镜像；原生运行需要单独检查 Node、ffmpeg 与平台相关功能。

部分辅助功能包含平台实现：本地人脸助手使用 Swift/Vision，本机音频采集与语音输出有 macOS 路径。核心服务可跨平台不代表这些辅助功能在所有平台行为一致。Linux 容器的硬件解码能力取决于实际设备、驱动、ffmpeg 和设备映射，不能笼统认定 NAS 只能软解。

## 模型接口：本地与云端均可

本项目使用的是 **OpenAI 兼容的模型请求格式**，不是要求购买 OpenAI 服务，也不是 OpenAPI 规范。DashScope 是可选供应商，不是部署前置条件。

`ai.baseUrl` 当前是完整的 Chat Completions 请求地址，必须包含服务要求的路径；`ai.model` 用于画面理解，需要支持图片输入；`ai.commandModel` 用于语言指令解析。

本地 Ollama 的配置形式：

```json
{
  "ai": {
    "baseUrl": "http://127.0.0.1:11434/v1/chat/completions",
    "apiKey": "ollama",
    "model": "YOUR_INSTALLED_VISION_MODEL",
    "commandModel": "YOUR_INSTALLED_TEXT_MODEL"
  }
}
```

先在 Ollama 安装所选模型，模型名应与实际安装结果一致；视觉模型、语音模型的输入能力需分别确认。兼容 HTTP 格式不保证所有供应商支持相同模型、图片或音频请求。

也可连接云端兼容服务，将地址、模型和凭据替换为供应商提供的配置。真实凭据仅保存在部署环境，不写入仓库。云端推理会发送相应输入数据，选择前确认哪些图片、音频和上下文会离开本地。

容器中的 localhost 指向容器自身。模型、HA 或摄像头位于容器外时，应填写该容器实际可达的服务地址；不要照搬固定网关或假定 host 网络在所有平台可用。

## 方式一：直接运行

```sh
git clone https://github.com/blueteenwang/smarthome.git
cd smarthome
cp config.json.example config.json
```

编辑本机 config.json，配置自己的 HA、模型与按需启用的摄像头/语音参数。模板是字段示例，不是可直接连接的运行配置。安装符合条件的 Node.js；启用媒体处理时确保 ffmpeg 可执行。

```sh
npm start
```

默认访问 `http://127.0.0.1:8090/`。Windows 原生命令行可使用其对应的文件复制命令完成配置。

可以通过 HOMESENSE_CONFIG_PATH 指定配置文件，通过 HOMESENSE_DATA_DIR 指定私有运行目录。默认本机监听；需要局域网监听时设置 HOMESENSE_HOST，并设置至少24字符的 HOMESENSE_ACCESS_TOKEN。不要将访问令牌发到 Issue 或截图。

账号功能正在开发，尚未包含在本次文档提交对应的稳定能力中；当前版本仍使用令牌或本机访问方式。后续账号功能发布时会补充首次管理员初始化与权限说明。

## 方式二：Docker Compose

适用于具备兼容 Docker 环境的 Linux、macOS、Windows 与 NAS。Docker 镜像运行 Linux 应用环境。

```sh
git clone https://github.com/blueteenwang/smarthome.git
cd smarthome
mkdir -p config runtime snapshots audio
cp config.json.example config/config.json
cp .env.example .env
```

编辑 config/config.json 和 .env。容器默认使用 UID 1000 的 node 用户，挂载目录和配置文件必须允许实际运行用户读写。根据宿主机权限设置所有者或 Compose user；没有适用于所有 NAS 的固定 UID，不要通过全员可写权限解决问题。

```sh
docker compose build
docker compose up -d
docker compose ps
docker compose logs --tail 100 homesense
```

访问 `http://HOST:8090/`，将 HOST 替换为部署设备的可达地址。Compose 默认要求访问令牌；账号初始化行为取决于所用版本，见上面的版本说明。

健康检查：

```sh
curl -fsS http://127.0.0.1:8090/healthz
```

该接口只表示服务存活，不代表 HA、模型和摄像头均已连接。

| 挂载 | 内容 |
| --- | --- |
| ./config → /app/config | 连接配置、规则等，可原子保存 |
| ./runtime → /app/runtime | 家庭状态、历史、反馈、账本等持久化数据 |
| ./snapshots → /app/snapshots | 图片缓存 |
| ./audio → /app/audio | 音频缓存 |

## NAS 与群晖的可选说明

NAS 只是部署宿主机的一种。先确认设备架构、容器运行环境和目录权限，是否支持本项目镜像以实际构建与运行结果为准。不同 CPU 型号不能用“型号大于等于某款”表达兼容性。

群晖用户可在设备支持的容器管理工具中导入 Compose 项目。界面、套件名称和可用功能依系统版本而异，本文不限定 DSM 版本、SSH 或固定存储路径。源码构建可在其他兼容设备完成，NAS 不一定需要启用 SSH。

跨设备导入镜像时，构建目标必须匹配运行端架构。不能假定所有 Mac 都是 arm64，也不能假定所有 NAS 都是 x86。项目 CI 配置了 amd64/arm64 发布路径，但在实际标签构建成功前，不应将镜像当作已发布产物。

## 排查问题

- 启动立即退出：检查配置是否存在、JSON 是否有效、Node 是否支持 node:sqlite，以及挂载权限。
- HA 不可达：从应用运行环境检查地址与访问权限，容器网络与宿主机网络分别排查。
- 模型失败：检查完整请求地址、模型名、认证方式与输入模态，不要只检查供应商名称。
- 视频处理负载高：先降低输入分辨率、帧率或使用合适子码流，再验证硬件解码路径；不承诺固定内存配额适用所有设备。
- 摄像头失败：分别检查地址、网络、认证和编码；切换网络模式不能自动解决认证问题。
- 贴日志前删除凭据、内部地址、设备标识和家庭画面。

## 升级与备份

参考 [v0.3 备份、迁移与回退](docs/UPGRADE_0.3.md)。停止服务后备份配置和持久化运行数据，保留旧版本与镜像，再执行升级。不要直接删除旧容器中尚未导出的家庭数据。

```sh
docker compose stop
```

备份包含敏感数据，只保存在私有位置。媒体是否保留按使用需要决定。代码仓库只保存模板、文档与虚构测试数据。
