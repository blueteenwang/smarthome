# Smart Home AI · 代码说明文档

> 版本：2026-05  
> 配套：`ARCHITECTURE.md`（先读那个）  
> 读者：要改代码 / 加功能 / 排查 bug 的人

---

## 1. 文件总览

```
smart-home-ai/
├── server.js            # 后端主入口，3520 行单文件
├── config.json          # 运行时配置，热读不重启
├── config.json.example  # 脱敏模板（可上传 git）
├── index.html           # v1 仪表盘（3901 行单文件）
├── index-v2.html        # v2 重构仪表盘（3149 行，主推）
├── mse-test.html        # MSE 视频流独立测试页
├── Dockerfile           # node:20-bookworm-slim + apt ffmpeg + tini
├── docker-compose.yml   # bridge 网络 + 8090 端口 + 3 卷挂载
├── .dockerignore        # 排除 config/before/redesign/snapshots/audio
├── DEPLOY.md            # 7 阶段部署 + 5 FAQ
├── ARCHITECTURE.md      # 架构设计（本文档的姊妹篇）
├── CODE_GUIDE.md        # 本文档
├── scripts/
│   └── start.sh         # 本地启动脚本
└── (运行时生成)
    ├── snapshots/       # latest.jpg
    └── audio/           # latest.wav
```

**核心代码就一个文件 `server.js`**。这是有意为之：调试只用一个 grep，部署只 scp 一个文件，不用打包工具。代价是单文件 3520 行，靠 section 注释（`// ============ XXX ============`）切分。

---

## 2. server.js 结构地图

按行号定位：

| 行号 | Section | 说明 |
|---|---|---|
| 1-26 | 头部加载 | 加载 config.json、定义 PORT/SNAPSHOT_DIR 常量 |
| 28-100 | TokenUsage | LLM 用量统计、按模型分组、CNY 价格 |
| 102-123 | RTSP Capture 头 | 全局状态变量 `isCapturing` / `activeStreamClients` |
| 124-200 | Stream Profile | `deriveProfile` / `detectStreamProfile`：ffprobe 探流 |
| 201-258 | Frame Health | `checkSnapshotHealth` 8x8 RGB 健康检查 |
| 259-450 | Snapshot Daemon | 长连接 ffmpeg + `refreshSnapshot` + `captureAll` |
| 453-545 | Audio Transcription | `transcribeAudio` 调 qwen3-omni-flash |
| 547-728 | AutomationEngine | 规则 CRUD + evaluate + cooldown |
| 729-815 | analyzeSnapshot | vision LLM + piggyback 规则判断 |
| 817-848 | haRequest | HA REST 单点入口 |
| 849-924 | processNLCommand | command LLM → actions |
| 925-1065 | executeServiceSafe / fuzzyKeywordMatch | HA 写操作单点 + 设备名模糊匹配 |
| 1066-1153 | shouldSkipAction | 状态预检（idempotency） |
| 1154-1226 | summarizeExecuted | 事实化骨架 reply |
| 1227-1333 | naturalizeReply | LLM rephrase 骨架 |
| 1334-1472 | Environment snapshot | 环境数据采集（temp/humidity/illuminance/occupancy） |
| 1473-1549 | chitchatLLM | qa fallback（qwen-turbo） |
| 1550-1996 | VoicePipeline | VAD + 滚动 PCM + 唤醒 + ASR + 段触发 |
| 1997-2010 | ttsSpeak | macOS `say` 本地 TTS |
| 2012-2089 | Xiaoai broadcast | tryBroadcastIntent + speakReply 分发 |
| 2090-2178 | PCM/WAV utils | pcmToWav + asrTranscribe |
| 2179-2221 | Wake Word + Command Gate | matchWakeWord + looksLikeCommand |
| 2222-2275 | startPeriodicTasks | setInterval 编排 |
| 2276-3500 | HTTP Server + 50 endpoints | Router + body parser + CORS |
| 3501-3520 | Bootstrap | server.listen + 启动日志 |

---

## 3. HTTP API 完整清单（50 个 endpoint）

按用途分组：

### 3.1 视频/快照流

