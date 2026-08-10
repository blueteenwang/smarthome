# Smart Home AI · 架构设计文档

> 版本：2026-05  
> 适用范围：`smart-home-ai` 单仓代码库  
> 读者：贡献者 / 二次开发者 / 部署运维 / 自己未来的你

---

## 1. 一句话定位

**面向 Home Assistant 中文用户的 AI 智能家居控制中枢**：把家庭摄像头 RTSP 流 + 大模型视觉/语音理解 + Home Assistant 设备网关 + 小爱音箱 TTS 串成一个零依赖、可自部署、可定制规则的实时控制面板。

把"看到（Vision）—— 听到（Voice）—— 想到（LLM）—— 做到（HA Service Call）—— 说出来（小爱播报）"做成一条闭环。

---

## 2. 设计原则

| 原则 | 含义 | 反例（项目中刻意避开） |
|---|---|---|
| **零依赖** | 后端只用 Node.js 内置模块（`http` `child_process` `fs`）+ ffmpeg 二进制；前端零打包工具单文件 HTML | 不引入 Express/WebSocket 库/任何 npm 包 |
| **配置即真相** | 全部可调参数在 `config.json`，运行时热读，不依赖环境变量魔法 | 不做 .env 文件 / 不做注入容器变量 |
| **设备无侵入** | 所有写操作走 HA REST，不直连米家/Aqara/海尔 | 不写 MQTT/Mihome 私有协议 |
| **失败可见** | 每个外部依赖（RTSP/HA/DashScope/小爱）都有降级路径 + 日志可见 | 不静默失败，不假成功 |
| **可观测优先** | LLM 用量、规则触发、ASR 段落全部有时间线和成本 | 不依赖第三方监控 |

---

## 3. 部署拓扑

```
┌────────────────────────────────────────────────────────────────────┐
│                          家庭局域网 (192.168.x.x)                    │
│                                                                    │
│   ┌─────────────┐     RTSP/H.265 (4K)    ┌───────────────────────┐  │
│   │ 萤石 C6WI   │ ─────────────────────► │ 群晖 NAS              │  │
│   │ 摄像头      │                         │ ┌───────────────────┐ │  │
│   └─────────────┘                         │ │ Synology Surveil. │ │  │
│                                           │ │ Station (ssrtspd) │ │  │
│   ┌─────────────┐                         │ └─────────┬─────────┘ │  │
│   │ 米家小爱    │ ◄── HA notify (HTTP) ── │           │ RTSP        │  │
│   │ 音箱 X10A   │                         │ ┌─────────▼─────────┐ │  │
│   └─────────────┘                         │ │ Docker:           │ │  │
│                                           │ │ smart-home-ai     │ │  │
│   ┌─────────────┐    HA Service Call      │ │ (Node.js+ffmpeg)  │ │  │
│   │ 海尔空调 ×6 │ ◄────────────────────── │ │ 8090 端口         │ │  │
│   │ 杜亚窗帘 ×N │                         │ └─────────┬─────────┘ │  │
│   │ Yeelight ×N │                         │           │ HA REST    │  │
│   │ 154 开关    │                         │ ┌─────────▼─────────┐ │  │
│   └─────────────┘                         │ │ Home Assistant    │ │  │
│                                           │ │ 8123 (1391 实体)  │ │  │
│   ┌─────────────┐    HTTP/SSE             │ └───────────────────┘ │  │
│   │ 浏览器      │ ─────────────────────► │                       │  │
│   │ 仪表盘 UI   │                         │                       │  │
│   └─────────────┘                         └───────────────────────┘  │
│                                                                    │
│                                  ──── 公网 ───►  ┌──────────────┐  │
│                                                  │ 阿里云       │  │
│                                                  │ DashScope    │  │
│                                                  │ qwen3-vl/max │  │
│                                                  │ /omni        │  │
│                                                  └──────────────┘  │
└────────────────────────────────────────────────────────────────────┘
```

关键事实：

- **RTSP 摄像头与 HA 与本服务在同一台 NAS** 是测试场景。生产 / 推广默认 `bridge` 网络模式 + 真实 IP。
- **本服务不持久化用户数据**：snapshot 是临时图像、audio 是滚动文件、规则在 `config.json`、token 用量在内存（重启清零）。
- **LLM 调用全部走 DashScope**：vision (qwen3-vl-235b) / command (qwen3-max) / qa (qwen-turbo) / asr (qwen3-omni-flash)。

---

