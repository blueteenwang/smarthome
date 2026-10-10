# 知家 · HomeSense

知家（HomeSense）是一个本地优先的智能家居中枢原型。它把 Home Assistant 设备状态、RTSP 摄像头画面、语音输入、空间感知、家庭记忆和自动化规则放到同一个控制面板里，让家庭系统不仅能“执行命令”，也能理解正在发生什么、为什么建议行动，以及行动后是否真的成功。

> 知家，懂你的家。HomeSense 将家庭感知、场景理解与设备控制连接在一起。

![知家 HomeSense 主界面，摄像头区域为 AI 生成的虚构客厅示意画面](docs/images/home-overview-demo.png)

家庭总览汇总环境指标、空间占用、视觉理解和待确认建议。界面基于当前 Web 控制台，摄像头区域采用 AI 生成的虚构客厅示意画面，不是真实家庭摄像头画面；实际运行时显示你配置的 RTSP 摄像头。

## 这个项目解决什么

传统智能家居通常由很多孤立入口组成：HA 管设备，摄像头看画面，语音助手接指令，自动化规则靠人工配置。HomeSense 的目标是在 Home Assistant 之上增加一层“家庭智能决策层”：

- 汇总设备、摄像头、语音和传感器状态，形成当前家庭事实。
- 用视觉模型和语言模型理解场景，生成可解释的建议。
- 用自然语言控制灯、空调、窗帘、开关等 HA 设备。
- 记录家庭事件、执行结果和用户反馈，逐步形成家庭偏好。
- 新自动化默认观察，不直接控制设备；只有经过确认和授权的规则才会执行。

![空间与设备](docs/images/spaces-devices.jpg)

空间与设备页面按房间和设备类型组织 Home Assistant 实体，可以筛选灯光、空调、窗帘等设备并查看当前状态。

### 自然语言自动化

![自然语言自动化](docs/images/automations.jpg)

用一句话描述希望发生的场景和动作，系统生成规则供你审核。新规则默认先观察，确认有效并授权后才控制设备。

### 家庭感知

![家庭感知](docs/images/perception.jpg)

查看各空间的占用与环境状态、当前判断和证据；感知不足时显示未知，诊断详情用于排查连接与事件问题。

## 系统结构

```mermaid
flowchart LR
  Browser["浏览器控制台"] --> Server["HomeSense Node.js 服务"]
  Server --> HA["Home Assistant"]
  Server --> Camera["RTSP 摄像头"]
  Server --> LLM["DashScope / OpenAI 兼容模型接口"]
  Server --> Ledger["本地运行账本<br/>runtime SQLite"]
  Server --> Memory["家庭记忆<br/>memory.json"]
  HA --> Devices["灯 / 空调 / 窗帘 / 传感器 / 音箱"]
  Camera --> Server
  LLM --> Server
  Server --> Devices
```

核心代码是一个 Node.js 服务：

- `server.js`：HTTP API、Web UI、摄像头/语音/自动化主流程。
- `lib/`：家庭状态、执行账本、空间智能、安全边界、规则策略等模块。
- `index-world.html`：当前主要 Web 控制台。
- `config.json.example`：完整配置模板。
- `docker-compose.yml` / `Dockerfile`：Linux、NAS、群晖部署入口。

## 功能概览

| 模块 | 能力 |
| --- | --- |
| Web 控制台 | 实时画面、环境指标、设备列表、语音指令、规则与记忆管理 |
| Home Assistant 集成 | 读取实体状态，控制灯、开关、空调、窗帘等设备 |
| 摄像头理解 | 从 RTSP 抽帧，识别空间状态并生成智能家居建议 |
| 语音控制 | 支持唤醒词、ASR、自然语言设备控制和回复播报 |
| 自动化规则 | 自然语言规则、冷却时间、观察模式、执行历史 |
| 家庭记忆 | 记录偏好、反馈、候选自动化和最近家庭事件 |
| 安全边界 | 默认只监听 localhost；局域网模式必须设置访问令牌 |

## 快速开始：本机运行

### 1. 准备依赖

- Node.js `>= 22.5`
- 可访问的 Home Assistant 实例
- 摄像头 RTSP 地址
- 一个 OpenAI 兼容的模型服务 API Key，例如 DashScope
- 可选：ffmpeg，本机摄像头/音频处理会用到

### 2. 拉取项目

```bash
git clone https://github.com/blueteenwang/smarthome.git
cd smarthome
```

### 3. 创建配置

```bash
cp config.json.example config.json
```

至少修改这些字段：

```json
{
  "homeAssistant": {
    "url": "http://192.168.X.X:8123",
    "token": "YOUR_HA_LONG_LIVED_TOKEN"
  },
  "camera": {
    "rtspUrl": "rtsp://USER:PASSWORD@192.168.X.X:554/..."
  },
  "ai": {
    "apiKey": "YOUR_MODEL_API_KEY"
  }
}
```