| 方法 | 路径 | 用途 | 行号 |
|---|---|---|---|
| GET | `/api/snapshot` | 单帧 JPEG（latest.jpg） | 2326 |
| GET | `/api/stream` | MJPEG `multipart/x-mixed-replace` 实时流 | 2479 |
| GET | `/api/stream/fmp4` | fMP4 字节流（MSE 用） | 2337 |
| GET | `/api/stream/codec` | 当前流的 codec mime（前端 `MediaSource.isTypeSupported`） | 2419 |
| GET | `/api/stream/profile` | ffprobe 检测到的流元数据 | 2306 |
| POST | `/api/stream/redetect` | 强制重探流编码 | 2316 |

### 3.2 AI 分析

| 方法 | 路径 | 用途 | 行号 |
|---|---|---|---|
| POST | `/api/capture` | 强制立即跑一次 captureAll | 2591 |
| GET | `/api/analysis` | 最近一次 vision 分析结果 + timestamp | 2598 |
| POST | `/api/analyze` | 用前端传入的 base64 图跑一次 vision | 2724 |
| GET | `/api/usage` | LLM 累计 tokens / 价格 | 2604 |

### 3.3 自动化规则

| 方法 | 路径 | 用途 | 行号 |
|---|---|---|---|
| GET | `/api/rules` | 列出所有规则 | 2611 |
| POST | `/api/rules` | 新增规则（auto-id） | 2621 |
| PUT | `/api/rules/{id}` | 更新规则（浅 merge） | (动态匹配) |
| DELETE | `/api/rules/{id}` | 删除规则 | (动态匹配) |
| POST | `/api/rules/{id}/trigger` | 手动触发一次（绕过 cooldown） | (动态匹配) |
| POST | `/api/automation/toggle` | 全局开关 `enabled` | 2670 |
| GET | `/api/rules/history` | 触发历史记录 | 2689 |
| GET | `/api/rules/events` | SSE 流：rule-fired / completed | 2695 |

### 3.4 命令/QA

| 方法 | 路径 | 用途 | 行号 |
|---|---|---|---|
| POST | `/api/command` | NL 命令入口（含代播 + qa fallback） | 2731 |
| POST | `/api/execute-suggestion` | 执行 vision 分析返回的 suggestion | 3433 |

### 3.5 Home Assistant 代理

| 方法 | 路径 | 用途 | 行号 |
|---|---|---|---|
| GET | `/api/ha/states` | 直接转发 HA `/api/states` | 2818 |
| POST | `/api/ha/services/{domain}/{service}` | 转发 HA 服务调用，body=`{entity_id, ...service_data}` | 2837 |
| GET | `/api/env/snapshot` | 聚合环境数据（不是 HA 原始字段） | 2825 |

### 3.6 小爱 / 代播

| 方法 | 路径 | 用途 | 行号 |
|---|---|---|---|
| GET | `/api/xiaoai/config` | 读小爱配置（entity_id / triggerOn） | 2851 |
| POST | `/api/xiaoai/config` | 写小爱配置 | 2865 |
| POST | `/api/xiaoai/speak` | 立即让小爱说一句 body=`{message}` | 2896 |

### 3.7 语音管线

| 方法 | 路径 | 用途 | 行号 |
|---|---|---|---|
| GET | `/api/voice/status` | 当前 running/audioSource/最近段落 | 3064 |
| GET | `/api/voice/source` | 当前 source（rtsp/local） | 3070 |
| POST | `/api/voice/source` | 切换 source body=`{source}` | 3074 |
| POST | `/api/voice/start` | 启动 voice pipeline | 3091 |
| POST | `/api/voice/stop` | 停止 | 3099 |
| GET | `/api/voice/events` | SSE 流：transcript + state | 3106 |
| GET | `/api/voice/config` | 读 wakeWords / VAD 参数 | 3128 |
| POST | `/api/voice/config` | 改配置（含唤醒词） | 3133 |
| GET | `/api/voice/qa/config` | qa fallback 开关 + model | 3155 |
| POST | `/api/voice/qa/config` | 改 qa 配置 | 3168 |
| GET | `/api/audio/transcripts` | 历史 ASR 段（最多 50 条） | 3047 |
| POST | `/api/audio/capture` | 触发一次音频抓取（不经 voice pipeline） | 3053 |