## 4. 模块视图（逻辑分层）

```
┌────────────────────────────────────────────────────────────────────┐
│                        前端（index.html / index-v2.html）            │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌──────────────┐  │
│  │ Hero Env    │ │ Camera View │ │ Voice Panel │ │ Device Grid  │  │
│  │ (温湿光)    │ │ MJPEG/MSE   │ │ (Push-to-   │ │ (按 type/    │  │
│  │             │ │ + Snapshot  │ │  Talk + SSE)│ │  room 分组)  │  │
│  └─────────────┘ └─────────────┘ └─────────────┘ └──────────────┘  │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌──────────────┐  │
│  │ AI 场景分析 │ │ 规则触发栈  │ │ Token 浮层  │ │ 设置侧栏     │  │
│  │ (60s 周期)  │ │ (右上 SSE)  │ │ (LLM 用量)  │ │ (HA/LLM/RTSP)│  │
│  └─────────────┘ └─────────────┘ └─────────────┘ └──────────────┘  │
└─────────────────────────────────┬──────────────────────────────────┘
                                  │ HTTP / SSE / multipart-jpeg
┌─────────────────────────────────▼──────────────────────────────────┐
│                       HTTP Router (server.js 末段)                   │
│       ~50 个 endpoint：/api/{stream, command, rules, voice/*, ...}   │
└─────────────────────────────────┬──────────────────────────────────┘
                                  │
        ┌─────────────────────────┼─────────────────────────┐
        │                         │                         │
┌───────▼────────┐      ┌─────────▼────────┐     ┌─────────▼────────┐
│  Capture 层    │      │   Cognition 层   │     │  Action 层       │
│ ─────────────  │      │ ─────────────── │     │ ─────────────── │
│ Snapshot       │      │ analyzeSnapshot  │     │ haRequest()      │
│   Daemon       │      │   (vision LLM)   │     │ executeService   │
│ refreshSnapshot│      │ transcribeAudio  │     │   Safe()         │
│ captureAll     │      │   (asr LLM)      │     │ shouldSkipAction │
│ Voice Pipeline │      │ processNLCommand │     │ summarizeExecuted│
│   (VAD+ASR)    │      │   (command LLM)  │     │ naturalizeReply  │
│                │      │ chitchatLLM      │     │                  │
│                │      │   (qa LLM)       │     │                  │
└───────┬────────┘      └─────────┬────────┘     └─────────┬────────┘
        │                         │                         │
┌───────▼─────────────────────────▼─────────────────────────▼────────┐
│                         外部依赖适配层                              │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌────────────┐ │
│  │ ffmpeg       │ │ DashScope    │ │ Home         │ │ 米家/小爱  │ │
│  │ (RTSP capture│ │ (LLM via     │ │ Assistant    │ │ (HA notify │ │
│  │  + 转码)     │ │  HTTPS)      │ │ (HTTP token) │ │  实体)     │ │
│  └──────────────┘ └──────────────┘ └──────────────┘ └────────────┘ │
└────────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────────┐
│                         横切关注点                                  │
│  TokenUsage（成本统计）  AutomationEngine（规则）  EventBus（SSE）  │
└────────────────────────────────────────────────────────────────────┘
```

### 4.1 Capture 层（输入/感知）

| 子模块 | 职责 | 关键状态 |
|---|---|---|
| `startSnapshotDaemon()` | 长连接 ffmpeg，周期写 `latest.jpg`（默认 30s） | `daemonProc`, `lastSnapshotMtime` |
| `refreshSnapshot()` | 一次性 ffmpeg snapshot（兜底用） | `isSnapshotRefreshing` |
| `captureAll()` | 同时拉视频帧 + 音频片段（WAV 16kHz mono） | `isCapturing`，遇 voice rtsp 占用返回 `skipped:true` |
| `VoicePipeline` | VAD 门控 + 滚动 PCM 缓冲 + 静音检测 + 唤醒 + ASR | `audioSource ∈ {rtsp, local}`, `running`, `currentPid` |
| `detectStreamProfile()` | ffprobe 探流：编码/分辨率/帧率，决定转码策略 | `streamProfile` |
| `checkSnapshotHealth()` | 8x8 RGB 采样判断是否绿屏/全黑 | `frameHealthHistory[]` |

设计要点：

