# Smart Home AI · 系统设计文档（DESIGN）

> 版本：v1.0 · 2026-05-25  
> 状态：MVP 已上线 · NAS Docker 部署成功  
> 受众：接手开发的工程师 / 另一个 AI Agent  
> 配套文档：PRD.md（需求） · ARCHITECTURE.md（详细架构） · CODE_GUIDE.md（代码地图） · DEPLOY.md（部署）

---

## 0. 文档目的

读完此文档应能：

1. 画出系统架构图、数据流图、关键时序图
2. 列出每个核心技术决策的"为什么选 A 不选 B"
3. 看到一段代码能定位到所属模块
4. 知道哪些是技术债、哪些是边界

本文档**不替代**代码，但读完它再读代码应该能省 80% 的探索时间。

---

## 1. 系统架构

### 1.1 一句话架构

> **Node.js 单进程 + 零依赖 + ffmpeg 子进程 + 内存状态 + 三个外部依赖（HA REST、DashScope、RTSP 摄像头）。**

### 1.2 部署拓扑

```
┌──────────────────────── 家庭局域网 192.168.3.0/24 ────────────────────────┐
│                                                                          │
│   ┌──────────────────────────────────────────┐                           │
│   │       群晖 NAS  192.168.X.X             │                           │
│   │                                          │                           │
│   │   ┌──────────────────────────────────┐   │                           │
│   │   │  Home Assistant :8123            │   │                           │
│   │   │   - 1391 entities                │   │                           │
│   │   │   - REST API + WebSocket         │   │                           │
│   │   └──────────────────────────────────┘   │                           │
│   │                                          │                           │
│   │   ┌──────────────────────────────────┐   │                           │
│   │   │  Surveillance Station :554       │   │                           │
│   │   │   - RTSP /Sms=5.unicast          │   │                           │
│   │   │   - 萤石 C6WI 摄像头 4K HEVC     │   │                           │
│   │   │   - 密码 1h TTL                  │   │                           │
│   │   └──────────────────────────────────┘   │                           │
│   │                                          │                           │
│   │   ┌──────────────────────────────────┐   │                           │
│   │   │  Docker bridge network           │   │                           │
│   │   │   ┌────────────────────────┐     │   │                           │
│   │   │   │ smart-home-ai          │     │   │                           │
│   │   │   │  Node.js + ffmpeg      │ ◀───┼───┼── Web UI                  │
│   │   │   │  :8090 → host :8090    │     │   │   http://192.168.X.X:8090│
│   │   │   │  config.json (mount)   │     │   │                           │
│   │   │   │  snapshots/ (mount)    │     │   │                           │
│   │   │   │  audio/ (mount)        │     │   │                           │
│   │   │   └────────────────────────┘     │   │                           │
│   │   └──────────────────────────────────┘   │                           │
│   │                                          │                           │
│   └──────────────────────────────────────────┘                           │
│                                                                          │
│   ┌─────────────┐  ┌─────────────┐  ┌─────────────┐                      │
│   │ 小爱音箱     │  │ 灯/空调/窗帘 │  │ 用户浏览器   │                      │
│   └─────────────┘  └─────────────┘  └─────────────┘                      │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
                    ┌─────────────────────────┐
                    │   DashScope API 云端     │
                    │  - qwen3-vl-235b 视觉    │
                    │  - qwen3-max 命令理解    │
                    │  - qwen-turbo 闲聊兜底   │
                    │  - qwen3-omni-flash ASR │
                    └─────────────────────────┘
```

### 1.3 模块视图