### 3.8 RTSP 配置

| 方法 | 路径 | 用途 | 行号 |
|---|---|---|---|
| GET | `/api/rtsp/config` | 读 rtspUrl（密码遮罩） | 2915 |
| POST | `/api/rtsp/config` | 改 rtspUrl 并自动重启 ffmpeg 进程 | 2931 |
| POST | `/api/rtsp/test` | 探活：能否 connect/拿到第一帧 | 2969 |

### 3.9 系统配置

| 方法 | 路径 | 用途 | 行号 |
|---|---|---|---|
| GET | `/api/settings` | 聚合 HA + LLM 配置（敏感字段遮罩） | 3197 |
| PUT | `/api/settings` | 写 HA + LLM 配置（`*` 标记保留旧值） | 3233 |
| POST | `/api/settings/test/ha` | 探活：HA URL+token 是否通 | 3279 |
| POST | `/api/settings/test/llm` | 探活：DashScope baseUrl+apiKey 是否通 | 3316 |
| GET | `/api/prompts` | 读 vision/command/qa 的 system prompt | 3362 |
| PUT | `/api/prompts` | 改 system prompt | 3373 |
| GET | `/api/config` | 完整配置读出（敏感字段遮罩） | 3420 |

---

## 4. config.json schema

完整结构（可拷贝当模板）：

```jsonc
{
  "server": {
    "port": 8090
  },

  "homeAssistant": {
    "url": "http://192.168.X.X:8123",
    "token": "eyJhbGciOi..."         // long-lived token，HA 个人资料页生成
  },

  "camera": {
    "rtspUrl": "rtsp://USER:PASSWORD@192.168.X.X:554/Sms=5.unicast",
    "snapshotIntervalSec": 30,        // daemon 写图周期
    "captureIntervalSec": 60,         // captureAll 周期
    "streamWidth": 720,               // /api/stream 输出宽度
    "streamFps": 10,                  // /api/stream 输出帧率
    "snapshotWidth": 960,
    "transcodeFor4kHevc": true        // 4K HEVC 时强制 1080p libx264
  },

  "audio": {
    "sampleRate": 16000,
    "channels": 1,
    "captureSeconds": 8,              // 周期 captureAll 一次抓多少秒
    "model": "qwen3-omni-flash"       // ASR 用
  },

  "ai": {
    "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1",
    "apiKey": "sk-xxxx",
    "model": "qwen3-vl-235b-a22b-instruct",   // vision
    "commandModel": "qwen3-max",              // NL 命令
    "analysisIntervalSec": 60,
    "systemPrompt": {
      "vision": "你是家庭场景视觉分析助手...",
      "command": "你是家庭设备控制助手...",
      "qa": "你是家庭助手王管家..."
    }
  },

  "rooms": [
    { "id": "living_room", "name": "客厅", "aliases": ["客厅", "起居室"] },
    { "id": "dining_room", "name": "餐厅", "aliases": ["餐厅", "饭厅"] },
    // ... 共 15 个房间
  ],

  "voiceControl": {
    "wakeWords": ["王管家", "贾维斯", "小管家"],
    "vadOnEnergy": 0.018,
    "vadOffEnergy": 0.010,
    "minSpeechMs": 300,
    "silenceTimeoutMs": 1000,
    "maxUtteranceMs": 8000,
    "preRollMs": 200,
    "asrModel": "qwen3-omni-flash",
    "audioSource": "rtsp",            // rtsp | local
    "partialAsrIntervalMs": 1500
  },

  "automation": {
    "enabled": true,
    "defaultCooldown": 300,
    "rules": [
      {
        "id": "rule-1779497639026-2rhp6",
        "name": "餐厅有人吃饭打开餐厅灯",
        "trigger": "vision",          // vision | audio | both
        "condition": "有人在餐厅吃饭",
        "actions": [
          { "domain": "light", "service": "turn_on", "target_keyword": "餐厅" }
        ],
        "cooldownSec": 300,
        "min_confidence": 0.7,
        "enabled": true,
        "dryRun": false
      }
    ]
  },

  "llmPricing": {
    "qwen3-vl-235b-a22b-instruct": { "input": 0.0024, "output": 0.0072 },
    "qwen3-max":                  { "input": 0.0024, "output": 0.0096 },
    "qwen-turbo":                 { "input": 0.0003, "output": 0.0006 },
    "qwen3-omni-flash":           { "input": 0.0009, "output": 0.0027 }
    // 单位 CNY / 1K tokens
  },

  "xiaoai": {
    "enabled": true,
    "entityId": "notify.xiaomi_cn_***_x10a_play_text_a_7_",
    "triggerOn": ["command", "rule", "broadcast"]   // 哪些事件类型走小爱
  },

  "voice": {
    "naturalReply": true,            // 关掉则只用骨架不调 LLM
    "qa": {
      "enabled": true,               // 唤醒后非家电命令转 QA
      "model": "qwen-turbo",
      "maxTokens": 80,
      "timeoutMs": 4000
    }
  }
}
```