- **ffmpeg 进程互斥**：摄像头 RTSP 单连接极敏感，`activeStreamClients` 计数 + voice pipeline rtsp 模式锁定时 captureAll 自动跳过。
- **健康检查驱动恢复**：连续 N 帧 corrupt → `pkill ffmpeg` 让 daemon 重生。
- **Voice 双源切换**：`audioSource: rtsp` 走摄像头麦（远场），`local` 走 macOS avfoundation（近场，开发用）。

### 4.2 Cognition 层（理解）

| 子模块 | 触发 | LLM | 输入 → 输出 |
|---|---|---|---|
| `analyzeSnapshot()` | 周期任务 60s | qwen3-vl-235b | base64 图像 → `{scene, status, brightness, occupied, suggestions[]}` |
| `transcribeAudio(buffer, kind)` | captureAll / VoicePipeline 段触发 | qwen3-omni-flash | WAV → `{text, segments?}` |
| `processNLCommand(command)` | `/api/command` 或 voice 段 | qwen3-max | 文字 → `{actions:[{domain, service, target_keyword, params}]}` |
| `chitchatLLM(command)` | NL 命令理解失败 + qa fallback 开关 | qwen-turbo | 文字 → 一句话回复（≤80 tokens） |
| `naturalizeReply(records, q)` | 命令执行完后 | qwen-turbo | 执行记录骨架 → 自然口语版本 |

设计要点：

- **多模型分级**：贵的（vl/max）只在必要时触发，便宜的（turbo）兜底；总成本可量化。
- **结构化输出 + 防御性解析**：所有 LLM 调用 prompt 强制 JSON、外层包 try/catch、解析失败返回骨架。
- **预热与缓存**：`_rawEntities` Map 缓存 HA 状态，命令侧匹配 keyword 不用每次拉 `/states`。

### 4.3 Action 层（执行）

| 子模块 | 职责 |
|---|---|
| `haRequest(method, path, body)` | HA REST 单点入口，注入 token，处理 401/429 |
| `executeServiceSafe(domain, service, data)` | 唯一允许写 HA 的函数，记录 idempotency + 执行结果 |
| `shouldSkipAction(action, entity)` | 状态预检：light/switch/fan/climate/cover/media_player 已是目标态则 skip |
| `summarizeExecuted(records)` | 把执行记录转成事实化骨架 reply（防 LLM 编造） |
| `naturalizeReply(records, query)` | LLM 改写骨架成自然口语，4s timeout 失败回退 |
| `tryBroadcastIntent(command)` | 识别"小爱播报 xxx"意图，绕过 NL 流程直接 HA notify |
| `speakReply(text, type)` | 分发：xiaoai.enabled+triggerOn → HA notify；audioSource=local → macOS `say` |

设计要点：

- **状态预检**：避免对已开的灯再发 turn_on（用户语音"打开餐厅灯"两次时第二次直接 skip 不打 HA）。
- **事实骨架先行 → 自然语言后置**：先用确定的执行结果生成骨架，再让 LLM rephrase 让句子自然，但 LLM 不能改事实。
- **执行记录 schema 统一**：所有写操作都经 executeServiceSafe → records，下游 reply / 规则触发历史 / SSE 事件共用一份数据。

### 4.4 横切关注点

**TokenUsage**（`server.js` 第 29 行）

每次 LLM 调用注册 `(model, in_tokens, out_tokens, ts)`，按 `config.llmPricing` 算 CNY，前端 GET `/api/usage` 拉日累计。

**AutomationEngine**（`server.js` 第 551 行）

规则数据在 `config.automation.rules[]`，schema：

```jsonc
{
  "id": "rule-1779497639026-2rhp6",
  "name": "餐厅有人吃饭打开餐厅灯",
  "trigger": "vision" | "audio" | "both",
  "condition": "有人在餐厅吃饭",   // 自然语言，喂给 LLM piggyback 判断
  "actions": [{ "domain": "light", "service": "turn_on", "target_keyword": "餐厅" }],
  "cooldownSec": 300,
  "min_confidence": 0.7,
  "enabled": true,
  "dryRun": false                  // true 时只触发 SSE 不打 HA
}
```

每次 vision 分析后 piggyback 同一次 LLM 调用问"哪些规则被命中？"零额外成本。

**EventBus（SSE）**

`/api/rules/events` 推送规则触发；`/api/voice/events` 推送 ASR 段落和状态。前端 `EventSource` 连接，直接 onmessage 渲染。

---

## 5. 数据流：典型场景拆解

### 5.1 用户在仪表盘输入"打开餐厅的灯"