```
┌────────────────────────────── server.js（约 3500 行单文件）──────────────────────────────┐
│                                                                                        │
│   ┌─────────────── Capture 层 ───────────────┐  ┌─────────── Cognition 层 ───────────┐  │
│   │ SnapshotDaemon                           │  │ VisionLLM (qwen3-vl-235b)         │  │
│   │   - refreshSnapshot 30s                  │  │ CommandLLM (qwen3-max)            │  │
│   │   - captureAll 60s (mutex)               │  │ ChitchatLLM (qwen-turbo)          │  │
│   │   - ffmpeg RTSP → JPEG                   │  │ ASR (qwen3-omni-flash)            │  │
│   │ MJPEGStream                              │  │ Naturalize (qwen-turbo rephrase)  │  │
│   │   - /api/stream                          │  │ AutomationEngine                  │  │
│   │   - mpjpeg muxer                         │  │   - rule eval piggyback           │  │
│   │ MSEStream                                │  │   - cooldown / dryRun             │  │
│   │   - /api/video.mp4 fmp4                  │  └────────────────────────────────────┘  │
│   │   - libx264 ultrafast 1080p              │                                          │
│   │ VoicePipeline                            │  ┌────────── Action 层 ────────────────┐ │
│   │   - VAD frame loop                       │  │ HAProxy                             │ │
│   │   - WAV pad → ASR                        │  │   - /api/ha/* fan-out               │ │
│   │   - wake word matcher                    │  │ ServiceExecutor                     │ │
│   └──────────────────────────────────────────┘  │   - shouldSkipAction predicate      │ │
│                                                 │   - executeServiceSafe              │ │
│   ┌─────────────── 横切层 ──────────────────┐   │   - summarizeExecuted               │ │
│   │ ConfigStore                             │   │ Speaker                             │ │
│   │   - read/write config.json              │   │   - HA notify entity → 小爱         │ │
│   │   - mask sensitive on GET               │   │   - macOS say -v Tingting           │ │
│   │ EventBus                                │   │ NLPipeline                          │ │
│   │   - SSE /api/rules/events               │   │   - tryBroadcastIntent              │ │
│   │   - SSE /api/voice/events               │   │   - processNLCommand                │ │
│   │ TokenUsage                              │   │   - QA fallback                     │ │
│   │   - per-call cost CNY                   │   └─────────────────────────────────────┘ │
│   └─────────────────────────────────────────┘                                           │
│                                                                                         │
└─────────────────────────────────────────────────────────────────────────────────────────┘
                                          │
                                          ▼
                              ┌──── Frontend ────┐
                              │  index-v2.html   │   单 HTML 文件
                              │   - vanilla JS   │   零打包
                              │   - SSE 监听     │
                              │   - 富控件渲染   │
                              │   - 配置面板     │
                              └──────────────────┘
```

### 1.4 三个关键数据流

#### 数据流 A：用户语音控制

```
小爱 mic / 浏览器麦
   │ PCM s16le 16k mono
   ▼
VAD frame 100ms 累积
   │ 0.018 阈值 on / 0.010 off / minSpeech 300ms
   ▼
缓冲到静音 1s 或 8s 上限
   │ + preRoll 200ms
   ▼
qwen3-omni-flash ASR
   │ "贾维斯打开餐厅的灯"
   ▼
唤醒词匹配（≤2 leading chars，CN 标点剥离）
   │ 命中 → 进入 NL 处理
   ▼
tryBroadcastIntent 检查（小爱播报 + 引号）
   │ 不命中
   ▼
processNLCommand → qwen3-max
   │ {actions:[{domain:light, target:餐厅, service:turn_on}]}
   ▼
fuzzy match HA entity friendly_name
   │ light.dining_room_main
   ▼
shouldSkipAction 预检
   │ 已是目标态? skip : execute
   ▼
HA POST /api/services/light/turn_on {entity_id}
   │
   ▼
summarizeExecuted → 骨架 reply
   │ "已为您打开餐厅吊灯"
   ▼
naturalizeReply → qwen-turbo rephrase（4s timeout，骨架兜底）
   │ "好的，餐厅吊灯已经亮起来了"
   ▼
speakReply 分发
   ├── HA notify.xiaomi_*_play_text_* → 小爱音箱
   └── macOS say（开发模式）
```

#### 数据流 B：周期 vision 分析 + 规则 piggyback