**敏感字段**：`homeAssistant.token` / `ai.apiKey` / `camera.rtspUrl` 中的密码。

**热更新支持**：所有字段改了重启进程都生效；`/api/settings PUT` 部分字段不需要重启。

---

## 5. 关键模块详解

### 5.1 SnapshotDaemon（line 259-450）

```javascript
function startSnapshotDaemon() {
  // 长连接 ffmpeg：-update 1 持续覆盖同一个 latest.jpg
  // 单进程一次握手，避免反复 RTSP DESCRIBE 触发 401
  const args = [
    '-rtsp_transport', 'tcp',
    '-i', config.camera.rtspUrl,
    '-vf', 'scale=960:-2:in_range=tv:out_range=pc,format=yuvj420p',
    '-update', '1',
    '-y', SNAPSHOT_PATH
  ];
  daemonProc = spawn('ffmpeg', args);
}
```

**关键点**：

1. **单进程长连接**：避免每 30s 新建 RTSP 连接（ssrtspd 单连接限制）
2. **color pipeline `in_range=tv:out_range=pc,format=yuvj420p`**：修复 4K HEVC 灰白偏色
3. **健康检查回调**：`recordFrameHealth` 连续 N 次 corrupt 触发 `pkill ffmpeg` → daemon 自愈
4. **voice pipeline 优先级**：`captureAll()` 检测到 `VoicePipeline.audioSource === 'rtsp'` 就跳过，避免双 ffmpeg 抢流

### 5.2 VoicePipeline（line 1550-1996）

```javascript
const VoicePipeline = {
  state: { running, audioSource, ff, currentPid, segmentBuffer, ... },

  start(source) {
    // 关键：currentPid 闭包保证 SIGKILL 不误伤新进程
    const myPid = ++this.pidCounter;
    this.currentPid = myPid;
    this.ff = spawn('ffmpeg', [...]);
    this.ff.stdout.on('data', chunk => this.processFrame(chunk, myPid));
  },

  processFrame(chunk, myPid) {
    if (this.currentPid !== myPid) return;  // 已被 stop/restart，丢弃
    // 100ms PCM 帧 = 3200 bytes (s16le 16k mono)
    const energy = computeRMS(chunk);
    if (energy > VAD_ON) this.enterSpeech();
    else if (energy < VAD_OFF) this.silenceCountdown();
  },

  flushSegment() {
    // 触发条件：silence ≥ 1000ms / segment ≥ 8000ms
    const wav = pcmToWav(this.segmentBuffer, 16000, 1);
    asrTranscribe(wav, 'full').then(this.onTranscript);
  }
};
```

**陷阱**：

- `currentPid` 闭包是为了防止异步 stop 时旧进程的 stdout 还在 emit 把新进程的 buffer 污染
- macOS local 模式 `-f avfoundation -i ":1"` 需要在系统设置授予 Terminal 麦克风权限，否则 PCM 全 0 但不报错
- preRoll 200ms 是防止说话开头被 VAD 切掉

### 5.3 processNLCommand（line 850-924）