```
浏览器
  │ POST /api/command  body={command:"打开餐厅的灯"}
  ▼
HTTP Router (line 2731)
  │ 1) tryBroadcastIntent("打开餐厅的灯") → 不命中代播
  ▼
processNLCommand (line 850)
  │ 2) 拉 HA /states (走 _rawEntities 缓存)
  │ 3) 构造 prompt：把 1391 实体 friendly_name 喂给 qwen3-max
  │ 4) LLM 返回 {actions:[{domain:"light", service:"turn_on", target_keyword:"餐厅"}]}
  ▼
fuzzyKeywordMatch (line 937)
  │ 5) 在 1391 实体里模糊匹配 "餐厅" → light.dining_room_main
  ▼
shouldSkipAction
  │ 6) 当前 state=on？是 → skipped；否 → 继续
  ▼
executeServiceSafe → haRequest
  │ 7) POST http://192.168.X.X:8123/api/services/light/turn_on  body={entity_id:"light.ke_ting..."}
  │ 8) HA 响应 200，记录 records.push({entity_id, service, success})
  ▼
summarizeExecuted (line 1154)
  │ 9) 骨架 reply: "已为您打开餐厅的灯。"
  ▼
naturalizeReply (line 1227)
  │10) qwen-turbo rephrase: "餐厅灯已为您打开。"（自然版）
  ▼
speakReply
  │11) HA notify.xiaomi_*_play_text_* → 小爱说出来
  │12) macOS say (如果 audioSource=local)
  ▼
HTTP Response 200
  body={understood:true, executed:[...], reply:"...", source:"command"}
```

**LLM 调用次数**：1 次 command（qwen3-max）+ 1 次 naturalize（qwen-turbo），总成本 ≈ ¥0.01。

### 5.2 摄像头 60 秒周期 AI 分析触发自动化规则

```
startPeriodicTasks (line 2222)
  │ 60 秒 setInterval
  ▼
captureAll
  │ 1) 检查 voice pipeline 是否占 RTSP，是 → skipped:true
  │ 2) 否 → ffmpeg 拉 snapshot.jpg + audio.wav
  ▼
analyzeSnapshot
  │ 3) base64(snapshot.jpg) → qwen3-vl-235b
  │ 4) prompt 同时含规则条件列表（piggyback）
  │ 5) LLM 返回 {scene, occupied, suggestions, triggered_rules:["rule-xxx"]}
  ▼
AutomationEngine.evaluate
  │ 6) 对每条 triggered rule 检查 cooldown / min_confidence / enabled / dryRun
  │ 7) 通过 → 走 executeServiceSafe + speakReply 同上
  │ 8) SSE 推送 rule-fired event 到前端右上角栈
```

**LLM 调用次数**：1 次 vision（qwen3-vl-235b）≈ ¥0.013，规则判断零额外成本。

### 5.3 语音唤醒 + 命令

```
VoicePipeline.start (audioSource=rtsp)
  │ ffmpeg -i rtsp -f s16le 输出 PCM 流到 stdout
  ▼
on('data', chunk)  // 100ms 帧 (3200 bytes)
  │ 1) 计算 RMS energy
  │ 2) > on_threshold → enter speech；< off_threshold → silence countdown
  │ 3) 累积 PCM 到 segmentBuffer，前置 200ms preRoll
  ▼
段触发条件：silence 1000ms / segment ≥ 8s / maxUtterance
  ▼
asrTranscribe(wav, kind='full')
  │ 4) qwen3-omni-flash 转写
  │ 5) 文本 = "贾维斯打开餐厅的灯"
  ▼
matchWakeWord
  │ 6) 命中 "贾维斯" → 截掉前缀，剩 "打开餐厅的灯"
  ▼
tryBroadcastIntent → 否
processNLCommand → ... 同 5.1
  ▼
SSE /api/voice/events 推送 transcript + 执行结果到前端
小爱 / macOS say 播报 reply
```

**1.5s partial ASR**：每 1.5s 重跑 ASR 给前端做 live display，与最终段独立。

---

## 6. 安全模型

| 资产 | 风险 | 当前措施 |
|---|---|---|
| HA long-lived token | 泄露 → 全屋设备被控 | config.json 不进 git；`.dockerignore` 排除；`/api/settings` GET 返回遮罩串 |
| DashScope API Key | 泄露 → 账户被刷 | 同上 |
| RTSP 密码 | 泄露 → 摄像头被偷看 | DSM 流密码 1h TTL 强制轮换；密码在 config 中 |
| 端口 8090 | 公网暴露 → 任何人能控设备 | 默认仅监听 0.0.0.0:8090（局域网）；**生产部署必须放反向代理或 NAS 防火墙后** |
| 局域网钓鱼 | LAN 内攻击者构造 NL 命令打 HA | 当前无鉴权，**这是已知 limitation** |

