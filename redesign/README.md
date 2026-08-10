# Redesign Mock — 17 项 P0/P1/P2/P3 改造

独立 mockup（不动 `index.html`/`server.js`），用于 review 和后续手动 merge。

## 文件

- `mockup.html` — 单文件、自包含、纯 HTML + CSS + 极少 JS（count-up 演示）。本地双击即开。
- `preview/01-top.jpg` — 渲染后首屏（Chrome 1512×900）
- `preview/02-stats-devices.jpg` — 渲染后第二屏（stats-bar + 设备网格）

## 改造逐项核对

| # | 等级 | 问题 | 修复方案 | mockup 体现位置 |
|---|------|------|----------|----------------|
| 1 | P0 | 摄像头下半紫白光斑 | 健康检测 → 叠 `.signal-overlay` 蒙版 + 显示 "📡 信号弱，正在重建关键帧" + 重试倒计时 | `camera-frame` 内 |
| 2 | P0 | toggle 红色虚线 active | active 态改 emerald 实色 + glow，inactive 改 slate 实线 | `.h-toggle.active` |
| 3 | P0 | "执行"按钮红色 | iris→cyan 渐变实色 + 阴影 + hover lift | `.btn-primary` |
| 4 | P0 | KPI 第 5 卡 + marquee 被裁切 | 5 卡 `grid-template-columns: repeat(5, max-content)`，marquee 独立 row 自带 overflow 控制 | `.hero` |
| 5 | P1 | stats 4 大卡密度低 + 信息冗余 | 4 卡重写：设备总数+sparkline / 灯光 X/52+room-dist / 空调 X/6+趋势 / 自动化+24h 触发；删光照重复 | `.stats-bar` |
| 6 | P1 | 设备卡片双重命名 | 主标题只留用户视角名（"餐厅灯"），物理名（"客厅中两键"）灰色 small chip | `.dev-name` + `.dev-meta .physical` |
| 7 | P1 | LLM TOKENS 浮层无分页 | mockup 未铺开浮层（独立 modal 任务），但 design token 已就位，直接套 `.card` 容器 + tab 即可 | 待 wire-up |
| 8 | P1 | 转写卡很弱 | `相对时间 / chip 分类（唤醒/语音/环境）/ 5 行历史` + 唤醒条目高亮 iris border | `.tr-item.wake` |
| 9 | P2 | 时间戳无新鲜度暗示 | 改相对时间 "1m 47s 前" + 灰 stale 徽章；可触发 `.badge.stale` | `.badge.stale` |
| 10 | P2 | 建议无批量执行 | 顶部 `.bulk-bar` 加"全部执行/全部忽略" + 每条左侧 1/2/3 数字键标 | `.bulk-bar` + `.sg-key` |
| 11 | P2 | placeholder 太长 + 中英双重提示 | 简化"对家说点什么…" + 5 个 chip 预设可点即填 | `.voice-input` + `.v-chips` |
| 12 | P2 | 房间 tab 不 sticky | mockup 中 `.dev-toolbar` 设置 `position: sticky; top: 60px`（被 absolute 内嵌覆盖了，merge 时改成顶层 sticky 即可）| `.dev-toolbar` |
| 13 | P3 | 圆角/间距/字号/色温混乱 | `:root` 定义全套 design token：spacing 4-40 / radius 8/14/20 / type 11/13/15/18/28/38 / color zinc-slate | `:root` 全部 vars |
| 14 | P3 | 缺实时脉搏动效 | 状态点 `pulse` 2.4s ease-in-out / `card-title .dot` 一致 / `.cam-overlay-tl` LIVE dot 1.2s 急速 / count-up 演示 | `@keyframes pulse` + JS `animateNum()` |
| 15 | P3 | 背景纯黑 | 三层 radial gradient + 32px grid 双向网格 + body bg compose | `body` |
| 16 | P3 | 数字非等宽 | `font-variant-numeric: tabular-nums` 全局 + `var(--font-mono)` 用于关键数字 | 全局 |
| 17 | P3 | 房子 emoji logo | 自绘 SVG 内联（线性 + 内部光点） | `.brand-logo svg` |

## 视觉语言总结

- **色板**：深底（zinc-950 / zinc-900）+ 三 accent（iris #818cf8 / cyan #22d3ee / emerald #34d399）+ 两 warm（amber / rose）。所有正向操作走 iris-cyan 渐变；warning 用 amber；只有真正的 destructive 才用 rose。
- **节奏**：所有"实时"信号（dot/health-dot/LIVE/cam-overlay-tl）都 pulse；所有 "稳态" 元素（card / stat-num）静止 → 动静对比制造科技感。
- **字体**：UI 用系统默认 sans，所有数字（°C/lx/%/温度/价格/计数）走 JetBrains Mono / SF Mono fallback + tabular-nums。
- **网格背景**：32px 双向 line + 三 radial 灯，避免纯黑乏味，又不抢 hero 视线。

## 没在 mockup 里的（明知有但留 next round）

- P4-18 全屋一览总览（其实 stats-bar 4 卡已部分覆盖）
- P4-19 AI 分析历史 timeline 抽屉
- P4-20 事件流 timeline（右侧固定）
- P4-22 健康指标 dot 自动变红（需 server 端 `/api/health/*`）
- P5-23 <1280px / <1024px / <768px 三档 media query

## merge 路线建议

1. 把 `:root` design token 块整段拷到 `index.html` 头部 `<style>`，别替换现有 vars，让新旧并存
2. 渐进式重写：header → hero → camera 蒙版 → stats-bar → 设备卡片 → 转写卡。每一段单独 commit + 截图核对
3. 摄像头蒙版需要 server 端配合：扩展 `checkSnapshotHealth()` 的 8x8 RGB 探测，返回 `{healthy, reason}`，前端按 reason 显示蒙版
4. P0 4 项可以先 ship（纯样式改动，影响最小）；P1/P2 涉及结构调整，分批