```javascript
async function processNLCommand(command) {
  const states = await haRequest('GET', '/api/states');
  // 把 1391 实体压成 prompt：domain + entity_id + friendly_name + state
  const entityList = states.map(e => `${e.entity_id} (${e.attributes.friendly_name}) [${e.state}]`);

  const llmResp = await callLLM({
    model: 'qwen3-max',
    systemPrompt: config.ai.systemPrompt.command,
    userPrompt: `用户命令: "${command}"\n\n可用设备:\n${entityList.join('\n')}\n\n返回 JSON: {actions:[{domain, service, target_keyword, params}]}`
  });

  const parsed = JSON.parse(llmResp);  // 防御 try/catch
  return parsed;
}
```

**优化点**：

- 实体列表可以按 `target_keyword` 模糊预过滤再喂 LLM（当前没做，prompt 长但准确）
- `systemPrompt` 强制 JSON 输出，外层正则容错 `}` 后多余文本

### 5.4 shouldSkipAction（line 1069-1153）

```javascript
function shouldSkipAction(action, entity) {
  const { domain, service, params = {} } = action;
  const state = entity.state;

  if (domain === 'light' && service === 'turn_on') {
    if (state !== 'on') return false;        // 当前关 → 不能 skip
    if (params.brightness || params.color_temp) return false;  // 带 override → 不能 skip
    return true;                              // 已开且无 override → skip
  }

  if (domain === 'climate' && service === 'set_temperature') {
    const cur = entity.attributes.temperature;
    const tgt = params.temperature;
    if (Math.abs(cur - tgt) < 0.5) return true;  // ±0.5°C 容忍
    return false;
  }

  // ... light/switch/fan/climate/cover/media_player 各域规则
}
```

**新增设备域怎么扩展**：

1. 找到 `shouldSkipAction` 函数
2. 对应 domain 加分支：根据 `params` 和 `entity.state/attributes` 判断
3. 调一次 e2e 验证两次连发同命令第二次跳过

### 5.5 AutomationEngine（line 551-728）

```javascript
const AutomationEngine = {
  rules: config.automation.rules,
  lastTriggered: new Map(),  // ruleId -> timestamp

  add(rule) {
    rule.id = rule.id || `rule-${Date.now()}-${Math.random().toString(36).slice(2,7)}`;
    rule.name = rule.name || '未命名规则';
    rule.trigger = rule.trigger || 'vision';
    rule.cooldownSec = rule.cooldownSec ?? config.automation.defaultCooldown;
    rule.enabled = rule.enabled ?? true;
    rule.dryRun = rule.dryRun ?? true;
    this.rules.push(rule);
    this.save();
    return rule;
  },

  evaluate(visionResult) {
    const matched = visionResult.triggered_rules || [];
    for (const rid of matched) {
      const rule = this.rules.find(r => r.id === rid);
      if (!rule || !rule.enabled) continue;
      const last = this.lastTriggered.get(rid) || 0;
      if (Date.now() - last < rule.cooldownSec * 1000) continue;
      this.fire(rule, visionResult);
    }
  }
};
```

**重要：HTTP 路由的坑**

- `POST /api/rules` 是**新增**（auto-id）
- 不要用 `POST /api/rules` body=`{action:'update'}` 假装更新——会创建新规则
- 更新必须用 `PUT /api/rules/{id}`

---

## 6. 前端 index-v2.html 关键结构

3149 行单文件，分四段：

| 行号区间 | 内容 |
|---|---|
| 1-300 | `<head>`：CSS 变量 + 全局样式 + design tokens |
| 300-1200 | CSS：组件样式（hero / cam / panel / chip / bulk-bar / dev-grid） |
| 1200-1500 | `<body>` HTML 骨架（hero / cam / signal / scene / voice / dev / rules / settings） |
| 1500-3149 | `<script>`：state + 渲染 + 事件 + SSE |

### 关键 JS 对象

```javascript
// 全局状态
const state = {
  devices: [],          // 渲染网格用，按 type/room 分组
  _rawEntities: new Map(),  // entity_id → HA 完整对象，optimistic update 必同步
  rules: [],
  events: [],           // 规则触发栈
  voice: { running, audioSource, transcript, segments },
  tokens: { byModel, total }
};

// Panel 互斥
function ensureXxxPanel() { /* 创建一次 */ }
function closeAllPanels(except) { /* 关闭其他 */ }
// CSS class 必须用 v2-panel（display:none + .active{display:block}），不要用 side-panel（无定义）

// 富控件 dispatch
function buildDevCard(d) {
  switch (d.dom) {
    case 'light':       return buildLightCard(d);
    case 'climate':     return buildClimateCard(d);
    case 'cover':       return buildCoverCard(d);
    case 'fan':         return buildFanCard(d);
    case 'media_player': return buildMediaCard(d);
    default:            return buildGenericCard(d);
  }
}

// 关键陷阱：内部按钮必须 stopPropagation，否则点子按钮会触发卡片点击展开
button.addEventListener('click', e => {
  e.stopPropagation();
  /* ... */
});
```