**未实现的安全特性**（已知缺口，发布前补）：

1. 仪表盘登录 / API token
2. CSRF / Origin 校验
3. 命令白名单（禁止 `homeassistant.restart` 等高危服务）
4. SSE 长连接资源限制

---

## 7. 错误处理与降级

每个外部依赖单独的失败模式：

| 依赖 | 失败现象 | 降级路径 |
|---|---|---|
| RTSP 摄像头 | 401 / 流断 / 绿屏 | snapshot daemon 自动重启；连续 corrupt → pkill ffmpeg；UI 显示占位图 |
| DashScope LLM | 超时 / 限流 / 401 | vision 跳过本周期；command 返回 `understood:false`；naturalize 回退骨架 |
| Home Assistant | 401 / 超时 / 5xx | 写操作 record.success=false；`/api/ha/states` 缓存兜底 |
| 小爱 notify entity | 不存在 / 超时 | 静默失败 + log；不阻塞主流程 |
| macOS `say` | 仅本地模式有；容器中 ENOENT | 静默失败 |

---

## 8. 性能基准（实测）

| 操作 | 耗时 | 备注 |
|---|---|---|
| 浏览器首屏渲染 | <500ms | 单 HTML，无 bundle |
| Snapshot 刷新（4K HEVC 软解） | ~1.2s | 软解 0.18× 实时 |
| Snapshot 刷新（1080p H.264） | ~0.4s | 软解 3× 实时 |
| MJPEG 第一帧到达 | 22s（4K HEVC）/ 0.3s（1080p H.264） | 第一个 I-frame 等待 |
| MSE+fMP4 端到端延迟 | 0.24-0.28s（1080p libx264 重编码） | macOS 26 实测 |
| AI vision 分析 | 1.8-3.2s | qwen3-vl-235b |
| ASR（5s 段） | 0.6-1.2s | qwen3-omni-flash |
| NL command end-to-end | 1.2-2.5s | command + naturalize 共 2 次 LLM |
| HA service call | 80-180ms | 局域网 |

---

## 9. 演进路径

**已完成**：MVP 仪表盘 → 视觉分析 → NL 命令 → 语音控制 → 自动化规则 → 状态预检 → 自然回复 → 配置 UI → MSE 视频低延迟 → Docker 化。

**进行中**：推广发布、Docker 镜像、跨 NAS 验证、HA 中文社区文章。

**计划**：

1. **MCP server 入口**：暴露为 MCP，让 HA 用户在 Claude Desktop / Qoder 直接调用
2. **本地 LLM 适配**：替换 DashScope 为 Ollama / vLLM，无网部署
3. **WebRTC 视频流**：低延迟首帧 <100ms（取代 MSE+fMP4）
4. **多摄像头**：当前单 RTSP，扩展 N 路并发
5. **认证层**：JWT + 设备命令白名单

---

## 10. 关键决策日志（供未来回溯）

| 决策 | 选择 | 否决项 | 理由 |
|---|---|---|---|
| 视频流协议 | MJPEG + MSE 双路 | HLS / WebRTC | 零依赖 / 浏览器原生 / 没 STUN 服务器需求 |
| ASR | qwen3-omni-flash 整段 | paraformer-realtime WS | -150 LOC，1-1.5s 延迟可接受 |
| 命令 LLM | qwen3-max | qwen-plus / 本地 LLM | 1391 实体长 prompt 准确率最稳 |
| 自动化规则 | 自然语言条件 + LLM piggyback | YAML 结构化条件 | 用户写规则零门槛，不增加 LLM 调用 |
| Reply 自然化 | 骨架 + LLM rephrase | 全 LLM 生成 | 防 LLM 编造执行结果 |
| Docker 网络 | bridge + ports | host | 跨平台一致性 + HA 圈惯例 |
| 部署形态 | 单 Node.js 进程 | 微服务 / serverless | 家庭场景，单点足够 |
| 数据持久化 | 无 DB | SQLite | 状态全在 HA + config.json，无业务数据 |

---

文档结束。下一步推荐先读 `CODE_GUIDE.md`，那里有逐文件 / 逐函数的开发者手册。