```
SnapshotDaemon @ 60s
   │ refreshSnapshot → snapshot.jpg
   ▼
captureAll mutex 检查
   │ 不冲突
   ▼
读 snapshot.jpg base64
   │
   ▼
qwen3-vl-235b prompt 拼接
   │ 系统提示 + 当前规则列表 + 当前时间 + 摄像头位置
   ▼
LLM 一次调用同时返回：
   │ 1. 场景描述（自然语言）
   │ 2. 各规则的命中状态（JSON）
   │ 3. 异常告警（JSON 可选）
   ▼
解析结果 → AutomationEngine.evaluate
   │ 命中规则 → cooldown 检查
   ▼
未在 cooldown → 触发规则
   │ executeServiceSafe + speakReply
   ▼
SSE /api/rules/events → 前端规则栈卡片
```

#### 数据流 C：实时视频流

```
浏览器开 index-v2.html
   │
   ▼
GET /api/video.mp4 (默认) 或 /api/stream (fallback)
   │
   ▼
spawn ffmpeg
   │ 输入: rtsp://USER:pwd@192.168.X.X:554/Sms=5.unicast
   │ 输出: fMP4
   │   -c:v libx264 -preset ultrafast -tune zerolatency
   │   -profile:v baseline -level 4.0 -pix_fmt yuv420p
   │   -movflags frag_keyframe+empty_moov+default_base_moof+separate_moof
   │   -frag_duration 200000 -g 30
   ▼
管道 chunk 直推 res.write
   │ 浏览器 MSE SourceBuffer.appendBuffer
   ▼
HTMLVideoElement.play
   │ 实测 lag 0.24-0.28s
   ▼
前端 1s 巡检 buffer.end - currentTime
   │ > 2s? video.currentTime = end - 0.3 跳到 live
```

---

## 2. 技术栈选型与权衡

### 2.1 选型矩阵

| 决策 | 选择 | 候选 | 选这个的理由 | 不选其他的理由 |
|---|---|---|---|---|
| 语言 | Node.js 18+ | Python / Go | I/O 密集 + 流处理 + Web 前端同语言 | Python GIL 多 ffmpeg 流处理痛；Go 生态 HA 集成弱 |
| Web 框架 | 内置 http 模块 | Express / Fastify / Koa | 0 npm 依赖，小工具不需要中间件层 | 单 npm 依赖都会拖累 NAS 用户部署体验 |
| 视频流 | ffmpeg 子进程 | gstreamer / 纯 Node | 工具链最成熟、HA 圈用户最熟悉 | gstreamer 太重，纯 Node HEVC 解不动 |
| 浏览器流 | MSE + fMP4 主路 / MJPEG fallback | HLS / WebRTC | MSE 延迟 0.3s 够家用，零 STUN/TURN 配置 | HLS 5s 延迟太大；WebRTC 配 ICE 复杂 |
| LLM | DashScope qwen3 系列 | OpenAI / Claude / Doubao | 中文优化、阿里 sk 实名一次买一年、价格低 | OpenAI 中文家具识别率低；Claude 没中文家庭家具数据；Doubao Coding Plan 已耗尽 |
| ASR | qwen3-omni-flash 批 ASR | paraformer 流式 / Whisper | 单接口、~150 LOC 节省、1-1.5s 完成 | paraformer WS 处理复杂；Whisper 中文不如 qwen 准 |
| 数据存储 | 内存 + config.json | SQLite / Redis | 状态量小（< 1MB）、重启从 HA 拉一次即可 | SQLite 增加迁移负担；Redis 多一个进程 |
| 配置 | 单 config.json | env vars / yaml | UI 可视化编辑 + 一行 mount | env 太散；yaml 缩进易错 |
| 部署 | Docker bridge | docker host / native | 跨 NAS 平台一致 + 端口冲突好解 | host 在 Mac/Win 是 VM 假象；native 部署门槛高 |
| 前端打包 | 不打包，单 HTML | React / Vue + Vite | 用户改文案不需要重 build | SPA 框架对单仪表盘过度工程 |

### 2.2 关键权衡说明

#### 单文件 server.js 3500 行 vs 模块化拆分

**当前选择：单文件**

理由：
- LLM 接手时一次读完 ≈ 完整心智模型
- 用户改逻辑只改一处
- 内部已有清晰段落注释（L29 / L210 / L551 ...）

代价：
- IDE 跳转慢
- 小 PR 也容易冲突

**何时拆分**：当某个模块超过 800 行 + 有独立测试时拆。当前未到。

#### 内存状态 vs 持久化