### SSE 监听

```javascript
const ruleES = new EventSource('/api/rules/events');
ruleES.onmessage = e => {
  const ev = JSON.parse(e.data);
  if (ev.type === 'rule-fired')     showRuleEvent(ev, 'pending');
  if (ev.type === 'rule-completed') showRuleEvent(ev, 'success');
};

const voiceES = new EventSource('/api/voice/events');
voiceES.onmessage = e => {
  const ev = JSON.parse(e.data);
  if (ev.type === 'transcript-partial') updatePartialTranscript(ev.text);
  if (ev.type === 'transcript-final')   appendFinalTranscript(ev);
  if (ev.type === 'state-change')       updateVoiceBadge(ev.state);
};
```

### MSE 视频流（核心 100 行）

```javascript
const ms = new MediaSource();
video.src = URL.createObjectURL(ms);

ms.addEventListener('sourceopen', async () => {
  const codecResp = await fetch('/api/stream/codec').then(r => r.json());
  const sb = ms.addSourceBuffer(`video/mp4; codecs="${codecResp.codec}"`);

  const resp = await fetch('/api/stream/fmp4');
  const reader = resp.body.getReader();

  // 控制策略：lag > 2s 跳到 live-0.3s；trim 8s buffer 防内存爆
  setInterval(() => {
    const buffered = sb.buffered;
    if (buffered.length === 0) return;
    const liveEnd = buffered.end(buffered.length - 1);
    if (liveEnd - video.currentTime > 2) video.currentTime = liveEnd - 0.3;
    if (liveEnd - buffered.start(0) > 8) sb.remove(0, liveEnd - 4);
  }, 1000);
});
```

---

## 7. 常见任务剧本

### 7.1 我想加一个新的 LLM 模型

1. `config.json` 的 `ai` 块加新字段（如 `summaryModel`）
2. `llmPricing` 加价格
3. server.js 找到调用点（如 `analyzeSnapshot`）改读 `config.ai.summaryModel`
4. 重启验证 `/api/usage` 出现新模型的统计

### 7.2 我想加一个新设备域（比如 `vacuum`）

1. `shouldSkipAction` 加 `if (domain === 'vacuum') ...` 分支
2. 前端 `buildDevCard` switch 加 `case 'vacuum': return buildVacuumCard(d);`
3. 写 `buildVacuumCard`：return HTML，按钮 onclick 调 `/api/ha/services/vacuum/start` 等
4. 测试一下「打开扫地机器人」NL 命令能命中新域

### 7.3 我想换一个摄像头

1. `/api/rtsp/config POST` body=`{rtspUrl: "新的 url"}` → server 自动重启 ffmpeg
2. 或者直接改 `config.json` + 重启进程
3. 流编码变了：`POST /api/stream/redetect` 强制重探流，前端会拿新 codec

### 7.4 我想关掉自然回复（省钱）

```bash
curl -X PUT http://localhost:8090/api/settings \
  -H "Content-Type: application/json" \
  -d '{"voice": {"naturalReply": false}}'
```

或者改 `config.json` 重启。骨架 reply 仍会播报，只是没有自然语言润色。

### 7.5 我想给规则触发加自定义 webhook

1. `AutomationEngine.fire(rule, ctx)` 函数末尾加 `if (rule.webhookUrl) fetch(rule.webhookUrl, {...})`
2. config 规则 schema 加 `webhookUrl` 字段
3. 前端规则编辑器加 webhook URL 输入框

### 7.6 我想换一个语音唤醒词

```bash
curl -X POST http://localhost:8090/api/voice/config \
  -H "Content-Type: application/json" \
  -d '{"wakeWords": ["小度", "天猫精灵"]}'
```