Home Assistant 长期访问令牌可以在 HA 的“个人资料 → 安全 → 长期访问令牌”中创建。

### 4. 启动

```bash
npm start
```

打开：

```text
http://localhost:8090/
```

默认只监听 `127.0.0.1`，不会把家庭设备、人脸数据、摄像头画面和家庭记忆暴露到局域网。

## Docker / NAS 部署

Docker 部署适合群晖、Linux 小主机、NAS 或长期运行的家庭服务器。

### 1. 准备配置文件

```bash
cp config.json.example config.json
cp .env.example .env
```

编辑 `.env`，设置至少 24 位随机访问令牌：

```dotenv
HOMESENSE_ACCESS_TOKEN=replace-with-a-long-random-token
```

新部署使用 `HOMESENSE_ACCESS_TOKEN`。服务同时兼容旧版 `NOVA_*` 和 `HAVENMIND_*` 环境变量；同时设置时，以 `HOMESENSE_*` 为准。

### 2. 构建并启动

```bash
docker build -t homesense:latest .
docker compose up -d
```

然后访问：

```text
http://NAS_IP:8090/
```

浏览器会弹出登录框：

- 用户名：任意值，例如 `homesense`
- 密码：`.env` 中的 `HOMESENSE_ACCESS_TOKEN`

API 调用也可以使用：

```http
Authorization: Bearer <HOMESENSE_ACCESS_TOKEN>
```

### 3. 查看日志和重启

```bash
docker logs -f homesense
docker restart homesense
```

更完整的群晖部署、打包、排障和备份说明见 [DEPLOY.md](DEPLOY.md)。

## 常见配置项

### Home Assistant

```json
"homeAssistant": {
  "url": "http://192.168.X.X:8123",
  "token": "YOUR_HA_LONG_LIVED_TOKEN"
}
```

如果 HomeSense 和 HA 在不同容器里，`url` 不要写 `localhost`，要写宿主机或 HA 容器可达地址。

### 摄像头

```json
"camera": {
  "rtspUrl": "rtsp://USER:PASSWORD@192.168.X.X:554/...",
  "captureIntervalSec": 60,
  "snapshotRefreshSec": 30
}
```

NAS CPU 较弱时，建议摄像头输出 1080p H.264，避免 4K HEVC 软解把 CPU 打满。

### AI 模型

```json
"ai": {
  "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
  "apiKey": "sk-...",
  "model": "qwen3-vl-235b-a22b-instruct",
  "commandModel": "qwen3-max"
}
```

`model` 用于画面理解，`commandModel` 用于自然语言设备控制。

### 语音控制

```json
"voiceControl": {
  "enabled": false,
  "wakeWords": ["管家"],
  "audioSource": "rtsp"
}
```

Docker 部署通常使用 `rtsp` 音频来源。本机 macOS 调试可以使用本机麦克风相关能力。

## 安全与隐私

HomeSense 处理的是家庭高敏感数据：摄像头画面、语音、设备状态、家庭成员偏好和自动化历史。因此当前默认策略偏保守：

- 本机模式只监听 `127.0.0.1`。
- 局域网模式必须设置访问令牌。
- 不要提交 `.env`、`config.json`、`memory.json`、`face-data/`、`runtime/`、`snapshots/`、`audio/` 或 SQLite 运行账本。
- 新学习到的自动化候选不会直接控制设备。
- 自然语言生成的规则默认处于观察模式，需要人工审核后再授权执行。
- 公网访问需要额外的 TLS、账户体系、权限隔离、数据导出/删除和正式安全审计。

## 测试

```bash
npm test
npm run check
```

`npm run check` 会执行服务端语法检查和所有 Node.js 模块测试。

## 目录说明

```text
.
├── server.js                 # 服务入口
├── lib/                      # 核心领域模块
├── index-world.html          # 主控制台
├── config.json.example       # 配置模板
├── docker-compose.yml        # Docker / NAS 部署
├── Dockerfile                # 镜像构建
├── DEPLOY.md                 # 群晖与 Linux 部署细节
├── ARCHITECTURE.md           # 架构说明
├── docs/                     # 阶段设计与实现文档
└── test/                     # Node.js 测试
```

## 适合谁使用

这个项目适合已经在使用 Home Assistant、愿意自己管理 API Key 和 RTSP 配置、并希望探索“本地优先家庭智能层”的用户。它不是一个即插即用的商业网关，也不建议未经安全加固直接暴露到公网。

## 名字说明

**知家（HomeSense）**：“知”代表感知与理解，“家”点明智能家居的定位。

界面与服务提示使用“知家”，包名、镜像名和容器名使用 `homesense`，环境变量使用 `HOMESENSE_*`。服务兼容旧版 `NOVA_*` 和 `HAVENMIND_*` 环境变量，旧主题偏好键和运行账本文件名保持兼容，已有数据无需迁移。