**当前选择：内存 + 重启从 HA 拉**

理由：
- HA 是真相之源，重复实现一份持久化 = 双写冲突
- 状态从 HA pull 一次约 1.5s，可接受
- 规则写 config.json，重启不丢

代价：
- 容器重启期间（30s）所有状态消失
- LLM token 用量统计重启清零（接受）

**何时持久化**：单用户多设备共享 → 加 SQLite。当前 P2-6。

#### bridge vs host 网络

**当前选择：bridge + ports 8090:8090**

理由：见 PRD.md §10「Docker 推广默认」。简单说：dogfood 配置必须等于发布默认。

代价：
- 容器内访问宿主 HA 不能用 127.0.0.1，必须用 NAS IP（这恰好和用户实际多机部署场景一致，所以是好事）

---

## 3. 数据模型

### 3.1 config.json schema

```json
{
  "rtspUrl": "rtsp://USER:PASSWORD@192.168.X.X:554/Sms=5.unicast",
  "snapshotPath": "/app/snapshots/snapshot.jpg",
  "audioDir": "/app/audio",
  "port": 8090,

  "ha": {
    "url": "http://192.168.X.X:8123",
    "token": "eyJhbGc...0DMtGm8H..."
  },

  "llm": {
    "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1",
    "apiKey": "sk-***YOUR_API_KEY***",
    "visionModel": "qwen3-vl-235b-a22b-instruct",
    "commandModel": "qwen3-max",
    "qaModel": "qwen-turbo",
    "asrModel": "qwen3-omni-flash"
  },

  "llmPricing": {
    "qwen3-vl-235b-a22b-instruct": { "in": 0.0024, "out": 0.0024 },
    "qwen3-max": { "in": 0.012, "out": 0.012 },
    "qwen-turbo": { "in": 0.0003, "out": 0.0006 }
  },

  "voice": {
    "enabled": false,
    "audioSource": "rtsp",
    "wakeWords": ["贾维斯", "王管家"],
    "qaFallback": true,
    "naturalReply": true
  },

  "vad": {
    "frameMs": 100,
    "onThresh": 0.018,
    "offThresh": 0.010,
    "minSpeechMs": 300,
    "silenceTimeoutMs": 1000,
    "maxUtterMs": 8000,
    "preRollMs": 200
  },

  "xiaoai": {
    "enabled": true,
    "entity": "notify.xiaomi_cn_***_x10a_play_text_a_7_",
    "triggerOn": ["command", "rule", "broadcast"]
  },

  "automation": {
    "enabled": true,
    "defaultCooldownSec": 300,
    "rules": [
      {
        "id": "rule-1779497639026-2rhp6",
        "name": "餐厅有人吃饭打开餐厅灯",
        "trigger": "vision",
        "condition": "有人坐在餐厅桌前吃东西",
        "actions": [{ "domain": "light", "target": "餐厅", "service": "turn_on" }],
        "cooldownSec": 300,
        "enabled": true,
        "dryRun": false
      }
    ]
  },

  "stream": {
    "width": 1280,
    "height": 720,
    "fps": 15,
    "preferredCodec": "h264",
    "fragDurationUs": 200000
  }
}
```

### 3.2 内存状态（运行时）

```js
// server.js 顶层闭包
const state = {
  // 来自 HA pull
  haEntities: Map<entity_id, EntityState>,    // 1391 条
  haDomains: Set<string>,                     // ['light', 'switch', ...]

  // 设备 UI 模型
  devices: Array<DeviceCard>,                 // 经 enrich 后给前端
  _rawEntities: Map,                          // optimistic update 双写源

  // LLM 分析
  lastAnalysis: { timestamp, text, raw },
  tokenUsage: { byModel: {...}, totalCNY },

  // 规则
  ruleHistory: Array<RuleEvent>,              // 最近 100 条
  ruleCooldowns: Map<rule_id, lastTriggeredMs>,

  // 视频流
  activeStreamClients: number,                // mutex counter
  isCapturing: boolean,
  isSnapshotRefreshing: boolean,

  // 语音
  voicePipeline: {
    running: boolean,
    audioSource: 'rtsp' | 'local',
    currentPid: number | null,                // SIGKILL race fix
    lastWakeAt: number,
  },
};
```