或仪表盘右下"⚙ 系统"面板的唤醒词 chip 行点 ✎ 编辑。

---

## 8. 调试 Cheat Sheet

### 后端启动失败

```bash
# 端口被占
lsof -ti:8090 | xargs kill -9 2>/dev/null

# 看完整启动日志
node server.js 2>&1 | tee /tmp/smart-home-ai.log
```

### LLM 调用问题

```bash
# 直接 curl 测 DashScope
curl -X POST https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions \
  -H "Authorization: Bearer sk-xxx" \
  -H "Content-Type: application/json" \
  -d '{"model":"qwen-turbo","messages":[{"role":"user","content":"hi"}]}'
```

### HA 调用问题

```bash
# 直接 curl 测 HA
curl -H "Authorization: Bearer eyJxxx" http://192.168.X.X:8123/api/

# 通过 proxy 测（验证 server.js 是否正常）
curl http://localhost:8090/api/ha/states | python3 -m json.tool | head -20
```

### RTSP 摄像头问题

```bash
# 单帧抓取测试
ffmpeg -rtsp_transport tcp \
  -i "rtsp://USER:PASSWORD@192.168.X.X:554/Sms=5.unicast" \
  -frames:v 1 -y /tmp/test.jpg && ls -la /tmp/test.jpg
# 如果报 401 → 密码过期，去 DSM 重置
# 如果 timeout → IP 被 ban，等 5 分钟或 DSM 改密
```

### Voice pipeline 问题

```bash
# 看实时段落
curl -N http://localhost:8090/api/voice/events

# 切换到本地麦克风（macOS 调试）
curl -X POST http://localhost:8090/api/voice/source \
  -H "Content-Type: application/json" \
  -d '{"source":"local"}'
```

### 看 LLM 用量

```bash
curl http://localhost:8090/api/usage | python3 -m json.tool
```

### 触发指定规则验证

```bash
curl -X POST http://localhost:8090/api/rules/rule-1779497639026-2rhp6/trigger
# 看 SSE 是否推送 + HA 是否真执行
```

---

## 9. 二次开发的 4 条铁律

1. **所有 HA 写操作必须经 `executeServiceSafe`**。直接调 `haRequest('POST', ...)` 写设备会绕过状态预检 + 执行记录，下游 reply / SSE / 规则历史会断片。

2. **修改 server.js 后必须杀进程重启**。Node.js 没有 hot reload；`config.json` 的部分字段（如 settings 那批）通过 `/api/settings` PUT 可以热生效，其他都要重启。

3. **`config.json` 改之前先备份**。这文件包含 token/apikey/规则/价格表，改坏了线上故障。`cp config.json config.json.$(date +%s).bak` 是肌肉记忆。

4. **不要在前端用 localStorage**。当前实现是无登录单租户，没必要；以后加多用户必须走后端 session，前端不存敏感数据。

---

## 10. 已知 limitation 清单

| 项 | 说明 | 计划 |
|---|---|---|
| 单摄像头 | 当前架构假设单 RTSP 流 | v2 时改 `cameras: []` 数组 |
| 无鉴权 | 任何局域网请求都能控设备 | 加 token 中间件 |
| 单语言 prompt | 中文场景调优过的 prompt | 抽出 i18n 字典 |
| 规则条件靠 LLM 判断 | 复杂条件成本高、不稳定 | 加结构化条件支持，LLM 兜底 |
| Voice pipeline 单实例 | 同一时刻只一路 voice | 多用户场景需重写 |
| 无历史数据 | snapshot/audio 周期覆盖，无 timeline | 加 SQLite + retention policy |
| ffmpeg 强依赖 | 容器和宿主机都得装 | 提供纯 wasm fallback（远期） |

---

## 11. 文档维护规则

修代码时同步改这两份文档：

- 加新 endpoint → 改 `CODE_GUIDE.md` 第 3 节 + `server.js` 行号
- 加新 config 字段 → 改 `CODE_GUIDE.md` 第 4 节
- 改架构（如换数据库）→ 改 `ARCHITECTURE.md` 第 4 节模块图

---

文档结束。如果文档和代码冲突，**以代码为准**——这两份文档每次大改后会过一遍，但难免漏。