### 3.3 规则数据模型

```ts
interface Rule {
  id: string;                  // 'rule-${ts}-${rand6}'
  name: string;                // 默认 '未命名规则'
  trigger: 'vision' | 'audio' | 'both';
  condition: string;           // 自然语言，给 LLM piggyback 用
  actions: Array<{
    domain: string;
    target: string;            // 模糊关键词
    service: string;
    params?: object;
  }>;
  cooldownSec: number;         // 默认 config.automation.defaultCooldownSec
  enabled: boolean;
  dryRun: boolean;             // 只走逻辑不发 HA 调用
  minConfidence?: number;      // LLM 自评信心阈值
  dryRunUntilMs?: number;      // 24h 沙盒期
}

interface RuleEvent {
  ts: number;
  ruleId: string;
  ruleName: string;
  status: 'matched' | 'cooldown' | 'completed' | 'failed';
  evidence: string;            // LLM 给的命中理由
  executed: Array<{ entity_id: string; service: string }>;
  reply: string;
  durationMs: number;
}
```

---

## 4. API 设计

### 4.1 端点分组（共约 50 个）

#### A. 摄像头与视频
```
GET  /api/snapshot           最新快照 JPEG
GET  /api/stream             MJPEG 流
GET  /api/video.mp4          fMP4 流
GET  /api/codec              告知前端可用 codec
POST /api/rtsp/config        热更 RTSP URL，pkill 重生
POST /api/rtsp/test          连通测试
```

#### B. 设备与 HA 代理
```
GET  /api/devices            富 UI 模型 array
GET  /api/ha/states          原始 HA states pass-through
POST /api/ha/services/{domain}/{service}   通用 service 代理
POST /api/ha/test            HA 连通性测试
```

#### C. AI 分析
```
GET  /api/analysis           最新 vision 分析结果（含 timestamp）
POST /api/analysis/refresh   手动触发分析
GET  /api/usage              token 用量（按模型分桶 + 总价）
```

#### D. 自然语言命令
```
POST /api/command            { command: string } → { understood, executed, reply }
```

#### E. 规则
```
GET    /api/rules            规则数组
POST   /api/rules            新增（auto-id）
PUT    /api/rules/:id        更新（浅 merge，强制保留 id）
DELETE /api/rules/:id
POST   /api/rules/:id/trigger   手动触发
GET    /api/rules/history    最近 100 条
GET    /api/rules/events     SSE
POST   /api/automation/toggle    { enabled: bool }
```

#### F. 语音
```
POST /api/voice/start        开启 pipeline
POST /api/voice/stop
POST /api/voice/source       { source: 'rtsp' | 'local' }
POST /api/voice/config       { wakeWords?, qaFallback?, naturalReply? }
GET  /api/voice/events       SSE（partials + finals + state）
```

#### G. 配置
```
GET  /api/settings           聚合返回（敏感字段遮罩 first6 + *** + last4）
PUT  /api/settings           深度合并（含 * 跳过保留旧值）
POST /api/settings/test/ha
POST /api/settings/test/llm
```

#### H. 小爱 / TTS
```
POST /api/xiaoai/speak       { message: string }
```

### 4.2 API 设计规范

```
请求体: 全 JSON
响应体: 全 JSON, 含 { ok: bool, ...其他 }
错误: HTTP 状态码 + { ok: false, error: string }
SSE: text/event-stream, data: <JSON>\n\n
认证: 当前无（局域网信任，公网部署需用户自加反代）
CORS: 全开（家庭场景，受局域网保护）
日志: console.log/warn/error, 前缀 [Module] 形式
```

---

## 5. 关键算法

### 5.1 状态预检（shouldSkipAction）

**问题**：用户说"关空调"6 次，HA 调用 6 次浪费且产生 race condition。

**算法**：
```js
function shouldSkipAction(currentState, action) {
  const { domain, service, params } = action;

  switch (domain) {
    case 'light':
    case 'switch':
      // turn_on 且当前 on 且无 brightness/color override → skip
      if (service === 'turn_on' && currentState.state === 'on'
          && !params.brightness && !params.color_temp_kelvin) return true;
      if (service === 'turn_off' && currentState.state === 'off') return true;
      break;

    case 'climate':
      if (service === 'turn_off' && currentState.state === 'off') return true;
      // set_temperature ±0.5°C 内 skip
      if (service === 'set_temperature' && params.temperature) {
        const cur = currentState.attributes.temperature;
        if (Math.abs(cur - params.temperature) < 0.5) return true;
      }
      break;

    case 'cover':
      // position ±5% 内 skip
      if (service === 'set_cover_position' && params.position != null) {
        const cur = currentState.attributes.current_position ?? 0;
        if (Math.abs(cur - params.position) < 5) return true;
      }
      break;

    case 'fan':
      if (service === 'set_percentage' && currentState.attributes.percentage === params.percentage) return true;
      break;

    case 'media_player':
      if (service === 'turn_off' && currentState.state === 'off') return true;
      break;
  }

  return false;
}
```

**验证**：6 台空调全 off 时执行"关全屋空调" → 6 个 skipped 0 个 HA 调用 ✅

### 5.2 事实化 reply 双层架构

**问题**：纯 LLM 写 reply 会编造（"已开 5 盏灯"实际只开了 2 盏）；纯模板写 reply 干硬。

**算法**：
```
Layer 1: summarizeExecuted(executed[])
  - 输入: [{entity_id, service, ok}]
  - 输出: 事实化骨架 "已为您打开餐厅吊灯和过道灯"
  - 不编造，只汇总成功的

Layer 2: naturalizeReply(skeleton, originalCmd) [可选]
  - 输入: 骨架 + 原始命令
  - qwen-turbo rephrase, 4s timeout
  - prompt 强约束：只 rephrase，不增减事实
  - 防御正则：检测 reply 包含原骨架未提到的设备名 → 退回骨架
  - 失败 / 超时：退回骨架
```

**验证**：
- 骨架："餐厅吊灯已为您打开"
- 自然化："好的，餐厅吊灯已经亮起来了"
- 编造检测：LLM 输出"餐厅吊灯和厨房灯都打开了"→ 检测到"厨房灯"未在 executed → 退回骨架

### 5.3 规则 piggyback（零额外 LLM 调用）

**问题**：每条规则单独跑 LLM 判断 = 钱包爆炸。

**算法**：周期 vision 分析时，把所有 enabled 规则的 condition 拼进 prompt，让 LLM 在同一次调用里判断。

```
prompt 模板:
---
你是家庭场景分析助手。当前画面 base64 见下。

# 任务 1：场景描述
用 1-2 句中文描述画面里发生什么。

# 任务 2：规则判断
对下面每条规则给出 hit / not_hit / unsure，并给一句证据：

- 规则 R1 (id=rule-xxx): "有人坐在餐厅桌前吃东西"
- 规则 R2 (id=rule-yyy): "客厅光线偏暗"
- ...

# 输出格式
{
  "scene": "...",
  "rules": [{"id":"rule-xxx", "hit":true, "evidence":"..."}],
  "alerts": []
}
---
```

**好处**：1 次 LLM 调用处理 N 条规则，平摊成本接近 0。

### 5.4 VAD 门控

**问题**：什么时候开始/结束一段语音？

**算法**：
```js
const vad = {
  frameMs: 100,                  // 100ms 窗口
  onThresh: 0.018,               // RMS 高于此 → speech
  offThresh: 0.010,              // 低于此 → silence
  minSpeechMs: 300,              // 短于此忽略
  silenceTimeoutMs: 1000,        // 静音 1s 切段
  maxUtterMs: 8000,              // 单段上限
  preRollMs: 200,                // 段前补 200ms 防截断
};

let buf = ringBuffer(preRollMs);
let inSpeech = false, speechStart, lastSpeech;

onAudioFrame(frame100ms):
  rms = computeRMS(frame);
  buf.push(frame);
  if (!inSpeech && rms > onThresh) {
    inSpeech = true;
    speechStart = now();
    pushPreRoll();
  }
  if (inSpeech) {
    if (rms > offThresh) lastSpeech = now();
    if (now() - lastSpeech > silenceTimeoutMs) flushUtterance();
    if (now() - speechStart > maxUtterMs) flushUtterance();
  }
```

`flushUtterance()` 把累积的 PCM → WAV（16k mono s16le）→ qwen3-omni-flash ASR。

### 5.5 Color pipeline 修复（HEVC 黑屏）

**问题**：4K HEVC RTSP 流走 ffmpeg 默认 yuv420p → MJPEG 转码后画面发暗、过曝。

**根因**：HEVC 默认 BT.709 limited range（16-235），ffmpeg 默认输出 full range（0-255），范围不对应导致灰阶被错误线性拉伸。

**算法**：
```
-vf "scale=W:-2:in_range=tv:out_range=pc,format=yuvj420p"
       │              │             │
       │              │             └── 强制 full range JPEG 编码
       │              └── 输出 full range
       └── 输入声明为 limited range（即使流没正确标记也帮 ffmpeg 识别）
```

**验证**：lower_mean 像素分布从 249.5 → 110，过曝 clip ≥250 占比 52.9% → 0%。

### 5.6 SIGKILL race fix（currentPid 闭包）

**问题**：voice pipeline 重启 ffmpeg 时，旧 ffmpeg 还在 close 中、新 ffmpeg 已起，旧的 SIGKILL 误杀新的。

**修复**：每次 spawn 记录 `currentPid = ff.pid`，close 处理时严格比对 `if (ff.pid === currentPid) currentPid = null`，外部 kill 函数 `if (state.currentPid && state.currentPid === ff.pid) ff.kill('SIGKILL')`。

---

## 6. 部署架构

### 6.1 Docker 镜像

```dockerfile
FROM node:20-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg curl tini && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY server.js index.html index-v2.html ./
COPY scripts/ ./scripts/
EXPOSE 8090
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.js"]
```

要点：
- `node:20-bookworm-slim` 而非 alpine（apt 直装 ffmpeg 简单）
- `tini` 当 PID 1 reap ffmpeg 子进程僵尸
- 不在镜像里 COPY config.json（mount 进来）

### 6.2 docker-compose.yml

```yaml
services:
  smart-home-ai:
    build: .
    image: smart-home-ai:latest
    container_name: smart-home-ai
    restart: unless-stopped
    network_mode: bridge
    ports:
      - "8090:8090"
    volumes:
      - ./config.json:/app/config.json
      - ./snapshots:/app/snapshots
      - ./audio:/app/audio
    healthcheck:
      test: ["CMD-SHELL", "curl -fsS --max-time 5 http://127.0.0.1:8090/api/config > /dev/null || exit 1"]
      interval: 30s
      timeout: 8s
      retries: 2
      start_period: 20s
```

### 6.3 Healthcheck

- 命中 `/api/config` 而非 `/`（前者纯 JSON、轻量、不依赖前端文件）
- start_period 20s 容器启动期不计失败
- DSM Container Manager 红字 404 警告与 healthcheck 直接挂钩，绿色 healthy 是必须

---

## 7. 已知设计债（Technical Debt）

| 编号 | 债务 | 影响 | 偿还优先级 |
|---|---|---|---|
| TD-1 | server.js 单文件 3500 行 | 改文件冲突频繁 | P2 |
| TD-2 | 无单元测试 | 重构时无回归保护 | P1 |
| TD-3 | 错误处理分散 try/catch | 错误日志格式不统一 | P2 |
| TD-4 | RTSP 密码 1h TTL 手动续期 | 用户每小时改密 | P0 |
| TD-5 | 无鉴权 | 公网部署需自加反代 | P1（公网场景） |
| TD-6 | LLM 调用无重试 | 网络抖动 → 单次失败 | P2 |
| TD-7 | 前端 vanilla JS 单文件 | 增大后维护难 | P2 |
| TD-8 | naturalizeReply 串行 | 每个命令都加 0.5-1s | P2 |
| TD-9 | DSM SS UI 编码字段被锁 | 4K HEVC 软解延迟无解 | 硬件升级才能解 |
| TD-10 | 4K HEVC Baseline 5.1 corrupt | macOS Safari 不支持 | 强制 1080p libx264 重编码 |
| TD-11 | config.json 写并发无锁 | 高并发改配置可能丢更新 | P2 |
| TD-12 | 内存状态重启丢 | 容器重启丢 100 条 ruleHistory | P2 |

---

## 8. 演进路径

### 8.1 v1（当前 MVP，2026-05）

- ✅ 单摄像头
- ✅ 单用户单容器
- ✅ DashScope 云端 LLM
- ✅ NAS Docker 部署

### 8.2 v2（计划 2026-06 ~ 2026-09）

主题：**让 100 个真实用户跑起来**

- DSM RTSP 密码自动续期（TD-4）
- 命令白名单 + 简单 token 鉴权（TD-5）
- 单元测试覆盖核心算法（TD-2）
- 错误处理与日志规范化（TD-3）
- LLM 重试与降级（TD-6）
- 多摄像头支持（P2-1）
- 移动端响应式 UI（P2-10）

### 8.3 v3（计划 2026-10 ~ 2027-Q1）

主题：**生态嵌入**

- MCP server 入口（HA 2025 战略）
- 本地 LLM 适配（Ollama / vLLM，隐私场景）
- 事件历史持久化（SQLite）
- 用户登录与多租户（云端版选项）

### 8.4 v4（推测，2027 Q2+）

主题：**商业化**

- 代部署服务
- 软件订阅（针对不愿配 DashScope key 的用户）
- HA 插件市场（HACS）正式发布

---

## 9. 给接手者的核心提示

### 9.1 改代码必读铁律

1. **任何 HA 写入必须经 `executeServiceSafe`**——单点 idempotency + 记录格式统一
2. **任何 LLM 调用必须更新 `tokenUsage`**——成本可见
3. **改 config.json schema 必须同步 `/api/settings` GET 遮罩规则**——避免泄密
4. **改 ffmpeg 命令必须先 30 分钟 POC**——不要直接改 server.js（参考 12.20 教训）

### 9.2 调试备忘

```bash
# 容器日志实时
docker logs -f smart-home-ai

# 容器内手测 HA
docker exec -it smart-home-ai curl -s http://192.168.X.X:8123/api/

# RTSP 单帧测试
ffmpeg -rtsp_transport tcp -i "$RTSP_URL" -frames:v 1 -y /tmp/t.jpg

# 端口占用清除
lsof -ti:8090 | xargs kill -9 2>/dev/null

# ffmpeg 残留杀掉
pkill -9 -f "ffmpeg.*192.168.X.X"
```

### 9.3 常见陷阱

| 陷阱 | 解药 |
|---|---|
| DashScope baseUrl 多个 `/chat/completions` | 必须 `.../compatible-mode/v1` 不带 suffix |
| 直接 curl HA :8123 在容器外超时 | 用 `localhost:8090/api/ha/states` 代理 |
| MJPEG `img.onerror` 设 display:none 永远 | 用 test `Image()` 预校验 + 5s 重试 |
| Climate state 写 'on' | 实际 'cool'/'heat'/'off' |
| Optimistic update 只改 devices[] | 必须同时改 `_rawEntities` Map |
| voice 占用 RTSP 时 captureAll 卡死 | mutex 必须 skip:true 标记 |
| ffmpeg `-stimeout` 在 8.1.1 | 改 `-timeout`（无 s） |
| 修了一个 bug log 还是错 | 检查另一个根因（参考 Phase 12.10 双重根因） |

---

## 10. 参考材料

- 详细架构：[ARCHITECTURE.md](./ARCHITECTURE.md)
- 代码地图：[CODE_GUIDE.md](./CODE_GUIDE.md)
- 部署手册：[DEPLOY.md](./DEPLOY.md)
- HA REST API：https://developers.home-assistant.io/docs/api/rest/
- DashScope OpenAI 兼容：https://help.aliyun.com/zh/dashscope/developer-reference/compatibility-of-openai-with-dashscope
- ffmpeg fMP4：https://ffmpeg.org/ffmpeg-formats.html#mov_002c-mp4_002c-ismv

---

文档结束。任何与代码不符之处以代码为准，欢迎接手者修订本文档。
