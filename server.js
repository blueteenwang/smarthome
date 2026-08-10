/**
 * Smart Home AI Control Panel - Backend Server
 * 
 * Features:
 * - RTSP camera snapshot capture (via ffmpeg)
 * - AI vision analysis (via DashScope qwen-vl-plus)
 * - Home Assistant device control proxy
 * - Configurable via config.json
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync, exec, spawn } = require('child_process');
const url = require('url');

// Load config
const CONFIG_PATH = path.join(__dirname, 'config.json');
let config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));

const PORT = config.server.port || 8090;
const SNAPSHOT_DIR = path.join(__dirname, 'snapshots');
const SNAPSHOT_PATH = path.join(SNAPSHOT_DIR, 'latest.jpg');

if (!fs.existsSync(SNAPSHOT_DIR)) fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });

// ============ LLM Token Usage Tracking ============
const TokenUsage = {
  byModel: {},                    // { model: { calls, promptTokens, completionTokens, totalTokens, since } }
  byType: {},                     // { type: { calls, promptTokens, completionTokens, totalTokens } }
  recent: [],                     // ring buffer of recent calls
  RECENT_MAX: 100,
  startedAt: Date.now(),
  // CNY per 1K tokens — adjust in config.json if needed
  pricing: (config.llmPricing) || {
    'qwen-vl-plus':    { in: 0.008,  out: 0.008 },
    'qwen-vl-max':     { in: 0.020,  out: 0.020 },
    'qwen-plus':       { in: 0.0008, out: 0.002 },
    'qwen-turbo':      { in: 0.0003, out: 0.0006 },
    'qwen-omni-turbo': { in: 0.0008, out: 0.002 },
  },
  record(model, type, prompt, completion) {
    if (!model) model = 'unknown';
    const total = (prompt || 0) + (completion || 0);
    if (!total) return;
    if (!this.byModel[model]) {
      this.byModel[model] = { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, since: Date.now() };
    }
    const m = this.byModel[model];
    m.calls++;
    m.promptTokens += prompt || 0;
    m.completionTokens += completion || 0;
    m.totalTokens += total;
    if (!this.byType[type]) {
      this.byType[type] = { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    }
    const t = this.byType[type];
    t.calls++;
    t.promptTokens += prompt || 0;
    t.completionTokens += completion || 0;
    t.totalTokens += total;
    this.recent.push({ ts: Date.now(), model, type, prompt: prompt || 0, completion: completion || 0, total });
    if (this.recent.length > this.RECENT_MAX) this.recent.shift();
  },
  recordFromResponse(model, type, parsed) {
    if (!parsed) return;
    // Three response shapes: OpenAI-compatible (top-level usage), DashScope native (output.usage or top-level usage)
    const u = parsed.usage || parsed.output?.usage || null;
    if (!u) return;
    const prompt = u.prompt_tokens ?? u.input_tokens ?? u.input_token_count ?? 0;
    const completion = u.completion_tokens ?? u.output_tokens ?? u.output_token_count ?? 0;
    this.record(model, type, prompt, completion);
  },
  costCNY() {
    let cost = 0;
    for (const [model, s] of Object.entries(this.byModel)) {
      const p = this.pricing[model] || { in: 0.001, out: 0.002 };
      cost += (s.promptTokens / 1000) * p.in + (s.completionTokens / 1000) * p.out;
    }
    return cost;
  },
  summary() {
    const totalPrompt = Object.values(this.byModel).reduce((s, m) => s + m.promptTokens, 0);
    const totalCompletion = Object.values(this.byModel).reduce((s, m) => s + m.completionTokens, 0);
    const totalCalls = Object.values(this.byModel).reduce((s, m) => s + m.calls, 0);
    return {
      uptimeMs: Date.now() - this.startedAt,
      totalCalls,
      totalTokens: totalPrompt + totalCompletion,
      promptTokens: totalPrompt,
      completionTokens: totalCompletion,
      estimatedCostCNY: +this.costCNY().toFixed(4),
      byModel: this.byModel,
      byType: this.byType,
      recent: this.recent.slice(-30).reverse(),
      pricing: this.pricing,
    };
  },
};

// ============ RTSP Unified Capture (Video + Audio) ============
let lastSnapshotTime = 0;
let isCapturing = false;
let captureFailCount = 0;
let activeStreamClients = 0; // tracks /api/stream consumers to avoid RTSP contention
let isSnapshotRefreshing = false; // fast snapshot-only capture mutex

// ============ Auto-Adaptive Stream Profile ============
// Detected at startup + on bad-frame recovery. Drives stream mode/width/fps decisions
// so the dashboard adapts to whatever the camera is currently configured to output.
let streamProfile = {
  codec: null, width: null, height: null, fps: null,
  isHEVC: false, is4K: false,
  recommendedMode: 'snapshot',  // 'snapshot' (poll latest jpeg) or 'stream' (live MJPEG)
  recommendedStreamWidth: 720,
  recommendedStreamFps: 8,
  recommendedQv: 10,
  recommendedSnapshotIntervalMs: 3000,
  detectedAt: 0,
  reason: 'pending'
};

function deriveProfile(s) {
  // Decision matrix: codec × resolution → optimal pipeline.
  //   Software-decode benchmark: 4K HEVC ≈ 0.18× realtime, 1080p HEVC ≈ 0.7×,
  //   1080p H.264 ≈ 3×, 720p H.264 ≈ 6×. Stream mode needs ≥1.5× to avoid drift.
  const codec = (s.codec_name || '').toLowerCase();
  const isHEVC = codec === 'hevc' || codec === 'h265';
  const isH264 = codec === 'h264';
  const w = Number(s.width) || 1920;
  const h = Number(s.height) || 1080;
  const is4K = w >= 3000;
  const is1080p = w >= 1700 && w < 3000;
  const [num, den] = (s.r_frame_rate || '15/1').split('/').map(Number);
  const reportedFps = den > 0 ? Math.round(num/den) : 15;
  // Some RTSP relays expose the 90 kHz RTP clock as r_frame_rate. It is a
  // timestamp timebase, not an actual camera frame rate.
  const fps = reportedFps > 120 || reportedFps < 1 ? 15 : reportedFps;

  let mode, sw, sf, qv, snapMs, reason;
  if (isHEVC && is4K) {
    mode = 'snapshot'; sw = 640; sf = 4; qv = 12; snapMs = 3000;
    reason = '4K HEVC 软解 ~0.18× realtime → 走 snapshot 轮询';
  } else if (isHEVC && is1080p) {
    mode = 'snapshot'; sw = 720; sf = 6; qv = 10; snapMs = 2000;
    reason = '1080p HEVC 软解 ~0.7× realtime → 仍建议 snapshot';
  } else if (isHEVC) {
    mode = 'snapshot'; sw = 640; sf = 6; qv = 10; snapMs = 2500;
    reason = `${w}x${h} HEVC → snapshot`;
  } else if (isH264 && is4K) {
    // Some NVR/Surveillance Station RTSP relays emit damaged slices when a
    // long-lived client decodes their 4K H.264 stream. ffmpeg then conceals the
    // missing macroblocks as large grey areas. Snapshot mode reconnects on a
    // keyframe and only publishes frames that pass the health check.
    mode = 'snapshot'; sw = 1280; sf = Math.min(fps, 12); qv = 8; snapMs = 750;
    reason = '4K H.264 源流完整性优先 → snapshot 避免灰块残影';
  } else if (isH264 && is1080p) {
    mode = 'stream'; sw = 1280; sf = Math.min(fps, 15); qv = 7; snapMs = 1000;
    reason = '1080p H.264 → 直连 stream';
  } else if (isH264) {
    mode = 'stream'; sw = Math.min(w, 1280); sf = Math.min(fps, 25); qv = 6; snapMs = 1000;
    reason = `${w}x${h} H.264 → 实时 stream`;
  } else {
    mode = 'snapshot'; sw = 640; sf = 5; qv = 10; snapMs = 3000;
    reason = `未知 codec=${codec} → 保守 snapshot`;
  }
  if (config.camera.forceSnapshotMode) {
    mode = 'snapshot';
    sw = Math.min(w, 1280);
    snapMs = 750;
    reason = '源流存在损坏切片 → 常驻快照模式';
  }
  return {
    codec, width: w, height: h, fps,
    isHEVC, is4K,
    recommendedMode: mode,
    recommendedStreamWidth: sw,
    recommendedStreamFps: sf,
    recommendedQv: qv,
    recommendedSnapshotIntervalMs: snapMs,
    detectedAt: Date.now(),
    reason
  };
}

function detectStreamProfile() {
  return new Promise((resolve) => {
    const url = config.camera.rtspUrl;
    const cmd = `ffprobe -v error -rtsp_transport tcp -timeout 8000000 -i "${url}" -select_streams v:0 -show_entries stream=codec_name,width,height,r_frame_rate -of json`;
    exec(cmd, { timeout: 15000, shell: '/bin/bash' }, (err, stdout) => {
      if (err || !stdout) {
        console.warn('[Profile] ffprobe failed, keeping previous profile:', (err?.message || '').slice(0, 80));
        return resolve(streamProfile);
      }
      try {
        const data = JSON.parse(stdout);
        if (!data.streams || !data.streams[0]) throw new Error('no video stream');
        const next = deriveProfile(data.streams[0]);
        const changed = streamProfile.codec !== next.codec
                     || streamProfile.width !== next.width
                     || streamProfile.height !== next.height
                     || streamProfile.fps !== next.fps;
        streamProfile = next;
        console.log(`[Profile]${changed ? ' 🔄 CHANGED' : ''} ${next.codec} ${next.width}x${next.height}@${next.fps}fps → mode=${next.recommendedMode} ${next.recommendedStreamWidth}p@${next.recommendedStreamFps}fps q=${next.recommendedQv} (${next.reason})`);
      } catch (e) {
        console.warn('[Profile] parse error:', e.message);
      }
      resolve(streamProfile);
    });
  });
}

// ============ Frame Health Check ============
// Decode an 8×8 sample of the latest JPEG, compare RGB means to detect:
//   - green screen (HEVC decode artifact when SPS/PPS goes stale)
//   - all-black (sensor signal lost)
//   - all-white (sensor blowout)
function checkSnapshotHealth(filePath) {
  return new Promise((resolve) => {
    if (!fs.existsSync(filePath)) return resolve({ ok: false, reason: 'no-file' });
    const sz = fs.statSync(filePath).size;
    if (sz < 3000) return resolve({ ok: false, reason: `too-small(${sz}b)` });

    const cmd = `ffmpeg -hide_banner -v error -i "${filePath}" -vf "scale=8:8" -f rawvideo -pix_fmt rgb24 -`;
    exec(cmd, { encoding: 'buffer', timeout: 3000, maxBuffer: 4096 }, (err, stdout) => {
      if (err || !stdout || stdout.length < 192) {
        return resolve({ ok: false, reason: 'decode-fail' });
      }
      let r = 0, g = 0, b = 0;
      for (let i = 0; i < 192; i += 3) { r += stdout[i]; g += stdout[i+1]; b += stdout[i+2]; }
      r = (r/64)|0; g = (g/64)|0; b = (b/64)|0;
      const greenDom = g - Math.max(r, b);
      const isGreen = greenDom > 30 && g > 80;        // pure green decode artifact
      const sum = r + g + b;
      const isBlack = sum < 30;                        // total signal loss
      const isWhite = r > 245 && g > 245 && b > 245;   // total blowout
      let reason = 'ok';
      if (isGreen) reason = `green-screen(g-max=${greenDom})`;
      else if (isBlack) reason = 'all-black';
      else if (isWhite) reason = 'all-white';
      resolve({ ok: reason === 'ok', mean: { r, g, b }, reason });
    });
  });
}

let badFrameStreak = 0;
let lastRecoverAt = 0;
function recordFrameHealth(health) {
  if (health.ok) {
    if (badFrameStreak > 0) console.log(`[Health] frames healthy again (was streak ${badFrameStreak})`);
    badFrameStreak = 0;
    return;
  }
  badFrameStreak++;
  console.warn(`[Health] bad frame ${badFrameStreak}/3 — ${health.reason} mean=${JSON.stringify(health.mean || {})}`);
  if (badFrameStreak >= 3 && Date.now() - lastRecoverAt > 30000) {
    lastRecoverAt = Date.now();
    badFrameStreak = 0;
    const host = (config.camera.rtspUrl.match(/@([^:/]+)/) || [])[1] || '192.168';
    console.warn(`[Health] 🔧 recovering — killing ffmpeg sessions for ${host}, refreshing profile`);
    exec(`pkill -9 -f "ffmpeg.*${host}" 2>/dev/null`, () => {
      setTimeout(() => detectStreamProfile().catch(() => {}), 2000);
    });
  }
}

// ============ End auto-adaptive modules ============

// Fast snapshot capture: -t 5 gets enough HEVC data, -frames:v 1 outputs first decoded frame,
// scale=640:-2 reduces decode from 150s to ~10s. Proven working.
// ============ Snapshot Daemon (keep-alive ffmpeg) ============
// 替代每 3s spawn 一次 ffmpeg 的冷启动开销。常驻一个 ffmpeg 持续把 RTSP
// 解码并以 -update 1 -y 模式持续覆写 SNAPSHOT_PATH，前端轮询拿到的总是最新一帧。
// 4K HEVC 软解 0.18× 上限不变，但消除每次 spawn 的 1-2s RTSP 握手 + buffer 等待。
let snapshotDaemon = null;
let snapshotDaemonStartedAt = 0;
let daemonRestartTimer = null;
let snapshotPipeBuffer = Buffer.alloc(0);
let lastSnapshotHealthCheckAt = 0;

function startSnapshotDaemon() {
  if (snapshotDaemon && !snapshotDaemon.killed && snapshotDaemon.exitCode === null) return;
  if (typeof MediaHub !== 'undefined' && MediaHub.status().running) return;
  // 让出权限给 voice rtsp 模式与活跃 stream client
  if (VoicePipeline && VoicePipeline.running && VoicePipeline.audioSource === 'rtsp') {
    console.log('[Daemon] paused — voice pipeline holds RTSP');
    return;
  }
  if (activeStreamClients > 0) {
    console.log('[Daemon] paused — /api/stream client active');
    return;
  }

  const rtspUrl = config.camera.rtspUrl;
  // 用 profile 推荐值（snapshot mode 下：4K HEVC=640p/4fps/q12, 1080p HEVC=720p/6fps/q10）
  const width = streamProfile.recommendedStreamWidth || 640;
  // daemon fps 取一半以减少 CPU；解码 0.18× 已是上限，编码端高 fps 浪费
  const fps = Math.max(2, Math.min(streamProfile.recommendedStreamFps || 4, 5));
  const qv = String(streamProfile.recommendedQv || 12);

  const args = [
    '-hide_banner', '-loglevel', 'error',
    '-fflags', 'genpts+discardcorrupt',
    '-err_detect', 'explode',
    '-rtsp_transport', 'tcp',
    '-probesize', '2M', '-analyzeduration', '1M',
    '-rtbufsize', '16M', '-max_delay', '1000000',
    '-i', rtspUrl,
    '-an',
    '-vf', `scale=${width}:-2:in_range=tv:out_range=pc,fps=2:round=down,format=yuvj420p`,
    '-q:v', qv,
    '-threads', '0',
    '-f', 'image2pipe', '-vcodec', 'mjpeg',
    'pipe:1'
  ];

  snapshotPipeBuffer = Buffer.alloc(0);
  snapshotDaemon = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  snapshotDaemonStartedAt = Date.now();
  const launchedPid = snapshotDaemon.pid;
  console.log(`[Daemon] ✅ started pid=${launchedPid} → ${width}p@${fps}fps q=${qv}`);

  snapshotDaemon.stderr.on('data', (chunk) => {
    const txt = chunk.toString();
    if (txt.includes('401') || txt.includes('Unauthorized')) {
      console.error(`[Daemon] RTSP 401 — credentials expired`);
    } else if (txt.includes('Connection refused') || txt.includes('Connection timed out')) {
      console.error(`[Daemon] RTSP connection error`);
    }
  });

  snapshotDaemon.stdout.on('data', (chunk) => {
    snapshotPipeBuffer = Buffer.concat([snapshotPipeBuffer, chunk]);
    while (true) {
      const soi = snapshotPipeBuffer.indexOf(Buffer.from([0xff, 0xd8]));
      if (soi < 0) { snapshotPipeBuffer = Buffer.alloc(0); break; }
      const eoi = snapshotPipeBuffer.indexOf(Buffer.from([0xff, 0xd9]), soi + 2);
      if (eoi < 0) {
        if (soi > 0) snapshotPipeBuffer = snapshotPipeBuffer.subarray(soi);
        if (snapshotPipeBuffer.length > 8 * 1024 * 1024) snapshotPipeBuffer = Buffer.alloc(0);
        break;
      }
      const jpeg = snapshotPipeBuffer.subarray(soi, eoi + 2);
      snapshotPipeBuffer = snapshotPipeBuffer.subarray(eoi + 2);
      if (jpeg.length < 5000) continue;
      try {
        const nextPath = `${SNAPSHOT_PATH}.next`;
        fs.writeFileSync(nextPath, jpeg);
        fs.renameSync(nextPath, SNAPSHOT_PATH);
        lastSnapshotTime = Date.now();
      } catch (e) {
        console.warn('[Daemon] snapshot publish failed:', e.message);
      }
    }
  });

  snapshotDaemon.on('exit', (code, signal) => {
    if (snapshotDaemon && snapshotDaemon.pid !== launchedPid) return; // stale exit handler
    console.warn(`[Daemon] ffmpeg exited code=${code} signal=${signal} (lifetime ${Math.round((Date.now()-snapshotDaemonStartedAt)/1000)}s)`);
    snapshotDaemon = null;
    if (daemonRestartTimer) clearTimeout(daemonRestartTimer);
    // 退避重启：避免 RTSP 频繁重连引起摄像头封禁
    daemonRestartTimer = setTimeout(startSnapshotDaemon, 3000);
  });
}

function stopSnapshotDaemon(reason) {
  if (daemonRestartTimer) { clearTimeout(daemonRestartTimer); daemonRestartTimer = null; }
  if (snapshotDaemon && !snapshotDaemon.killed) {
    console.log(`[Daemon] 🛑 stopping (${reason})`);
    try { snapshotDaemon.kill('SIGKILL'); } catch (_) {}
    snapshotDaemon = null;
  }
}

function refreshSnapshot() {
  if (typeof MediaHub !== 'undefined' && MediaHub.status().running) return Promise.resolve(true);
  // Daemon 在跑（实测对 4K HEVC ssrtspd 不可行，已禁用启动）：仅做健康检测
  if (snapshotDaemon && !snapshotDaemon.killed && snapshotDaemon.exitCode === null) {
    if (!fs.existsSync(SNAPSHOT_PATH)) return Promise.resolve(false);
    const st = fs.statSync(SNAPSHOT_PATH);
    const fresh = st.size > 5000 && st.mtimeMs > (Date.now() - 8000);
    if (fresh) {
      lastSnapshotTime = st.mtimeMs;
      if (Date.now() - lastSnapshotHealthCheckAt > 3000) {
        lastSnapshotHealthCheckAt = Date.now();
        checkSnapshotHealth(SNAPSHOT_PATH).then(recordFrameHealth).catch(() => {});
      }
    }
    return Promise.resolve(fresh);
  }

  // 主路径: spawn-on-demand（消除 daemon 多连接冲突）
  if (isCapturing || isSnapshotRefreshing) return Promise.resolve(false);
  if (activeStreamClients > 0) return Promise.resolve(false);
  if (VoicePipeline && VoicePipeline.running && VoicePipeline.audioSource === 'rtsp') return Promise.resolve(false);

  isSnapshotRefreshing = true;
  const rtspUrl = config.camera.rtspUrl;
  const width = streamProfile.recommendedStreamWidth || config.camera.snapshotWidth || 640;
  // -t 4s 平衡：HEVC GOP 通常 1-2s，4s 窗口稳定拿到 I-frame；probe 200K 减启动开销
  const cmd = `ffmpeg -hide_banner -loglevel error -fflags nobuffer+flush_packets -flags low_delay -rtsp_transport tcp -probesize 200K -analyzeduration 200K -i "${rtspUrl}" -t 4 -an -vf "scale=${width}:-2:in_range=tv:out_range=pc" -frames:v 1 -update 1 -q:v 5 -y "${SNAPSHOT_PATH}"`;

  return new Promise((resolve) => {
    exec(cmd, { timeout: 30000, shell: '/bin/bash' }, (error) => {
      isSnapshotRefreshing = false;
      if (fs.existsSync(SNAPSHOT_PATH)) {
        const st = fs.statSync(SNAPSHOT_PATH);
        const ok = st.size > 5000 && st.mtimeMs > (Date.now() - 25000);
        if (ok) {
          lastSnapshotTime = Date.now();
          console.log(`[Camera] Snapshot refreshed (${Math.round(st.size/1024)}KB)`);
          checkSnapshotHealth(SNAPSHOT_PATH).then(recordFrameHealth).catch(() => {});
        } else {
          console.log(`[Camera] Snapshot stale (mtime ${new Date(st.mtimeMs).toLocaleTimeString()}, size ${st.size})`);
          recordFrameHealth({ ok: false, reason: 'stale-mtime' });
        }
        resolve(ok);
      } else {
        console.log(`[Camera] Snapshot failed: ${error?.message?.slice(0, 80) || 'no file'}`);
        recordFrameHealth({ ok: false, reason: 'no-output' });
        resolve(false);
      }
    });
  });
}

// Single ffmpeg process captures both snapshot and audio simultaneously
function captureAll() {
  // Mutex with refreshSnapshot — but signal `skipped:true` so the fallback
  // analysis path (uses latest in-memory snapshot) still runs.
  if (isCapturing || isSnapshotRefreshing) return Promise.resolve({ video: false, audio: false, skipped: true });
  if (typeof MediaHub !== 'undefined' && MediaHub.status().running) return Promise.resolve({ video: false, audio: false, skipped: true });

  // If a live stream is active, skip RTSP capture (camera allows limited concurrent connections).
  // The stream itself keeps frames flowing; AI analysis can re-use the most recent in-memory snapshot.
  if (activeStreamClients > 0) {
    console.log(`[Capture] Skipped (${activeStreamClients} stream client(s) active)`);
    return Promise.resolve({ video: false, audio: false, skipped: true });
  }

  // The persistent snapshot daemon already owns the RTSP video connection.
  // Opening the legacy combined video/audio capture in parallel can overload
  // the NVR relay and reintroduce damaged H.264 slices.
  if (snapshotDaemon && !snapshotDaemon.killed && snapshotDaemon.exitCode === null) {
    console.log('[Capture] Skipped (snapshot daemon owns RTSP)');
    return Promise.resolve({ video: false, audio: false, skipped: true });
  }

  // If voice control pipeline is running AND using RTSP audio source,
  // it owns the RTSP audio path. Skip captureAll to avoid camera lockout.
  // When voice uses local mic (avfoundation), no RTSP conflict exists.
  if (VoicePipeline && VoicePipeline.running && VoicePipeline.audioSource === 'rtsp') {
    console.log('[Capture] Skipped (voice pipeline active on RTSP)');
    return Promise.resolve({ video: false, audio: false, skipped: true });
  }
  
  if (captureFailCount > 3) {
    const backoffSec = Math.min(captureFailCount * 30, 300);
    console.log(`[Capture] Backing off for ${backoffSec}s (${captureFailCount} failures)`);
    captureFailCount++;
    if (captureFailCount > 10) captureFailCount = 0;
    return Promise.resolve({ video: false, audio: false });
  }
  
  isCapturing = true;
  const duration = config.audio?.captureDurationSec || 10;
  
  return new Promise((resolve) => {
    const rtspUrl = config.camera.rtspUrl;
    // One ffmpeg, two outputs: I-frame snapshot + WAV audio
    const cmd = `ffmpeg -rtsp_transport tcp -i "${rtspUrl}" -t ${duration} ` +
      `-vf "select=eq(pict_type\\,I),scale=iw:ih:in_range=tv:out_range=pc,format=yuvj420p" -fps_mode vfr -update 1 -q:v 2 -y "${SNAPSHOT_PATH}" ` +
      `-vn -acodec pcm_s16le -ar 16000 -ac 1 -y "${AUDIO_PATH}" ` +
      `2>&1 | tail -3`;
    
    exec(cmd, { timeout: (duration + 15) * 1000, shell: '/bin/bash' }, (error, stdout) => {
      isCapturing = false;
      
      const videoStat = fs.existsSync(SNAPSHOT_PATH) && fs.statSync(SNAPSHOT_PATH);
      const videoOk = videoStat && videoStat.size > 5000 && videoStat.mtimeMs > (Date.now() - (duration + 5) * 1000);
      const audioOk = fs.existsSync(AUDIO_PATH) && fs.statSync(AUDIO_PATH).size > 1000;
      
      if (!videoOk && !audioOk) {
        captureFailCount++;
        console.error(`[Capture] Both failed (attempt ${captureFailCount}):`, (stdout || error?.message || '').slice(0, 100));
      } else {
        captureFailCount = 0;
        if (videoOk) {
          lastSnapshotTime = Date.now();
          console.log(`[Capture] Snapshot saved at ${new Date().toLocaleTimeString()}`);
        }
        if (audioOk) {
          console.log(`[Capture] Audio saved (${Math.round(fs.statSync(AUDIO_PATH).size/1024)}KB)`);
        }
      }
      
      resolve({ video: videoOk, audio: audioOk });
    });
  });
}

// Legacy wrapper for snapshot-only trigger
function captureSnapshot() {
  return captureAll().then(r => r.video);
}

// ============ Audio Transcription ============
const AUDIO_DIR = path.join(__dirname, 'audio');
const AUDIO_PATH = path.join(AUDIO_DIR, 'latest.wav');
if (!fs.existsSync(AUDIO_DIR)) fs.mkdirSync(AUDIO_DIR, { recursive: true });

let audioTranscripts = [];
const MAX_TRANSCRIPTS = 50;

function transcribeAudio() {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(AUDIO_PATH)) {
      return reject(new Error('No audio file'));
    }
    
    const audioBase64 = fs.readFileSync(AUDIO_PATH).toString('base64');
    const basePrompt = config.audio?.transcribePrompt || '请转写这段音频内容。如果有人说话，逐字转写；如果只有环境音，简述听到的声音（如电视声、水声、脚步声等）。用JSON格式回复：{"has_speech": true/false, "text": "转写或环境描述", "emotion": "neutral/happy/angry/sad/excited"}';
    const audioPrompt = basePrompt + AutomationEngine.promptFragment('audio');

    const payload = JSON.stringify({
      model: 'qwen-omni-turbo',
      input: {
        messages: [{
          role: 'user',
          content: [
            { audio: `data:audio/wav;base64,${audioBase64}` },
            { text: audioPrompt }
          ]
        }]
      }
    });
    
    const options = {
      hostname: 'dashscope.aliyuncs.com',
      path: '/api/v1/services/aigc/multimodal-generation/generation',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.ai.apiKey}`,
        'Content-Length': Buffer.byteLength(payload)
      }
    };
    
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          TokenUsage.recordFromResponse('qwen-omni-turbo', 'audio_transcribe', result);
          const content = result.output?.choices?.[0]?.message?.content?.[0]?.text || '';
          
          let parsed;
          try {
            const jsonMatch = content.match(/\{[\s\S]*\}/);
            if (jsonMatch) parsed = JSON.parse(jsonMatch[0]);
          } catch (e) {
            parsed = { has_speech: false, text: content, emotion: 'neutral' };
          }
          
          const transcript = {
            timestamp: Date.now(),
            time: new Date().toLocaleTimeString('zh-CN'),
            has_speech: parsed?.has_speech || false,
            text: parsed?.text || content || '无明显声音',
            emotion: parsed?.emotion || 'neutral'
          };
          
          audioTranscripts.push(transcript);
          if (audioTranscripts.length > MAX_TRANSCRIPTS) {
            audioTranscripts = audioTranscripts.slice(-MAX_TRANSCRIPTS);
          }
          
          const icon = transcript.has_speech ? '🗣️' : '🔊';
          console.log(`[Audio] ${icon} ${transcript.text.slice(0, 60)}`);
          // Fire audio-triggered automation rules
          if (parsed?.matched_rules) {
            AutomationEngine.handleMatches(parsed.matched_rules, transcript.text)
              .catch(e => console.error('[Automation] audio handle error:', e.message));
          }
          resolve(transcript);
        } catch (e) {
          reject(e);
        }
      });
    });
    
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ============ AI Vision Analysis ============
let lastAnalysis = { text: '等待首次分析...', timestamp: 0, suggestions: [] };

// ============ Persistent Home Memory ============
// A deliberately small, inspectable memory layer. It stores observations and
// user feedback locally, derives lightweight habits without extra LLM calls,
// and never executes a learned behaviour until it becomes an explicit rule.
const MEMORY_PATH = path.join(__dirname, 'memory.json');
const MemoryEngine = {
  data: { observations: [], feedback: [], preferences: [], createdAt: new Date().toISOString() },
  load() {
    try {
      if (fs.existsSync(MEMORY_PATH)) this.data = { ...this.data, ...JSON.parse(fs.readFileSync(MEMORY_PATH, 'utf8')) };
    } catch (e) { console.warn('[Memory] load failed:', e.message); }
  },
  save() {
    try { fs.writeFileSync(MEMORY_PATH, JSON.stringify(this.data, null, 2)); }
    catch (e) { console.warn('[Memory] save failed:', e.message); }
  },
  recordObservation(parsed) {
    if (!parsed?.scene) return;
    const entry = {
      id: `mem-${Date.now()}`,
      ts: Date.now(),
      scene: parsed.scene,
      occupied: parsed.occupied,
      brightness: parsed.brightness || '',
      status: Array.isArray(parsed.status) ? parsed.status.slice(0, 8) : []
    };
    this.data.observations.unshift(entry);
    this.data.observations = this.data.observations.slice(0, 300);
    this.save();
  },
  addFeedback(payload) {
    const item = {
      id: `fb-${Date.now()}`,
      ts: Date.now(),
      type: payload.type || 'note',
      text: String(payload.text || '').slice(0, 500),
      rating: Math.max(-1, Math.min(1, Number(payload.rating) || 0)),
      context: String(payload.context || '').slice(0, 500)
    };
    this.data.feedback.unshift(item);
    this.data.feedback = this.data.feedback.slice(0, 200);
    this.save();
    return item;
  },
  summary() {
    const recent = this.data.observations.slice(0, 80);
    const hours = new Array(24).fill(0);
    let occupied = 0;
    for (const o of recent) {
      hours[new Date(o.ts).getHours()]++;
      if (o.occupied === true) occupied++;
    }
    const activeHour = hours.indexOf(Math.max(...hours));
    const accepted = this.data.feedback.filter(x => x.rating > 0).length;
    const rejected = this.data.feedback.filter(x => x.rating < 0).length;
    return {
      observationCount: this.data.observations.length,
      feedbackCount: this.data.feedback.length,
      confidence: Math.min(96, 42 + Math.round(this.data.observations.length / 5) + accepted * 2),
      insights: [
        recent.length ? `家庭活动高峰约在 ${String(activeHour).padStart(2, '0')}:00` : '正在建立家庭活动基线',
        recent.length ? `近期有人场景占比 ${Math.round(occupied / recent.length * 100)}%` : '需要更多观察样本',
        `已收到 ${accepted} 次正向、${rejected} 次负向反馈`
      ],
      recent: this.data.observations.slice(0, 12),
      feedback: this.data.feedback.slice(0, 12)
    };
  }
};
MemoryEngine.load();

// ============ Automation Rules Engine ============
// Rules are evaluated piggyback on existing vision/audio analysis (zero extra LLM calls).
// Matched rules → cooldown check → dry-run guard → processNLCommand → HA execute → SSE broadcast.
const AutomationEngine = {
  rules: [],
  history: [], // { id, ruleId, name, ts, scene, dryRun, actions, success, reply }
  HISTORY_MAX: 100,
  sseClients: new Set(),
  lastTriggered: new Map(), // ruleId → timestamp

  load() {
    const auto = config.automation || {};
    this.rules = Array.isArray(auto.rules) ? auto.rules : [];
    this.enabled = auto.enabled !== false;
    this.defaultCooldown = auto.defaultCooldownSec || 300;
    console.log(`[Automation] Loaded ${this.rules.length} rules (enabled=${this.enabled})`);
  },

  save() {
    config.automation = config.automation || {};
    config.automation.rules = this.rules;
    config.automation.enabled = this.enabled;
    try {
      // Re-read disk to merge — prevents overwriting concurrent changes (e.g. token rotation)
      const onDisk = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
      onDisk.automation = config.automation;
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(onDisk, null, 2));
    } catch (e) {
      console.error('[Automation] Save failed:', e.message);
    }
  },

  rulesByTrigger(trigger) {
    if (!this.enabled) return [];
    return this.rules.filter(r => r.enabled && (r.trigger === trigger || r.trigger === 'both'));
  },

  // Build a prompt fragment listing rules to evaluate
  promptFragment(trigger) {
    const list = this.rulesByTrigger(trigger);
    if (list.length === 0) return '';
    const items = list.map((r, i) => `[${r.id}] ${r.condition}`).join('\n');
    return `\n\n请额外评估以下自动化规则条件是否满足（基于上述${trigger === 'vision' ? '画面' : '声音'}），并在JSON中加入字段 "matched_rules": [规则ID列表]。如果都不满足，返回空数组。\n规则列表：\n${items}`;
  },

  // Process matched rule IDs from analysis result
  async handleMatches(matchedIds, context) {
    if (!Array.isArray(matchedIds) || matchedIds.length === 0) return;
    const now = Date.now();
    for (const ruleId of matchedIds) {
      const rule = this.rules.find(r => r.id === ruleId);
      if (!rule || !rule.enabled) continue;
      const cooldownMs = (rule.cooldownSec || this.defaultCooldown) * 1000;
      const last = this.lastTriggered.get(ruleId) || 0;
      if (now - last < cooldownMs) {
        console.log(`[Automation] Rule "${rule.name}" matched but in cooldown (${Math.round((cooldownMs - (now - last)) / 1000)}s remaining)`);
        continue;
      }
      this.lastTriggered.set(ruleId, now);
      await this._fireRule(rule, context);
    }
  },

  async _fireRule(rule, context) {
    const entry = {
      id: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      ruleId: rule.id,
      name: rule.name,
      ts: Date.now(),
      time: new Date().toLocaleTimeString('zh-CN'),
      condition: rule.condition,
      action: rule.action,
      context: (context || '').slice(0, 200),
      dryRun: !!rule.dryRun,
      executed: [],
      reply: '',
      success: false
    };
    console.log(`[Automation] 🔔 Rule "${rule.name}" fired (dryRun=${rule.dryRun})`);
    this.broadcast({ type: 'fired', ...entry });

    try {
      // Broadcast intent shortcut — rule action is literal "speak X" via Xiaoai.
      // Bypass home parser entirely so phrases like "小爱说『离电视远一点』" don't
      // get rejected as "not a device control command".
      const broadcast = tryBroadcastIntent(rule.action);
      if (broadcast.matched) {
        console.log(`[Broadcast] (rule "${rule.name}") "${rule.action}" → speak "${broadcast.text}" (${broadcast.reason})`);
        entry.reply = broadcast.text;
        entry.executed.push({ ok: true, broadcast: true, text: broadcast.text });
        entry.success = true;
        if (rule.dryRun) {
          entry.reply = `[观察模式·未播报] ${broadcast.text}`;
        }
      } else {
        const parseResult = await processNLCommand(rule.action);
        entry.reply = parseResult.reply || '';
        if (rule.dryRun) {
          entry.success = true;
          entry.reply = `[观察模式·未执行] ${entry.reply}`;
        } else if (parseResult.understood && parseResult.actions?.length > 0) {
          const states = await haRequest('GET', '/api/states');
          for (const action of parseResult.actions) {
            const matches = states.filter(e => {
              const domain = e.entity_id.split('.')[0];
              const name = e.attributes?.friendly_name || '';
              return domain === action.domain && name.includes(action.target_keyword);
            });
            for (const entity of matches) {
              try {
                const recs = await executeServiceSafe(action, entity);
                for (const r of recs) entry.executed.push(r);
              } catch (e) { /* ignore */ }
            }
          }
          // Naturalize reply using LLM (grounded in actual records). Use rule
          // condition as the "user intent" hint so phrasing matches the trigger context.
          const ruleHint = rule.condition || rule.name || '自动化规则触发';
          entry.reply = (await naturalizeReply(entry.executed, ruleHint)) || entry.reply || '已执行';
          entry.success = true;
        } else {
          entry.reply = parseResult.reply || '未理解动作';
        }
      }
    } catch (e) {
      entry.reply = `执行失败: ${e.message}`;
    }

    this.history.unshift(entry);
    if (this.history.length > this.HISTORY_MAX) this.history.length = this.HISTORY_MAX;

    // Broadcast reply through Xiaoai speaker (skip dryRun observation runs to avoid noise)
    if (entry.success && !entry.dryRun && entry.reply) {
      speakReply(entry.reply, 'ruleTrigger');
    }

    this.broadcast({ type: 'completed', ...entry });
  },

  add(rule) {
    const r = {
      id: rule.id || `rule-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      name: rule.name || '未命名规则',
      trigger: ['vision', 'audio', 'both'].includes(rule.trigger) ? rule.trigger : 'vision',
      condition: rule.condition || '',
      action: rule.action || '',
      cooldownSec: Number(rule.cooldownSec) || this.defaultCooldown,
      enabled: rule.enabled !== false,
      dryRun: rule.dryRun !== false,  // default true (safe)
      createdAt: rule.createdAt || new Date().toISOString()
    };
    this.rules.push(r);
    this.save();
    return r;
  },

  update(id, patch) {
    const idx = this.rules.findIndex(r => r.id === id);
    if (idx === -1) return null;
    this.rules[idx] = { ...this.rules[idx], ...patch, id };
    this.save();
    return this.rules[idx];
  },

  remove(id) {
    const idx = this.rules.findIndex(r => r.id === id);
    if (idx === -1) return false;
    this.rules.splice(idx, 1);
    this.lastTriggered.delete(id);
    this.save();
    return true;
  },

  broadcast(event) {
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of this.sseClients) {
      try { res.write(payload); } catch (e) { this.sseClients.delete(res); }
    }
  }
};

function analyzeSnapshot() {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(SNAPSHOT_PATH)) {
      return reject(new Error('No snapshot available'));
    }

    const imageBase64 = fs.readFileSync(SNAPSHOT_PATH).toString('base64');
    const basePrompt = config.ai.analysisPrompt || `你是一个智能家居AI助手。请分析这张家庭摄像头画面，简洁描述：
1. 当前场景（房间、光线、人物活动）
2. 环境状态（亮度、是否有人、门窗状态）
3. 基于观察给出2-3条智能家居操作建议（如：调整灯光、开关窗帘、调温等）

输出格式要求：
- scene: 一句话描述场景
- status: 环境状态关键词（逗号分隔）
- suggestions: JSON数组，每项包含 action(操作描述) 和 domain(light/cover/climate/switch)
请用JSON格式回复。`;
    const prompt = basePrompt + AutomationEngine.promptFragment('vision');

    const payload = JSON.stringify({
      model: config.ai.model || 'qwen-vl-plus',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageBase64}` } }
        ]
      }],
      max_tokens: 500
    });

    const apiUrl = new URL(config.ai.baseUrl);
    const options = {
      hostname: apiUrl.hostname,
      port: apiUrl.port || 443,
      path: apiUrl.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.ai.apiKey}`,
        'Content-Length': Buffer.byteLength(payload)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          TokenUsage.recordFromResponse(config.ai.model || 'qwen-vl-plus', 'vision_analyze', result);
          const content = result.choices?.[0]?.message?.content || '';
          let parsed;
          try {
            const jsonMatch = content.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
              parsed = JSON.parse(jsonMatch[0]);
            }
          } catch (e) {
            parsed = null;
          }
          
          lastAnalysis = {
            text: content,
            parsed: parsed,
            timestamp: Date.now(),
            suggestions: parsed?.suggestions || []
          };
          MemoryEngine.recordObservation(parsed);
          console.log(`[AI] Analysis complete: ${parsed?.scene || content.slice(0, 50)}`);
          // Fire automation rules that matched
          if (parsed?.matched_rules) {
            AutomationEngine.handleMatches(parsed.matched_rules, parsed.scene || content.slice(0, 200))
              .catch(e => console.error('[Automation] vision handle error:', e.message));
          }
          resolve(lastAnalysis);
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ============ Home Assistant Proxy ============
function haRequest(method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const haUrl = new URL(config.homeAssistant.url);
    const options = {
      hostname: haUrl.hostname,
      port: haUrl.port || 8123,
      path: apiPath,
      method: method,
      headers: {
        'Authorization': `Bearer ${config.homeAssistant.token}`,
        'Content-Type': 'application/json'
      }
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          resolve(data);
        }
      });
    });

    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function haBinaryRequest(apiPath) {
  return new Promise((resolve, reject) => {
    const haUrl = new URL(config.homeAssistant.url);
    const req = http.request({
      hostname: haUrl.hostname,
      port: haUrl.port || 8123,
      path: apiPath,
      method: 'GET',
      headers: { 'Authorization': `Bearer ${config.homeAssistant.token}` },
      timeout: 5000
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`HA camera HTTP ${res.statusCode}`));
        resolve({ body: Buffer.concat(chunks), contentType: res.headers['content-type'] || 'image/jpeg' });
      });
    });
    req.on('timeout', () => req.destroy(new Error('HA camera timeout')));
    req.on('error', reject);
    req.end();
  });
}

function proxyHaCameraStream(req, res, entity) {
  const haUrl = new URL(config.homeAssistant.url);
  const upstream = http.request({
    hostname: haUrl.hostname,
    port: haUrl.port || 8123,
    path: `/api/camera_proxy_stream/${encodeURIComponent(entity)}`,
    method: 'GET',
    headers: { 'Authorization': `Bearer ${config.homeAssistant.token}` },
    timeout: 10000
  }, cameraRes => {
    if (cameraRes.statusCode < 200 || cameraRes.statusCode >= 300) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `HA camera stream HTTP ${cameraRes.statusCode}` }));
      cameraRes.resume();
      return;
    }
    res.writeHead(200, {
      'Content-Type': cameraRes.headers['content-type'] || 'multipart/x-mixed-replace',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'X-Accel-Buffering': 'no',
      'Connection': 'close'
    });
    try { res.flushHeaders(); } catch (e) {}
    cameraRes.pipe(res);
    cameraRes.on('error', () => { try { res.end(); } catch (e) {} });
  });
  const close = () => { try { upstream.destroy(); } catch (e) {} };
  req.on('close', close);
  upstream.on('timeout', () => upstream.destroy(new Error('HA camera stream timeout')));
  upstream.on('error', e => {
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
    try { res.end(JSON.stringify({ error: e.message })); } catch (_) {}
  });
  upstream.end();
}

// ============ Natural Language Command ============
function processNLCommand(command) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model: config.ai.commandModel || 'qwen-plus',
      messages: [{
        role: 'system',
        content: `你是智能家居控制助手。用户会给你自然语言指令（包括带情绪/暗示的，如"太热""有点暗"），你需要将其转化为 Home Assistant API 调用。
可用设备域：light, cover, climate, switch, fan, vacuum
可用服务：turn_on, turn_off, open_cover, close_cover, set_temperature, set_hvac_mode

【关键规则 — 隐含意图与状态依赖】
1. climate（空调）特殊处理：
   - 用户说"太热/热/降温"→ 必须输出两个 actions：先 turn_on(hvac_mode='cool', temperature=24)，再可选 set_temperature(temperature=24)。仅 set_temperature 不会启动空调！
   - 用户说"太冷/冷/取暖/暖和点"→ turn_on(hvac_mode='heat', temperature=26)
   - 用户说"闷/通风"→ turn_on(hvac_mode='fan_only')
   - 用户说"调到 X 度"且未提开关 → turn_on(hvac_mode='cool', temperature=X)（默认制冷模式）
   - 仅当用户明说"关空调"才用 turn_off
2. light：用户说"暗/看不清/亮一点"→ turn_on；"刺眼/太亮"→ turn_off 或 turn_on(brightness 调低)
3. cover：用户说"开窗帘/拉开"→ open_cover；"关上/拉上"→ close_cover

请严格用 JSON 回复：
{
  "understood": bool,
  "actions": [{"domain","service","target_keyword","params"}],
  "reply": "对用户的简短自然语言回复（≤30字），口语化"
}

target_keyword 是设备名称中文关键词（如"客厅"），用于匹配 entity_id 的 friendly_name。
reply 要符合 actions 实际效果——如果你输出了 turn_on(cool)+set_temperature，就说"已为您打开客厅空调制冷至24度"。不要说没做的事。`
      }, {
        role: 'user',
        content: command
      }],
      max_tokens: 400
    });

    const apiUrl = new URL(config.ai.baseUrl);
    const options = {
      hostname: apiUrl.hostname,
      port: apiUrl.port || 443,
      path: apiUrl.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.ai.apiKey}`,
        'Content-Length': Buffer.byteLength(payload)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          TokenUsage.recordFromResponse(config.ai.commandModel || 'qwen-plus', 'nl_command', result);
          const content = result.choices?.[0]?.message?.content || '';
          const jsonMatch = content.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            resolve(JSON.parse(jsonMatch[0]));
          } else {
            resolve({ understood: false, reply: content, actions: [] });
          }
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ============ Service execution with climate guard ============
// Wraps haRequest service calls with safety net for climate devices.
// Reality discovered: qdhkl (海尔) integration's `climate.turn_on` returns 400
// when given hvac_mode/temperature params; the working path is two separate
// calls: `set_hvac_mode` then optional `set_temperature`. We normalize all
// climate "start cooling/heating" actions through this two-step path.

// Fuzzy keyword → entity friendly_name matching.
// Handles cases like keyword="电风扇" vs name="米家风扇 风扇" by:
//  1. exact substring (original behavior)
//  2. strip common noise prefixes ("电"/"小"/"大"/"个"/"那个"/"这个")
//  3. 2-gram fallback — any 2-char window of keyword found in name
function fuzzyKeywordMatch(name, keyword) {
  if (!keyword || !name) return false;
  if (name.includes(keyword)) return true;
  const stripped = keyword.replace(/^(电|小|大|个|那个|这个|这|那)/, '');
  if (stripped && stripped !== keyword && name.includes(stripped)) return true;
  if (keyword.length >= 2) {
    for (let i = 0; i <= keyword.length - 2; i++) {
      const bigram = keyword.slice(i, i + 2);
      if (name.includes(bigram)) return true;
    }
  }
  return false;
}

async function executeServiceSafe(action, entity) {
  const out = [];
  const domain = action.domain;
  const service = action.service;
  const params = action.params || {};
  const friendly = entity.attributes?.friendly_name || entity.entity_id;

  // === Idempotency gate: skip if the entity is already in the desired state ===
  const skipDecision = shouldSkipAction(action, entity);
  if (skipDecision.skip) {
    console.log(`[Action] ⏭ Skip ${entity.entity_id} → ${domain}.${service}: ${skipDecision.reason}`);
    out.push({
      skipped: true,
      entity_id: entity.entity_id,
      friendly_name: friendly,
      domain,
      service,
      reason: skipDecision.reason,
      prevState: entity.state
    });
    return out;
  }

  if (domain === 'climate') {
    const isOff = entity.state === 'off' || entity.state === 'unavailable';
    const wantedMode = params.hvac_mode;
    const wantedTemp = params.temperature;
    const currentT = entity.attributes?.current_temperature;

    // Decide effective mode (explicit > inferred from temp delta > cool)
    let mode = wantedMode;
    if (!mode && (service === 'set_temperature' || service === 'turn_on')) {
      if (isOff) {
        if (typeof wantedTemp === 'number' && typeof currentT === 'number') {
          mode = (wantedTemp < currentT) ? 'cool' : 'heat';
        } else {
          mode = 'cool';
        }
      }
    }

    // Path A: turn_off → direct call
    if (service === 'turn_off') {
      try {
        await haRequest('POST', '/api/services/climate/turn_off', { entity_id: entity.entity_id });
        out.push({ ok: true, entity_id: entity.entity_id, friendly_name: friendly, domain, service: 'turn_off', prevState: entity.state });
      } catch (e) {
        console.error('[Action] climate.turn_off failed:', e.message);
        out.push({ ok: false, entity_id: entity.entity_id, friendly_name: friendly, domain, service: 'turn_off', error: e.message });
      }
      return out;
    }

    // Path B: turn_on / set_temperature / set_hvac_mode → 2-step (set_hvac_mode + optional set_temperature)
    if (mode) {
      try {
        await haRequest('POST', '/api/services/climate/set_hvac_mode', {
          entity_id: entity.entity_id,
          hvac_mode: mode
        });
        out.push({ ok: true, entity_id: entity.entity_id, friendly_name: friendly, domain, service: 'set_hvac_mode', detail: mode, prevState: entity.state });
        console.log(`[Action] climate ${entity.entity_id} → set_hvac_mode=${mode}`);
      } catch (e) {
        console.error('[Action] climate.set_hvac_mode failed:', e.message);
        out.push({ ok: false, entity_id: entity.entity_id, friendly_name: friendly, domain, service: 'set_hvac_mode', error: e.message });
      }
    }
    if (typeof wantedTemp === 'number') {
      try {
        await haRequest('POST', '/api/services/climate/set_temperature', {
          entity_id: entity.entity_id,
          temperature: wantedTemp
        });
        out.push({ ok: true, entity_id: entity.entity_id, friendly_name: friendly, domain, service: 'set_temperature', detail: `${wantedTemp}°`, prevState: entity.state });
        console.log(`[Action] climate ${entity.entity_id} → set_temperature=${wantedTemp}°`);
      } catch (e) {
        console.error('[Action] climate.set_temperature failed:', e.message);
        out.push({ ok: false, entity_id: entity.entity_id, friendly_name: friendly, domain, service: 'set_temperature', error: e.message });
      }
    }
    // Optional fan_mode passthrough
    if (params.fan_mode) {
      try {
        await haRequest('POST', '/api/services/climate/set_fan_mode', {
          entity_id: entity.entity_id,
          fan_mode: params.fan_mode
        });
        out.push({ ok: true, entity_id: entity.entity_id, friendly_name: friendly, domain, service: 'set_fan_mode', detail: params.fan_mode, prevState: entity.state });
      } catch (e) {
        console.error('[Action] climate.set_fan_mode failed:', e.message);
        out.push({ ok: false, entity_id: entity.entity_id, friendly_name: friendly, domain, service: 'set_fan_mode', error: e.message });
      }
    }
    return out;
  }

  // Non-climate domains: direct call
  try {
    await haRequest('POST', `/api/services/${domain}/${service}`, {
      entity_id: entity.entity_id,
      ...params
    });
    const detail = (params.brightness != null) ? `亮度${Math.round((params.brightness / 255) * 100)}%`
                : (params.brightness_pct != null) ? `亮度${params.brightness_pct}%`
                : (params.position != null) ? `${params.position}%`
                : (params.color_temp_kelvin != null) ? `${params.color_temp_kelvin}K`
                : '';
    out.push({ ok: true, entity_id: entity.entity_id, friendly_name: friendly, domain, service, detail, prevState: entity.state });
  } catch (e) {
    console.error(`[Action] ${domain}.${service} on ${entity.entity_id} failed:`, e.message);
    out.push({ ok: false, entity_id: entity.entity_id, friendly_name: friendly, domain, service, error: e.message });
  }
  return out;
}

// === Idempotency: predict whether an action would be a no-op given current state ===
// Returns {skip: bool, reason: string}. Used by executeServiceSafe to short-circuit
// unnecessary HA service calls (e.g., "关闭所有空调" when most are already off).
function shouldSkipAction(action, entity) {
  const domain = action.domain;
  const service = action.service;
  const params = action.params || {};
  const state = entity.state;
  const attrs = entity.attributes || {};

  // Generic on/off domains: light / switch / fan / input_boolean
  if (['switch', 'input_boolean'].includes(domain)) {
    if (service === 'turn_off' && (state === 'off' || state === 'unavailable')) return { skip: true, reason: '已关闭' };
    if (service === 'turn_on' && state === 'on') return { skip: true, reason: '已打开' };
  }
  if (domain === 'fan') {
    if (service === 'turn_off' && (state === 'off' || state === 'unavailable')) return { skip: true, reason: '已关闭' };
    if (service === 'turn_on' && state === 'on') {
      // if user wants to change percentage/preset, do not skip
      if (params.percentage != null || params.preset_mode != null) return { skip: false };
      return { skip: true, reason: '已打开' };
    }
    if (service === 'set_percentage' && typeof params.percentage === 'number' && attrs.percentage === params.percentage)
      return { skip: true, reason: `档位已为 ${params.percentage}%` };
    if (service === 'set_preset_mode' && params.preset_mode != null && attrs.preset_mode === params.preset_mode)
      return { skip: true, reason: `已是「${params.preset_mode}」` };
  }
  if (domain === 'light') {
    if (service === 'turn_off' && (state === 'off' || state === 'unavailable')) return { skip: true, reason: '已关闭' };
    if (service === 'turn_on' && state === 'on') {
      // changing brightness / color → not idempotent
      if (params.brightness != null || params.brightness_pct != null ||
          params.color_temp_kelvin != null || params.color_temp != null ||
          params.rgb_color != null || params.hs_color != null || params.kelvin != null) {
        return { skip: false };
      }
      return { skip: true, reason: '已打开' };
    }
  }

  // Climate: idempotent on turn_off when off; same hvac_mode; same target temp + same mode
  if (domain === 'climate') {
    if (service === 'turn_off' && (state === 'off' || state === 'unavailable')) return { skip: true, reason: '已关闭' };
    if (service === 'set_hvac_mode' && params.hvac_mode != null && state === params.hvac_mode)
      return { skip: true, reason: `已是 ${params.hvac_mode} 模式` };
    if (service === 'set_temperature' && typeof params.temperature === 'number' &&
        typeof attrs.temperature === 'number' && Math.abs(attrs.temperature - params.temperature) < 0.5 &&
        state !== 'off' && (params.hvac_mode == null || state === params.hvac_mode))
      return { skip: true, reason: `温度已为 ${params.temperature}°` };
    if (service === 'set_fan_mode' && params.fan_mode != null && attrs.fan_mode === params.fan_mode)
      return { skip: true, reason: `风速已为 ${params.fan_mode}` };
    // Composite turn_on → if already on in same mode and (no temp specified or temp matches), skip
    if (service === 'turn_on' && state !== 'off' && state !== 'unavailable') {
      const modeMatches = params.hvac_mode == null || state === params.hvac_mode;
      const tempMatches = params.temperature == null ||
        (typeof attrs.temperature === 'number' && Math.abs(attrs.temperature - params.temperature) < 0.5);
      const fanMatches = params.fan_mode == null || attrs.fan_mode === params.fan_mode;
      if (modeMatches && tempMatches && fanMatches) return { skip: true, reason: '已是该状态' };
    }
  }

  // Cover (curtains/blinds): position-based idempotency
  if (domain === 'cover') {
    const pos = attrs.current_position;
    if (service === 'open_cover' && pos === 100) return { skip: true, reason: '已完全打开' };
    if (service === 'close_cover' && pos === 0) return { skip: true, reason: '已完全关闭' };
    if (service === 'stop_cover' && state !== 'opening' && state !== 'closing') return { skip: true, reason: '未在运动' };
    if (service === 'set_cover_position' && typeof params.position === 'number' &&
        typeof pos === 'number' && Math.abs(pos - params.position) < 5)
      return { skip: true, reason: `位置已为 ${params.position}%` };
  }

  // Media player
  if (domain === 'media_player') {
    if (service === 'turn_off' && ['off', 'unavailable', 'idle', 'standby'].includes(state))
      return { skip: true, reason: '已关闭' };
    if (service === 'media_pause' && state === 'paused') return { skip: true, reason: '已暂停' };
    if (service === 'media_play' && state === 'playing') return { skip: true, reason: '已在播放' };
  }

  return { skip: false };
}

// Build a natural-language reply from the executed[] array. Fact-based, no LLM.
// Examples:
//   - "已关闭主卧空调、客厅空调（餐厅空调已关闭）"
//   - "已打开客厅吸顶灯（其他 3 盏灯保持原状态）"
//   - "餐厅灯已是打开状态，未做更改"
function summarizeExecuted(records) {
  if (!Array.isArray(records) || !records.length) return '';
  const ok = records.filter(r => r.ok);
  const skipped = records.filter(r => r.skipped);
  const failed = records.filter(r => r.ok === false);

  // Collapse multi-step climate ops (set_hvac_mode + set_temperature on same entity) into one entry per device
  const dedupe = (arr) => {
    const seen = new Set();
    const result = [];
    for (const r of arr) {
      if (seen.has(r.entity_id)) continue;
      seen.add(r.entity_id);
      result.push(r);
    }
    return result;
  };

  // English→Chinese mode mappings (HA hvac_mode/fan_mode normalized values)
  const hvacZh = { heat: '制热', cool: '制冷', auto: '自动', dry: '除湿', fan_only: '送风', heat_cool: '自动', off: '关闭' };
  const fanZh = { auto: '自动', low: '低风', medium: '中风', high: '高风' };
  const zhDetail = (val, map) => {
    const raw = String(val || '').trim();
    return map[raw.toLowerCase()] || raw;
  };
  const verbOf = (r) => {
    if (r.service === 'turn_on' || r.service === 'open_cover') return '打开';
    if (r.service === 'turn_off' || r.service === 'close_cover') return '关闭';
    if (r.service === 'set_temperature') return `调到${r.detail || ''}`;
    if (r.service === 'set_hvac_mode') return `切到${zhDetail(r.detail, hvacZh)}`;
    if (r.service === 'set_fan_mode') return `调到${zhDetail(r.detail, fanZh)}`;
    if (r.service === 'set_cover_position') return `调到${r.detail || ''}`;
    return r.service;
  };

  const nameList = (arr, max = 3) => {
    const ns = arr.map(r => r.friendly_name || r.entity_id);
    if (ns.length <= max) return ns.join('、');
    return ns.slice(0, max).join('、') + ` 等 ${ns.length} 个`;
  };

  const parts = [];
  if (ok.length) {
    // Group by verb
    const okDedup = dedupe(ok);
    const byVerb = new Map();
    for (const r of okDedup) {
      const v = verbOf(r);
      if (!byVerb.has(v)) byVerb.set(v, []);
      byVerb.get(v).push(r);
    }
    for (const [verb, items] of byVerb) {
      parts.push(items.length === 1 ? `${nameList(items)}已${verb}` : `已${verb}${nameList(items)}`);
    }
  }
  if (skipped.length) {
    const sd = dedupe(skipped);
    parts.push(`${nameList(sd)} ${sd[0].reason || '保持原状'}`);
  }
  if (failed.length) {
    const fd = dedupe(failed);
    parts.push(`${nameList(fd)} 执行失败`);
  }

  let text = parts.join('；');
  // Trim to <=60 chars for spoken output through Xiaoai (短播报体验)
  if (text.length > 60) text = text.slice(0, 58) + '…';
  return text;
}

// Natural-language reply: takes records + user's original query, asks an LLM to
// produce a warm, conversational Chinese reply grounded in the actual records
// (no hallucination). Falls back to the structured template on any failure.
function naturalizeReply(records, userQuery) {
  return new Promise((resolve) => {
    const skeleton = summarizeExecuted(records) || '';
    const trySkeleton = () => resolve(skeleton);

    // Disable cases — return template directly
    if (!skeleton) return trySkeleton();
    if (!userQuery || !String(userQuery).trim()) return trySkeleton();
    // State-critical confirmations must be deterministic. An LLM must never
    // turn "空调已关闭" into an invented comfort claim such as "会凉快下来".
    const hasClimate = (records || []).some(r => r.domain === 'climate');
    const hasOffAction = (records || []).some(r => ['turn_off', 'close_cover'].includes(r.service));
    if (hasClimate || hasOffAction) return trySkeleton();
    const naturalCfg = config.voice?.naturalReply || {};
    if (naturalCfg.enabled === false) return trySkeleton();
    if (!config.ai?.apiKey || !config.ai?.baseUrl) return trySkeleton();

    const okList = (records || []).filter(r => r.ok);
    const skippedList = (records || []).filter(r => r.skipped);
    const failedList = (records || []).filter(r => r.ok === false);

    // Compact records JSON for LLM prompt
    const factsJSON = JSON.stringify({
      ok: okList.map(r => ({ name: r.friendly_name || r.entity_id, action: r.service, detail: r.detail || null })),
      skipped: skippedList.map(r => ({ name: r.friendly_name || r.entity_id, reason: r.reason || '已是该状态' })),
      failed: failedList.map(r => ({ name: r.friendly_name || r.entity_id, error: r.error || '未知错误' })),
      template: skeleton
    });

    const model = naturalCfg.model || 'qwen-turbo';
    const maxTokens = naturalCfg.maxTokens || 60;
    const timeoutMs = naturalCfg.timeoutMs || 4000;
    const systemPrompt = naturalCfg.systemPrompt ||
      '你是温暖贴心的家庭助手王管家。根据用户说的话和实际执行的家电操作，' +
      '用一句口语化中文回应用户（不超过30字）。要点：' +
      '1)如果用户表达情绪(冷/热/暗/吵)要轻柔照应；' +
      '2)绝不出现 heat/cool/light/switch 等英文，用 制热/制冷/灯/开关；' +
      '3)只能描述实际执行的设备，不能编造；' +
      '4)不要加"好的、收到、马上"开头；' +
      '5)直接说事实+情感，例如"主卧空调已为您打开制热，很快就会暖和起来"。';
    const userMsg = `用户说: "${String(userQuery).slice(0, 80)}"\n实际执行结果(JSON):\n${factsJSON}\n请用一句话自然回复用户。`;

    const payload = JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMsg }
      ],
      max_tokens: maxTokens,
      temperature: 0.6
    });

    const apiUrl = new URL(config.ai.baseUrl);
    const options = {
      hostname: apiUrl.hostname,
      port: apiUrl.port || 443,
      path: apiUrl.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.ai.apiKey}`,
        'Content-Length': Buffer.byteLength(payload)
      },
      timeout: timeoutMs
    };

    let settled = false;
    const finish = (out) => { if (!settled) { settled = true; resolve(out); } };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          try { TokenUsage.recordFromResponse(model, 'natural_reply', parsed); } catch {}
          let reply = parsed.choices?.[0]?.message?.content || '';
          reply = String(reply).replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
          // Strip any quote wrapping
          reply = reply.replace(/^["「『""'']+|["」』""'']+$/g, '').trim();
          if (!reply || reply.length < 2) {
            console.warn('[NaturalReply] empty LLM, using template skeleton');
            return finish(skeleton);
          }
          // Safety guard: must not contain raw English HVAC tokens (defensive)
          if (/\b(heat|cool|fan_only|dry|auto)\b/i.test(reply)) {
            console.warn('[NaturalReply] LLM emitted English token, using template');
            return finish(skeleton);
          }
          if (reply.length > 60) reply = reply.slice(0, 58) + '…';
          console.log(`[NaturalReply] "${userQuery}" → "${reply}" (skeleton: "${skeleton}")`);
          finish(reply);
        } catch (e) {
          console.warn('[NaturalReply] parse error, using template:', e.message);
          finish(skeleton);
        }
      });
    });
    req.on('error', (e) => {
      console.warn('[NaturalReply] request error, using template:', e.message);
      finish(skeleton);
    });
    req.on('timeout', () => {
      console.warn('[NaturalReply] timeout, using template');
      try { req.destroy(); } catch {}
      finish(skeleton);
    });
    req.write(payload);
    req.end();
  });
}

// ============ Environment snapshot (temp / humidity / illuminance / occupancy) ============
// Computes a normalized env metrics object from HA states + maintains a rolling history
// for sparkline visualization on the dashboard hero bar.
const envHistory = []; // [{ ts, temp, humidity, illum, occupancy, climateRunning }]
const ENV_HISTORY_MAX = 60; // 60 samples × 30s = 30 minutes of history
let lastEnvSnapshot = null;

async function computeEnvSnapshot() {
  try {
    const states = await haRequest('GET', '/api/states');
    if (!Array.isArray(states)) return null;

    // --- Temperature: prefer climate.current_temperature (one per room) ---
    const roomTemps = []; // { room, temp }
    const climateRunning = []; // entity_ids that are not 'off'
    for (const s of states) {
      if (!s.entity_id || !s.entity_id.startsWith('climate.')) continue;
      const a = s.attributes || {};
      const t = a.current_temperature;
      if (typeof t === 'number' && !isNaN(t)) {
        roomTemps.push({ room: a.friendly_name || s.entity_id, temp: t });
      }
      if (s.state && s.state !== 'off' && s.state !== 'unavailable') {
        climateRunning.push({ entity_id: s.entity_id, name: a.friendly_name, mode: s.state });
      }
    }
    const tempAvg = roomTemps.length ? roomTemps.reduce((a, b) => a + b.temp, 0) / roomTemps.length : null;
    const tempMin = roomTemps.length ? Math.min(...roomTemps.map(r => r.temp)) : null;
    const tempMax = roomTemps.length ? Math.max(...roomTemps.map(r => r.temp)) : null;

    // --- Humidity: avg of all device_class=humidity sensors ---
    const humidities = [];
    for (const s of states) {
      const a = s.attributes || {};
      if (a.device_class !== 'humidity') continue;
      if (s.state === 'unknown' || s.state === 'unavailable') continue;
      const v = parseFloat(s.state);
      if (!isNaN(v)) humidities.push(v);
    }
    const humAvg = humidities.length ? humidities.reduce((a, b) => a + b, 0) / humidities.length : null;

    // --- Illuminance: max + per-room from human-presence/illumination sensors ---
    const illumPoints = []; // { name, lx }
    for (const s of states) {
      const a = s.attributes || {};
      if (a.device_class !== 'illuminance') continue;
      if (s.state === 'unknown' || s.state === 'unavailable') continue;
      const v = parseFloat(s.state);
      if (!isNaN(v)) illumPoints.push({ name: a.friendly_name || s.entity_id, lx: v });
    }
    const illumMax = illumPoints.length ? Math.max(...illumPoints.map(p => p.lx)) : null;
    const illumAvg = illumPoints.length ? illumPoints.reduce((a, b) => a + b.lx, 0) / illumPoints.length : null;

    // --- Occupancy: count binary_sensor + xiaomi sensor.*occupancy_status* ---
    let occupancyCount = 0;
    let totalPresenceSensors = 0;
    for (const s of states) {
      const a = s.attributes || {};
      // (1) Standard binary_sensor with motion/occupancy/presence device_class
      if (s.entity_id.startsWith('binary_sensor.')) {
        const cls = a.device_class;
        if (cls === 'occupancy' || cls === 'motion' || cls === 'presence') {
          totalPresenceSensors++;
          if (s.state === 'on') occupancyCount++;
          continue;
        }
      }
      // (2) Xiaomi people sensor: sensor.*occupancy_status_p_* with state "有人"/"无人"/"No One"/"Has One"
      if (s.entity_id.startsWith('sensor.') && /occupancy_status/i.test(s.entity_id)) {
        if (s.state === 'unknown' || s.state === 'unavailable') continue;
        totalPresenceSensors++;
        const st = String(s.state || '');
        if (st === '有人' || /has\s*one/i.test(st) || (st !== '无人' && st !== 'No One' && st !== '0')) {
          if (st === '有人' || /has\s*one/i.test(st)) occupancyCount++;
        }
      }
    }

    // --- Online / total devices (rough count) ---
    let totalDevs = 0, onlineDevs = 0;
    for (const s of states) {
      const dom = s.entity_id.split('.')[0];
      if (['light','switch','climate','cover','fan','vacuum','media_player'].includes(dom)) {
        totalDevs++;
        if (s.state && !['unavailable','unknown','off'].includes(s.state)) onlineDevs++;
      }
    }

    return {
      ts: Date.now(),
      temp: {
        avg: tempAvg !== null ? Math.round(tempAvg * 10) / 10 : null,
        min: tempMin,
        max: tempMax,
        rooms: roomTemps
      },
      humidity: {
        avg: humAvg !== null ? Math.round(humAvg) : null,
        samples: humidities.length
      },
      illuminance: {
        max: illumMax !== null ? Math.round(illumMax) : null,
        avg: illumAvg !== null ? Math.round(illumAvg) : null,
        points: illumPoints
      },
      occupancy: {
        active: occupancyCount,
        total: totalPresenceSensors
      },
      climate: {
        runningCount: climateRunning.length,
        running: climateRunning
      },
      devices: {
        online: onlineDevs,
        total: totalDevs
      }
    };
  } catch (e) {
    console.error('[Env] computeEnvSnapshot failed:', e.message);
    return null;
  }
}

async function sampleEnvHistory() {
  const snap = await computeEnvSnapshot();
  if (!snap) return;
  lastEnvSnapshot = snap;
  envHistory.push({
    ts: snap.ts,
    temp: snap.temp.avg,
    humidity: snap.humidity.avg,
    illum: snap.illuminance.max,
    occupancy: snap.occupancy.active,
    climateRunning: snap.climate.runningCount
  });
  while (envHistory.length > ENV_HISTORY_MAX) envHistory.shift();
}

// ============ QA chit-chat fallback (general assistant via LLM) ============
// Triggered when wake-word hit but command is not home-control. Uses cheap qwen-turbo by default.
// Returns { ok, reply, model, source: 'llm' | 'fallback' | 'disabled' }.
async function answerLocalHomeQuestion(command) {
  const text = String(command || '').trim();
  if (!text) return null;
  const weatherZh = { clear: '晴', sunny: '晴', partlycloudy: '多云间晴', cloudy: '多云', fog: '有雾', rainy: '有雨', pouring: '大雨', lightning: '雷雨', lightning_rainy: '雷阵雨', snowy: '有雪', snowy_rainy: '雨夹雪', windy: '有风', windy_variant: '大风', hail: '冰雹', exceptional: '异常天气' };
  try {
    if (/(温度|几度|多少度)/.test(text)) {
      const states = await haRequest('GET', '/api/states');
      const room = (config.rooms || []).map(r => r.name).find(name => text.includes(name)) || '';
      const values = [];
      for (const entity of states) {
        const name = entity.attributes?.friendly_name || '';
        if (room && !name.includes(room)) continue;
        const domain = entity.entity_id?.split('.')[0];
        const current = domain === 'climate' ? Number(entity.attributes?.current_temperature) : Number(entity.state);
        const isTemperature = domain === 'climate' || entity.attributes?.device_class === 'temperature' || entity.attributes?.unit_of_measurement === '°C' || /温度/.test(name);
        if (isTemperature && Number.isFinite(current) && current > -30 && current < 70) values.push({ name, value: current, priority: domain === 'climate' ? 2 : 1 });
      }
      values.sort((a, b) => b.priority - a.priority);
      if (values.length) {
        const value = Math.round(values[0].value * 10) / 10;
        return { ok: true, reply: `${room || '家里'}当前温度是${value}度。`, source: 'home_assistant' };
      }
      return { ok: false, reply: `暂时没有读取到${room || '家里'}的温度传感器。`, source: 'home_assistant' };
    }
    if (/(天气|下雨|气温|预报)/.test(text)) {
      const states = await haRequest('GET', '/api/states');
      const weather = states.find(e => e.entity_id?.startsWith('weather.'));
      if (!weather) return { ok: false, reply: '家庭中枢还没有配置天气服务。', source: 'home_assistant' };
      const tomorrow = /(明天|明日)/.test(text);
      if (tomorrow) {
        try {
          const response = await haRequest('POST', '/api/services/weather/get_forecasts?return_response', { entity_id: weather.entity_id, type: 'daily' });
          const forecasts = response?.service_response?.[weather.entity_id]?.forecast || response?.[weather.entity_id]?.forecast || [];
          const tomorrowDate = new Date(Date.now() + 86400000).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
          const f = forecasts.find(x => String(x.datetime || '').startsWith(tomorrowDate)) || forecasts[1] || forecasts[0];
          if (f) {
            const condition = weatherZh[f.condition] || f.condition || '天气情况未知';
            const hi = Number.isFinite(Number(f.temperature)) ? `，最高${Math.round(Number(f.temperature))}度` : '';
            const lo = Number.isFinite(Number(f.templow)) ? `，最低${Math.round(Number(f.templow))}度` : '';
            const rain = Number(f.precipitation_probability) > 0 ? `，降雨概率${Math.round(Number(f.precipitation_probability))}%` : '';
            return { ok: true, reply: `明天${condition}${hi}${lo}${rain}。`, source: 'home_assistant' };
          }
        } catch (e) { console.error('[QA] weather forecast failed:', e.message); }
      }
      const a = weather.attributes || {}, condition = weatherZh[weather.state] || weather.state || '天气情况未知';
      return { ok: true, reply: `现在${condition}，${Math.round(Number(a.temperature))}度，湿度${Math.round(Number(a.humidity))}%。`, source: 'home_assistant' };
    }
  } catch (e) {
    console.error('[QA] local home question failed:', e.message);
  }
  return null;
}
function chitchatLLM(command) {
  return new Promise((resolve) => {
    const qa = config.voice?.qa || {};
    if (qa.enabled === false) return resolve({ ok: false, reply: '', source: 'disabled' });
    if (!command || !String(command).trim()) return resolve({ ok: false, reply: '', source: 'disabled' });

    const model = qa.model || 'qwen-turbo';
    const maxTokens = qa.maxTokens || 80;
    const timeoutMs = qa.timeoutMs || 8000;
    const fallbackText = qa.fallbackText || '抱歉，这个问题我暂时帮不了。';
    const systemPrompt = qa.systemPrompt || '你是家庭语音助手，请用一句话简短回答（≤30字）。不知道就说"这个我帮不了"。';

    const payload = JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: String(command) }
      ],
      max_tokens: maxTokens,
      temperature: 0.7
    });

    const apiUrl = new URL(config.ai.baseUrl);
    const options = {
      hostname: apiUrl.hostname,
      port: apiUrl.port || 443,
      path: apiUrl.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.ai.apiKey}`,
        'Content-Length': Buffer.byteLength(payload)
      },
      timeout: timeoutMs
    };

    let settled = false;
    const finish = (out) => { if (!settled) { settled = true; resolve(out); } };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          try { TokenUsage.recordFromResponse(model, 'voice_qa', parsed); } catch {}
          let reply = parsed.choices?.[0]?.message?.content || '';
          reply = String(reply).replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
          if (!reply) {
            console.error('[QA] empty LLM reply, using fallback. raw:', data.slice(0, 200));
            return finish({ ok: false, reply: fallbackText, model, source: 'fallback' });
          }
          console.log(`[QA] "${command}" → "${reply}"`);
          finish({ ok: true, reply, model, source: 'llm' });
        } catch (e) {
          console.error('[QA] parse error:', e.message, 'raw:', data.slice(0, 200));
          finish({ ok: false, reply: fallbackText, model, source: 'fallback' });
        }
      });
    });
    req.on('error', (e) => {
      console.error('[QA] request error:', e.message);
      finish({ ok: false, reply: fallbackText, model, source: 'fallback' });
    });
    req.on('timeout', () => {
      console.error('[QA] timeout');
      try { req.destroy(); } catch {}
      finish({ ok: false, reply: fallbackText, model, source: 'fallback' });
    });
    req.write(payload);
    req.end();
  });
}

// ============ Voice Control Pipeline ============
// Continuous PCM capture → VAD → utterance → ASR → wake-word match → /api/command

// One persistent RTSP ingest fans out video, audio and periodic AI snapshots.
// This avoids both the old video/voice mutex and the latency of HA transcoding.
const MediaHub = {
  ff: null,
  videoClients: new Set(),
  audioSubscribers: new Set(),
  jpegBuffer: Buffer.alloc(0),
  restartTimer: null,
  lastSnapshotPublish: 0,
  videoBytes: 0,
  audioBytes: 0,
  boundary: 'novahubframe',

  ensureStarted() {
    if (this.ff && !this.ff.killed && this.ff.exitCode === null) return;
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null; }
    const width = config.camera.streamWidth || 1280;
    const fps = Math.max(8, Math.min(config.camera.streamFps || 15, 20));
    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-rtsp_transport', 'udp',
      '-i', config.camera.rtspUrl,
      '-map', '0:v:0', '-an',
      '-vf', `scale=${width}:-2:in_range=tv:out_range=pc,fps=${fps}:round=zero,format=yuvj420p`,
      '-q:v', '7', '-threads', '2', '-fps_mode', 'cfr', '-flush_packets', '1',
      '-f', 'mpjpeg', '-boundary_tag', this.boundary, 'pipe:1'
    ];
    this.jpegBuffer = Buffer.alloc(0);
    this.ff = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const pid = this.ff.pid;
    console.log(`[MediaHub] ✅ single RTSP ingest pid=${pid}, video=${width}p@${fps}fps + audio=16kHz`);
    this.ff.stdout.on('data', chunk => {
      this.videoBytes += chunk.length;
      for (const client of this.videoClients) {
        try { client.write(chunk); } catch (e) { this.videoClients.delete(client); }
      }
      this.jpegBuffer = Buffer.concat([this.jpegBuffer, chunk]);
      while (true) {
        const soi = this.jpegBuffer.indexOf(Buffer.from([0xff, 0xd8]));
        if (soi < 0) { if (this.jpegBuffer.length > 1024) this.jpegBuffer = Buffer.alloc(0); break; }
        const eoi = this.jpegBuffer.indexOf(Buffer.from([0xff, 0xd9]), soi + 2);
        if (eoi < 0) { if (soi > 0) this.jpegBuffer = this.jpegBuffer.subarray(soi); break; }
        const jpeg = this.jpegBuffer.subarray(soi, eoi + 2);
        this.jpegBuffer = this.jpegBuffer.subarray(eoi + 2);
        if (jpeg.length > 5000 && Date.now() - this.lastSnapshotPublish > 3000) {
          this.lastSnapshotPublish = Date.now();
          try {
            const next = `${SNAPSHOT_PATH}.hub-next`;
            fs.writeFileSync(next, jpeg); fs.renameSync(next, SNAPSHOT_PATH);
            lastSnapshotTime = Date.now();
          } catch (e) {}
        }
      }
    });
    this.ff.stderr.on('data', d => {
      const s = d.toString().trim();
      if (s && this.videoBytes === 0) console.error('[MediaHub/ffmpeg]', s.slice(0, 1600));
    });
    this.ff.on('exit', (code, signal) => {
      if (this.ff?.pid !== pid) return;
      this.ff = null;
      console.warn(`[MediaHub] exited code=${code} signal=${signal}`);
      if (this.videoClients.size || this.audioSubscribers.size) {
        this.restartTimer = setTimeout(() => this.ensureStarted(), 1500);
      }
    });
  },
  addVideoClient(res) { this.videoClients.add(res); this.ensureStarted(); },
  removeVideoClient(res) { this.videoClients.delete(res); },
  subscribeAudio(fn) { this.audioSubscribers.add(fn); },
  unsubscribeAudio(fn) { this.audioSubscribers.delete(fn); },
  status() { return { running: !!(this.ff && !this.ff.killed && this.ff.exitCode === null), pid: this.ff?.pid || null, videoClients: this.videoClients.size, audioSubscribers: this.audioSubscribers.size, videoBytes: this.videoBytes, audioBytes: this.audioBytes }; }
};

const VoicePipeline = {
  ff: null,                  // ffmpeg child process
  running: false,
  state: 'idle',             // idle | listening | recording | asr | parsing | executing
  audioSource: null,       // 'rtsp' | 'local' — initialized from config on first start
  sseClients: new Set(),
  // VAD state
  speaking: false,
  speechFrames: 0,
  silenceFrames: 0,
  buffer: [],                // pending utterance PCM chunks (Buffer[])
  preRoll: [],               // rolling buffer to capture leading 200ms before VAD trigger
  preRollMaxFrames: 0,
  utteranceStartTime: 0,
  // Stats
  startedAt: 0,
  utterancesProcessed: 0,
  lastEvent: null,
  wakeArmedUntil: 0,       // wake word spoken alone → accept the next utterance briefly

  start(source, _isAutoRestart) {
    if (this.running) return false;
    const cfg = config.voiceControl;
    if (!cfg) return false;

    // Reset restart counter on user-initiated start (not on auto-restart chain)
    if (!_isAutoRestart) this.restartAttempts = 0;

    // Determine audio source
    if (source) this.audioSource = source;
    else if (!this.audioSource) this.audioSource = cfg.audioSource || 'rtsp';

    // VAD frame size: 100 ms @ 16kHz mono s16le = 1600 samples = 3200 bytes
    this.frameMs = 100;
    this.bytesPerFrame = 16 * 2 * this.frameMs; // 3200
    this.thrOn = cfg.vad?.energyThresholdOn ?? 0.018;
    this.thrOff = cfg.vad?.energyThresholdOff ?? 0.010;
    this.minSpeechFrames = Math.ceil((cfg.vad?.minSpeechMs ?? 300) / this.frameMs);
    this.silenceTimeoutFrames = Math.ceil((cfg.vad?.silenceTimeoutMs ?? 1000) / this.frameMs);
    this.maxUtteranceFrames = Math.ceil((cfg.vad?.maxUtteranceMs ?? 8000) / this.frameMs);
    this.preRollMaxFrames = Math.ceil((cfg.vad?.preRollMs ?? 200) / this.frameMs);
    this.partialIntervalFrames = Math.ceil((cfg.vad?.partialIntervalMs ?? 1500) / this.frameMs);
    this.partialEnabled = cfg.partialAsr !== false;
    this.lastPartialFrameMark = 0;
    this.partialInFlight = false;

    let ffArgs;
    if (this.audioSource === 'local') {
      // macOS avfoundation: capture from default audio input device
      const deviceIdx = cfg.localAudioDevice ?? '1';  // "1" = MacBook Pro麦克风
      ffArgs = [
        '-f', 'avfoundation',
        '-i', `:${deviceIdx}`,
        '-f', 's16le',
        '-acodec', 'pcm_s16le',
        '-ar', '16000',
        '-ac', '1',
        '-fflags', 'nobuffer',
        '-flush_packets', '1',
        '-'
      ];
    } else {
      ffArgs = [
        '-hide_banner', '-loglevel', 'error',
        '-rtsp_transport', 'tcp',
        '-i', config.camera.rtspUrl,
        '-vn', '-f', 's16le', '-acodec', 'pcm_s16le',
        '-ar', '16000', '-ac', '1', '-fflags', 'nobuffer',
        '-flush_packets', '1', '-'
      ];
    }

    this.ff = spawn('ffmpeg', ffArgs, { stdio: ['ignore', 'pipe', 'pipe'] });

    this.running = true;
    this.startedAt = Date.now();
    this.state = 'listening';
    this.broadcast({ type: 'state', state: 'listening', message: '语音监听已启动', audioSource: this.audioSource });
    console.log(`[Voice] Pipeline started (pid=${this.ff.pid}, source=${this.audioSource}). Wake words: ${cfg.wakeWords.join(', ')}`);

    let leftover = Buffer.alloc(0);
    this.ff.stdout.on('data', chunk => {
      const merged = leftover.length ? Buffer.concat([leftover, chunk]) : chunk;
      let offset = 0;
      while (merged.length - offset >= this.bytesPerFrame) {
        const frame = merged.subarray(offset, offset + this.bytesPerFrame);
        offset += this.bytesPerFrame;
        this._onFrame(frame);
      }
      leftover = merged.subarray(offset);
    });

    this.ff.stderr.on('data', d => {
      const s = d.toString();
      // Log more broadly for local source debugging
      if (this.audioSource === 'local') {
        const lines = s.trim().split('\n');
        for (const l of lines) {
          if (l && !/^  (lib|config|built)/.test(l)) console.log('[Voice/ffmpeg/local]', l);
        }
      } else if (/error|Error|401|unauthorized|timed out|Connection refused/i.test(s)) {
        console.error('[Voice/ffmpeg]', s.trim().split('\n').pop());
      }
    });

    const currentPid = this.ff.pid;
    this.ff.on('exit', code => {
      // Guard: only handle exit of CURRENT ffmpeg — ignore stale exit from previous instance
      if (this.ff && this.ff.pid !== currentPid) return;
      if (this.videoWatchTimer) { clearInterval(this.videoWatchTimer); this.videoWatchTimer = null; }
      console.log(`[Voice] ffmpeg exited (code=${code}, pid=${currentPid})`);
      const stillShouldRun = this.running;
      this.running = false;
      this.state = 'idle';
      if (stillShouldRun && (this.restartAttempts || 0) < 3) {
        // Auto-restart after 5s if pipeline should still be running (max 3 retries — instance-level counter survives across start() calls)
        this.restartAttempts = (this.restartAttempts || 0) + 1;
        const savedSource = this.audioSource; // preserve source across restart
        const attempt = this.restartAttempts;
        console.log(`[Voice] Will auto-restart in 5s (attempt ${attempt}/3, source=${savedSource})...`);
        setTimeout(() => {
          if (this.running) return; // user already restarted manually
          if (this.restartAttempts > 3) return;
          console.log(`[Voice] Auto-restarting pipeline (attempt ${attempt}/3, source=${savedSource})...`);
          this.start(savedSource, true);
        }, 5000);
      } else if (stillShouldRun) {
        console.log(`[Voice] Auto-restart cap reached (${this.restartAttempts}/3). Giving up. Check RTSP password / mic permissions.`);
        this.broadcast({ type: 'error', message: `语音管道连续失败 ${this.restartAttempts} 次，已停止重试。请检查 RTSP 密码或麦克风权限。` });
      }
      this.broadcast({ type: 'state', state: 'idle', message: '语音监听已停止' });
    });

    return true;
  },

  stop() {
    if (!this.running) return false;
    this.running = false;
    this.speaking = false;
    this.buffer = [];
    this.preRoll = [];
    if (this.videoWatchTimer) { clearInterval(this.videoWatchTimer); this.videoWatchTimer = null; }
    if (this.ff) {
      try { this.ff.kill('SIGKILL'); } catch (e) {}
      this.ff = null;
    }
    this.state = 'idle';
    this.broadcast({ type: 'state', state: 'idle', message: '语音监听已关闭' });
    console.log('[Voice] Pipeline stopped');
    // Snapshot refresh will auto-resume since VoicePipeline.running becomes false
    return true;
  },

  _onFrame(frame) {
    // Compute RMS energy in [0, 1]
    let sumSq = 0;
    const samples = frame.length / 2;
    for (let i = 0; i < frame.length; i += 2) {
      const s = frame.readInt16LE(i) / 32768;
      sumSq += s * s;
    }
    const rms = Math.sqrt(sumSq / samples);

    // Maintain pre-roll for capturing leading speech
    this.preRoll.push(frame);
    if (this.preRoll.length > this.preRollMaxFrames) this.preRoll.shift();

    if (!this.speaking) {
      if (rms >= this.thrOn) {
        this.speechFrames++;
        if (this.speechFrames >= this.minSpeechFrames) {
          // Speech start confirmed
          this.speaking = true;
          this.silenceFrames = 0;
          this.utteranceStartTime = Date.now();
          // Seed buffer with pre-roll + recent frames
          this.buffer = this.preRoll.slice();
          this.lastPartialFrameMark = 0;
          this.state = 'recording';
          this.broadcast({ type: 'state', state: 'recording', message: '正在录音...' });
        }
      } else {
        this.speechFrames = 0;
      }
    } else {
      this.buffer.push(frame);
      if (rms < this.thrOff) {
        this.silenceFrames++;
        if (this.silenceFrames >= this.silenceTimeoutFrames) {
          this._endUtterance('silence');
        }
      } else {
        this.silenceFrames = 0;
      }
      // Trigger partial ASR every partialIntervalFrames during recording
      if (this.partialEnabled
          && !this.partialInFlight
          && this.buffer.length - this.lastPartialFrameMark >= this.partialIntervalFrames
          && this.speaking) {
        this.lastPartialFrameMark = this.buffer.length;
        this._runPartialAsr(Buffer.concat(this.buffer));
      }
      // Hard cap on utterance length
      if (this.buffer.length >= this.maxUtteranceFrames) {
        this._endUtterance('max_duration');
      }
    }
  },

  _runPartialAsr(pcm) {
    this.partialInFlight = true;
    const wav = pcmToWav(pcm);
    asrTranscribe(wav, 'partial').then(text => {
      this.partialInFlight = false;
      // Only broadcast if still recording (utterance not yet ended)
      if (text && this.speaking) {
        this.broadcast({ type: 'partial', text });
      }
    }).catch(err => {
      this.partialInFlight = false;
      // Suppress partial errors — final ASR will retry
    });
  },

  _endUtterance(reason) {
    if (!this.speaking) return;
    const frames = this.buffer.length;
    const durationMs = frames * this.frameMs;
    this.speaking = false;
    this.speechFrames = 0;
    this.silenceFrames = 0;
    const utterancePcm = Buffer.concat(this.buffer);
    this.buffer = [];

    if (durationMs < 500) {
      this.state = 'listening';
      this.broadcast({ type: 'state', state: 'listening', message: '继续监听...' });
      return; // Too short to be a real command
    }

    console.log(`[Voice] Utterance captured: ${durationMs}ms (${reason})`);
    this.utterancesProcessed++;
    this._processUtterance(utterancePcm).catch(err => {
      console.error('[Voice] Process error:', err.message);
      this.broadcast({ type: 'error', message: err.message });
      this.state = 'listening';
      this.broadcast({ type: 'state', state: 'listening', message: '继续监听...' });
    });
  },

  async _processUtterance(pcm) {
    // 1. Wrap PCM to WAV
    const wav = pcmToWav(pcm, 16000, 1);
    this.state = 'asr';
    this.broadcast({ type: 'state', state: 'asr', message: '识别中...' });

    // 2. ASR via qwen-omni-turbo
    const text = await asrTranscribe(wav, 'final');
    this.broadcast({ type: 'asr', text });
    console.log(`[Voice] ASR: "${text}"`);

    if (!text || text.length < 2) {
      this.state = 'listening';
      this.broadcast({ type: 'state', state: 'listening', message: '没听清，继续监听...' });
      return;
    }

    // 3. Wake word check
    const cfg = config.voiceControl;
    let wakeMatch = matchWakeWord(text, cfg.wakeWords || []);
    if (!wakeMatch.matched && Date.now() < this.wakeArmedUntil) {
      wakeMatch = { matched: true, wakeWord: (cfg.wakeWords || [])[0] || '管家', remainder: text, followUp: true };
      console.log(`[Voice] Follow-up accepted inside wake window: "${text}"`);
    }
    if (!wakeMatch.matched) {
      this.broadcast({ type: 'ignored', text, reason: 'no_wake_word' });
      this.state = 'listening';
      this.broadcast({ type: 'state', state: 'listening', message: '继续监听...' });
      return;
    }

    const command = wakeMatch.remainder.trim();
    this.wakeArmedUntil = 0;
    this.broadcast({ type: 'wake', wakeWord: wakeMatch.wakeWord, text, command });
    console.log(`[Voice] Wake matched: "${wakeMatch.wakeWord}", command: "${command}"`);

    if (!command) {
      // Wake word alone — acknowledge and accept the next utterance without another wake word.
      this.wakeArmedUntil = Date.now() + 8000;
      const ack = '我在，请讲。';
      this.broadcast({ type: 'reply', text: ack, success: true });
      speakReply(ack, 'qaCommand');
      this.broadcast({ type: 'state', state: 'listening', message: '请说出指令...' });
      this.state = 'listening';
      return;
    }

    // 3b. Smart-home semantic gate. If command doesn't look home-related,
    // delegate to QA fallback (general assistant via LLM) when enabled, otherwise ignore.
    if (cfg.semanticGate !== false && !looksLikeCommand(command)) {
      const qaEnabled = config.voice?.qa?.enabled !== false;
      if (qaEnabled) {
        console.log(`[Voice] Wake matched, non-home command → QA fallback: "${command}"`);
        this.state = 'parsing';
        this.broadcast({ type: 'state', state: 'parsing', message: `问答模式: ${command}` });
        const qa = await answerLocalHomeQuestion(command) || await chitchatLLM(command);
        const reply = qa.reply || '抱歉，这个问题我暂时帮不了。';
        this.broadcast({ type: 'qa', text, command, reply, source: qa.source });
        this.broadcast({ type: 'reply', text: reply, success: !!qa.ok });
        speakReply(reply, 'qaCommand');
        this.state = 'listening';
        this.broadcast({ type: 'state', state: 'listening', message: '继续监听...' });
        return;
      }
      console.log(`[Voice] Wake matched but command unrelated to smart home, ignored: "${command}"`);
      this.broadcast({ type: 'ignored', text, reason: 'not_smart_home', command });
      const msg = '这条指令好像跟智能家居无关，已忽略。';
      this.broadcast({ type: 'reply', text: msg, success: false });
      if (this.audioSource === 'local') ttsSpeak(msg);
      this.state = 'listening';
      this.broadcast({ type: 'state', state: 'listening', message: '继续监听...' });
      return;
    }

    // 4. NL parse + execute via existing pipeline
    // Broadcast intent shortcut — speak literal text via Xiaoai, bypass parser/QA.
    const broadcast = tryBroadcastIntent(command);
    if (broadcast.matched) {
      console.log(`[Broadcast] (voice) "${command}" → speak "${broadcast.text}" (${broadcast.reason})`);
      this.broadcast({ type: 'parse', parse: { understood: true, broadcast: true, reply: broadcast.text } });
      speakReply(broadcast.text, 'broadcast');
      this.state = 'listening';
      this.broadcast({ type: 'state', state: 'listening', message: '已代播，继续监听...' });
      return;
    }

    this.state = 'parsing';
    this.broadcast({ type: 'state', state: 'parsing', message: `解析: ${command}` });
    const parseResult = await processNLCommand(command);
    this.broadcast({ type: 'parse', parse: parseResult });

    if (!parseResult.understood || !parseResult.actions?.length) {
      // Home parser failed → try QA fallback (e.g. user said something home-shaped but no matching device)
      const qaEnabled = config.voice?.qa?.enabled !== false;
      if (qaEnabled) {
        console.log(`[Voice] Home NL failed → QA fallback: "${command}"`);
        const qa = await answerLocalHomeQuestion(command) || await chitchatLLM(command);
        const reply = qa.reply || parseResult.reply || '没听懂这个指令';
        this.broadcast({ type: 'qa', text, command, reply, source: qa.source });
        this.broadcast({ type: 'reply', text: reply, success: !!qa.ok });
        speakReply(reply, 'qaCommand');
        this.state = 'listening';
        this.broadcast({ type: 'state', state: 'listening', message: '继续监听...' });
        return;
      }
      const msg = parseResult.reply || '没听懂这个指令';
      this.broadcast({ type: 'reply', text: msg, success: false });
      if (this.audioSource === 'local') ttsSpeak(msg);
      this.state = 'listening';
      this.broadcast({ type: 'state', state: 'listening', message: '继续监听...' });
      return;
    }

    this.state = 'executing';
    this.broadcast({ type: 'state', state: 'executing', message: '执行中...' });

    // Execute HA service calls (mirror /api/command logic — fuzzy match + climate guard)
    const states = await haRequest('GET', '/api/states');
    const executed = [];
    let totalMatches = 0;
    for (const action of parseResult.actions) {
      const matches = states.filter(e => {
        const domain = e.entity_id.split('.')[0];
        const name = e.attributes?.friendly_name || '';
        return domain === action.domain && fuzzyKeywordMatch(name, action.target_keyword || '');
      });
      totalMatches += matches.length;
      for (const entity of matches) {
        const recs = await executeServiceSafe(action, entity);
        for (const r of recs) executed.push(r);
      }
    }

    // Build a fact-based reply from the actual executed records (not from LLM).
    const okCount = executed.filter(r => r.ok).length;
    const skippedCount = executed.filter(r => r.skipped).length;
    let finalReply;
    if (totalMatches === 0) {
      const kw = parseResult.actions[0]?.target_keyword || '';
      finalReply = `没找到匹配「${kw}」的设备，操作未执行`;
    } else if (okCount === 0 && skippedCount === 0) {
      finalReply = `找到设备但执行失败，请检查设备状态`;
    } else if (okCount === 0 && skippedCount > 0) {
      finalReply = (await naturalizeReply(executed, command)) || '所有设备已是该状态，无需更改';
    } else {
      finalReply = (await naturalizeReply(executed, command)) || parseResult.reply || '已执行';
    }

    this.broadcast({ type: 'executed', executed, reply: finalReply });
    console.log(`[Voice] Matched ${totalMatches}, ok=${okCount} skipped=${skippedCount} — reply="${finalReply}"`);

    // Speak reply: broadcast through Xiaoai speaker (preferred) and/or local `say`
    if (finalReply) {
      speakReply(finalReply, 'nlCommand');
    }

    this.state = 'listening';
    this.broadcast({ type: 'state', state: 'listening', message: '继续监听...' });
  },

  broadcast(event) {
    const enriched = { ...event, ts: Date.now() };
    this.lastEvent = enriched;
    const payload = `data: ${JSON.stringify(enriched)}\n\n`;
    for (const res of this.sseClients) {
      try { res.write(payload); } catch (e) { this.sseClients.delete(res); }
    }
  },

  status() {
    return {
      running: this.running,
      state: this.state,
      audioSource: this.audioSource,
      startedAt: this.startedAt,
      utterancesProcessed: this.utterancesProcessed,
      wakeWords: config.voiceControl?.wakeWords || [],
      enabled: config.voiceControl?.enabled === true
    };
  },

  // Switch audio source — stops current pipeline and restarts with new source
  switchSource(newSource) {
    if (!['rtsp', 'local'].includes(newSource)) return { ok: false, error: 'invalid source' };
    if (newSource === this.audioSource && this.running) return { ok: true, audioSource: this.audioSource, message: 'already using this source' };
    const wasRunning = this.running;
    if (wasRunning) this.stop();
    this.audioSource = newSource;
    // Persist to config
    config.voiceControl.audioSource = newSource;
    try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2)); } catch (e) {}
    if (wasRunning) this.start(newSource);
    return { ok: true, audioSource: this.audioSource, running: this.running };
  }
};

// ============ TTS (Text-to-Speech for local mode) ============
// Uses macOS `say` command with Chinese voice. Only active when audioSource === 'local'.
function ttsSpeak(text) {
  if (!text) return;
  const cfg = config.voiceControl?.tts || {};
  if (cfg.enabled === false) return;
  const voice = cfg.voice || 'Tingting';
  const rate = cfg.rate || 200; // words per minute
  // Sanitize text for shell (remove quotes and newlines)
  const safe = text.replace(/["'`\n\r\\$]/g, ' ').slice(0, 200);
  const child = spawn('say', ['-v', voice, '-r', String(rate), safe], { stdio: 'ignore' });
  child.on('error', e => console.error('[TTS] say error:', e.message));
  console.log(`[TTS] Speaking: "${safe.slice(0, 40)}..."`);
}

// ============ Xiaoai Speaker (broadcast via Mi Home notify entity) ============
// Routes a short text reply to a Xiaomi smart speaker / display via HA notify.send_message.
async function notifyXiaoai(text, speakerEntityId) {
  if (!text) return { ok: false, reason: 'empty' };
  const cfg = config.xiaoai || {};
  if (cfg.enabled === false) return { ok: false, reason: 'disabled' };
  const target = speakerEntityId || cfg.defaultSpeaker;
  if (!target) return { ok: false, reason: 'no_target' };
  const maxLen = cfg.maxLength || 200;
  const safe = String(text).replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLen);
  if (!safe) return { ok: false, reason: 'empty_after_sanitize' };
  try {
    await haRequest('POST', '/api/services/notify/send_message', {
      entity_id: target,
      message: safe
    });
    const shortName = target.replace(/^notify\./, '').slice(0, 40);
    console.log(`[Xiaoai] → ${shortName}: "${safe.slice(0, 60)}"`);
    return { ok: true, target, message: safe };
  } catch (e) {
    console.error(`[Xiaoai] send failed (${target}):`, e.message);
    if (cfg.fallbackToLocalSay) ttsSpeak(text);
    return { ok: false, reason: 'ha_error', error: e.message };
  }
}

// Detect "broadcast" intent — user wants Xiaoai to literally speak some text.
// Examples:
//   "小爱同学说『离电视远一点』" → broadcast "离电视远一点"
//   "让小爱告诉孩子吃饭了"        → broadcast "孩子吃饭了"
//   "小爱播放语音『XXX』"         → broadcast "XXX"
//   "帮我广播：注意安全"          → broadcast "注意安全"
// Returns { matched: bool, text: string, reason: string }.
function tryBroadcastIntent(command) {
  if (!command) return { matched: false };
  const txt = String(command).trim();
  if (!txt) return { matched: false };

  // Pattern A: 触发词 + 各种引号包裹的内容（最高优先级，最准确）
  // 触发词 tolerant 到 ASR 错字：小爱同X / 小爱 / 让小爱 / 帮我...
  const quoteRe = /(?:小爱(?:同[学这]?)?|让小爱|帮(?:我|忙))[^「『""'']{0,12}(?:说|告诉|播放|广播|播报|提醒|讲|喊)[^「『""'']{0,8}[「『""'']([^」』""'']{2,80})[」』""'']/;
  const qm = txt.match(quoteRe);
  if (qm && qm[1]) {
    return { matched: true, text: qm[1].trim(), reason: 'quoted' };
  }

  // Pattern B: 触发词后面直接接内容（无引号），需要明确的"播报型"触发词避免误触
  // 必须以触发词开头或紧贴"小爱说"等
  const directRe = /^(?:小爱(?:同[学这]?)?\s*(?:说|告诉|播放语音|广播|播报|讲|喊)[:：，,\s]*|让小爱(?:说|告诉|播放|广播|播报|讲|喊)[:：，,\s]*|帮(?:我|忙)(?:说|告诉|广播|播报|喊)[:：，,\s]*)(.{2,80})$/;
  const dm = txt.match(directRe);
  if (dm && dm[1]) {
    let content = dm[1].trim();
    // Strip leading "一句『话』:" patterns
    content = content.replace(/^[一这那]?[句段段话内容][:：,，\s]*/, '').trim();
    if (content.length >= 2) {
      return { matched: true, text: content, reason: 'direct' };
    }
  }

  return { matched: false };
}

// Unified reply broadcaster: routes text reply to xiaoai speaker (per-event toggle) +
// optional local `say` fallback when voice pipeline runs on local mic.
function speakReply(text, eventType) {
  if (!text) return;
  const xiaoai = config.xiaoai || {};
  const eventEnabled = eventType ? xiaoai.triggerOn?.[eventType] !== false : true;
  if (xiaoai.enabled !== false && eventEnabled) {
    notifyXiaoai(text).catch(() => {});
  }
  // Preserve original behavior: when user is at the Mac (local mic), play through laptop
  if (VoicePipeline?.audioSource === 'local') {
    ttsSpeak(text);
  }
}

// PCM (s16le) → WAV (RIFF) Buffer
function pcmToWav(pcm, sampleRate, channels) {
  const byteRate = sampleRate * channels * 2;
  const blockAlign = channels * 2;
  const dataSize = pcm.length;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);          // PCM chunk size
  header.writeUInt16LE(1, 20);           // PCM format
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(16, 34);          // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, pcm]);
}

// One-shot ASR via DashScope qwen-omni-turbo (multimodal-generation endpoint)
function asrTranscribe(wavBuffer, kind) {
  return new Promise((resolve, reject) => {
    const audioBase64 = wavBuffer.toString('base64');
    const cfg = config.voiceControl;
    const model = cfg?.asrModel || 'qwen-omni-turbo';
    const usageType = kind === 'partial' ? 'voice_asr_partial' : 'voice_asr_final';
    const prompt = cfg?.asrPrompt || '请逐字精准转写这段中文家庭语音指令的内容。只输出转写文本，不要加任何解释、标点或前缀。如果是噪音或无意义声音，输出空字符串。';

    const payload = JSON.stringify({
      model,
      input: {
        messages: [{
          role: 'user',
          content: [
            { audio: `data:audio/wav;base64,${audioBase64}` },
            { text: prompt }
          ]
        }]
      },
      parameters: { result_format: 'message' }
    });

    const options = {
      hostname: 'dashscope.aliyuncs.com',
      path: '/api/v1/services/aigc/multimodal-generation/generation',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.ai.apiKey}`,
        'Content-Length': Buffer.byteLength(payload)
      }
    };

    const timer = setTimeout(() => {
      try { req.destroy(new Error('ASR timeout')); } catch (e) {}
      reject(new Error('ASR timeout'));
    }, (config.voiceControl?.responseTimeoutSec || 10) * 1000);

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        clearTimeout(timer);
        try {
          const r = JSON.parse(data);
          TokenUsage.recordFromResponse(model, usageType, r);
          // Two response shapes possible across qwen-omni versions
          const msg = r.output?.choices?.[0]?.message?.content;
          let text = '';
          if (typeof msg === 'string') text = msg;
          else if (Array.isArray(msg)) text = msg.map(p => p.text || '').join('').trim();
          else if (r.output?.text) text = r.output.text;
          // Strip common ASR noise
          text = (text || '').replace(/^["「『]|["」』。.\s]+$/g, '').trim();
          resolve(text);
        } catch (e) {
          reject(new Error('ASR parse failed: ' + (data.slice(0, 200))));
        }
      });
    });
    req.on('error', e => { clearTimeout(timer); reject(e); });
    req.write(payload);
    req.end();
  });
}

// Wake word matcher with multi-alias support and lenient prefix
function matchWakeWord(text, wakeWords) {
  if (!text || !wakeWords?.length) return { matched: false };
  const normalized = text.replace(/\s+/g, '').replace(/[，。、,.!?！？]/g, '');
  for (const w of wakeWords) {
    const wn = w.replace(/\s+/g, '');
    // Prefix or near-prefix (allow 1 char before)
    const idx = normalized.indexOf(wn);
    if (idx >= 0 && idx <= 2) {
      const remainder = normalized.slice(idx + wn.length);
      return { matched: true, wakeWord: w, remainder };
    }
  }
  return { matched: false };
}

// Detect whether an utterance looks like a smart-home command without a wake word.
// Three signals — any one matches => true:
//   1. Action verb prefix (打开/关闭/开/关/调亮/打开/把/让/帮我/请...)
//   2. State-feeling descriptors (太亮/太暗/太热/太冷/有点冷/不够亮...)
//   3. Device + state keyword (灯+开/关，空调+温度，窗帘+开/关...)
function looksLikeCommand(text) {
  if (!text) return false;
  const t = text.replace(/\s+/g, '').replace(/[，。、,.!?！？]/g, '');
  if (t.length < 3 || t.length > 40) return false;

  // 1) Action verb prefix
  const verbPrefix = /^(打开|关闭|关掉|开启|关上|开|关|调亮|调暗|调高|调低|调到|设置|设定|切换|启动|停止|播放|暂停|把|让|帮我|帮忙|请|麻烦|你能|你可以|能不能|可不可以|来|给我)/;
  if (verbPrefix.test(t)) return true;

  // 2) State-feeling descriptors (implies wanting an adjustment)
  const stateDescriptor = /(太亮|太暗|太黑|太热|太冷|太吵|太响|有点冷|有点热|有点暗|有点亮|不够亮|不够暗|凉快|暖和|刺眼|看不清)[了的吗呀啊]?/;
  if (stateDescriptor.test(t)) return true;

  // 3) Device noun + action context
  const deviceWords = /(灯|台灯|吊灯|射灯|筒灯|灯光|空调|冷气|暖气|风扇|窗帘|纱帘|电视|音响|扫地机|加湿器|插座|开关|空气净化器|净化器)/;
  const actionContext = /(打开|关闭|关掉|开|关|调|开下|关下|来|启动|停|开起来|关起来|开了|关了|开吧|关吧)/;
  if (deviceWords.test(t) && actionContext.test(t)) return true;

  return false;
}



function startPeriodicTasks() {
  const audioEnabled = config.audio?.enabled !== false;
  const captureFreq = (config.camera.captureIntervalSec || 60) * 1000;
  const snapshotRefreshSec = config.camera.snapshotRefreshSec || 15;

  const cameraVoiceOwnsRtsp = config.voiceControl?.enabled && (config.voiceControl.audioSource || 'rtsp') === 'rtsp';

  // Detect stream codec/resolution → adaptive mode/fps/width
  if (!cameraVoiceOwnsRtsp && !MediaHub.status().running) {
    detectStreamProfile()
      .then(profile => {
        if (profile.recommendedMode === 'snapshot' && !MediaHub.status().running) startSnapshotDaemon();
      })
      .catch(() => {});
  }
  // Re-probe every 10 minutes to catch quality / codec changes
  setInterval(() => { if (!cameraVoiceOwnsRtsp && !MediaHub.status().running) detectStreamProfile().catch(() => {}); }, 600000);

  // Environment snapshot sampling: every 30s for sparkline history
  sampleEnvHistory().catch(() => {});
  setInterval(() => sampleEnvHistory().catch(e => console.error('[Env]', e.message)), 30000);

  // Self-rescheduling rolling snapshot loop —— spawn-on-demand 模式下消除固定周期空窗。
  // 每次完成立即（500ms 后）发起下次 refresh，4K HEVC 实测节奏 ~3s/帧，比 15s setInterval 快 5×。
  let snapshotLoopRunning = true;
  const snapshotLoop = async () => {
    if (!snapshotLoopRunning) return;
    try { await refreshSnapshot(); } catch (e) {}
    setTimeout(snapshotLoop, 500);
  };
  snapshotLoop();
  
  // Full capture cycle (video + audio): for AI analysis and transcription
  setInterval(async () => {
    const result = await captureAll();
    
    // Trigger vision analysis if new snapshot
    if (result.video && lastSnapshotTime > lastAnalysis.timestamp) {
      setTimeout(() => analyzeSnapshot().catch(e => console.error('[AI] Error:', e.message)), 1000);
    }
    
    // Trigger audio transcription if new audio
    if (result.audio && audioEnabled) {
      setTimeout(() => transcribeAudio().catch(e => console.error('[Audio] Transcribe error:', e.message)), 2000);
    }

    // FALLBACK: if captureAll was skipped (live stream / voice on RTSP holding the camera),
    // refreshSnapshot is still updating SNAPSHOT_PATH every snapshotRefreshSec.
    // Use that latest in-memory snapshot to keep AI analysis + rule evaluation running.
    if (result.skipped && fs.existsSync(SNAPSHOT_PATH)) {
      const snapAge = Date.now() - (lastSnapshotTime || 0);
      if (lastSnapshotTime > lastAnalysis.timestamp && snapAge < captureFreq * 2) {
        console.log(`[AI] captureAll skipped — running analysis on latest snapshot (age ${Math.round(snapAge/1000)}s)`);
        setTimeout(() => analyzeSnapshot().catch(e => console.error('[AI] Error:', e.message)), 500);
      }
    }
  }, captureFreq);

  // No initial captureAll — snapshot refresh handles first frame.
  // First full capture (with audio) will run after captureFreq interval.
}

// ============ HTTP Server ============
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
};

const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  try {
    // === API Routes ===

    // Auto-detected stream profile (codec, resolution, fps + recommended mode/params)
    if (pathname === '/api/stream/profile') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({
        ...streamProfile,
        badFrameStreak,
        ageMs: streamProfile.detectedAt ? Date.now() - streamProfile.detectedAt : null
      }));
    }

    // Force re-probe (used by frontend when user changes camera quality)
    if (pathname === '/api/stream/redetect' && req.method === 'POST') {
      const profile = await detectStreamProfile();
      // Also kill any running stream ffmpeg so new profile takes effect on next reconnect
      const host = (config.camera.rtspUrl.match(/@([^:/]+)/) || [])[1] || '192.168';
      exec(`pkill -9 -f "ffmpeg.*${host}" 2>/dev/null`, () => {});
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: true, profile }));
    }

    // Direct low-latency video from the shared single-connection media hub.
    if (pathname === '/api/media/live') {
      res.writeHead(200, {
        'Content-Type': `multipart/x-mixed-replace; boundary=${MediaHub.boundary}`,
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'X-Accel-Buffering': 'no',
        'Connection': 'close'
      });
      try { res.flushHeaders(); req.socket.setNoDelay(true); } catch (e) {}
      MediaHub.addVideoClient(res);
      const cleanup = () => MediaHub.removeVideoClient(res);
      req.on('close', cleanup); req.on('end', cleanup);
      return;
    }
    if (pathname === '/api/media/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(MediaHub.status()));
    }

    // Continuous MJPEG stream from Home Assistant/NVR. This reuses HA's
    // camera session and avoids downloading a full 4K JPEG every 750ms.
    if (pathname === '/api/camera/live') {
      const entity = config.camera?.haEntity || 'camera.example_camera';
      proxyHaCameraStream(req, res, entity);
      return;
    }

    // Get latest snapshot
    if (pathname === '/api/camera/frame') {
      try {
        const entity = config.camera?.haEntity || 'camera.example_camera';
        const frame = await haBinaryRequest(`/api/camera_proxy/${encodeURIComponent(entity)}`);
        res.writeHead(200, { 'Content-Type': frame.contentType, 'Cache-Control': 'no-cache, no-store, must-revalidate' });
        return res.end(frame.body);
      } catch (e) {
        if (fs.existsSync(SNAPSHOT_PATH)) {
          const img = fs.readFileSync(SNAPSHOT_PATH);
          res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-cache', 'X-Camera-Fallback': 'snapshot' });
          return res.end(img);
        }
        res.writeHead(503, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: e.message }));
      }
    }

    // Get latest snapshot
    if (pathname === '/api/snapshot') {
      if (fs.existsSync(SNAPSHOT_PATH)) {
        const img = fs.readFileSync(SNAPSHOT_PATH);
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-cache' });
        return res.end(img);
      }
      res.writeHead(404);
      return res.end(JSON.stringify({ error: 'No snapshot' }));
    }

    // Live MJPEG stream (real-time video via multipart/x-mixed-replace)
    if (pathname === '/api/stream/fmp4') {
      // Low-latency fMP4 + MSE pipeline:
      //  - 4K Baseline 5.1 from Synology ssrtspd is rejected by macOS VideoToolbox
      //    (kVTVideoDecoderBadDataErr / -12909 in Chrome/Safari).
      //  - Workaround: ultrafast re-encode to 1080p Constrained Baseline 4.0,
      //    universally accepted by VTDecoder. CPU ~18% on M-series for 4K→1080p.
      //  - frag_duration 200ms → low end-to-end delay (<1s typical).
      res.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
        'X-Accel-Buffering': 'no',
        'Connection': 'close'
      });
      try { res.flushHeaders(); } catch (e) {}
      try { req.socket.setNoDelay(true); } catch (e) {}

      const rtspUrl = config.camera.rtspUrl;
      const ff = spawn('ffmpeg', [
        '-hide_banner',
        '-loglevel', 'error',
        '-fflags', 'nobuffer+flush_packets+genpts',
        '-flags', 'low_delay',
        '-rtsp_transport', 'tcp',
        '-probesize', '500000',
        '-analyzeduration', '500000',
        '-rtbufsize', '4M',
        '-max_delay', '500000',
        '-i', rtspUrl,
        '-map', '0:v:0',
        '-an',
        '-vf', 'scale=1280:720',
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-tune', 'zerolatency',
        '-profile:v', 'baseline',
        '-level', '4.0',
        '-pix_fmt', 'yuv420p',
        '-crf', '28',
        '-g', '30',                       // keyframe every 1s @ 30fps for fast MSE startup
        '-keyint_min', '30',
        '-sc_threshold', '0',
        '-f', 'mp4',
        '-movflags', 'frag_keyframe+empty_moov+default_base_moof+separate_moof',
        '-frag_duration', '200000',
        '-reset_timestamps', '1',
        '-flush_packets', '1',
        'pipe:1'
      ], { stdio: ['ignore', 'pipe', 'pipe'] });

      console.log(`[fMP4] Client connected (pid=${ff.pid}, 1080p baseline 4.0 reencode for VTDecoder compat)`);
      activeStreamClients++;

      ff.stdout.on('data', (chunk) => {
        if (!res.write(chunk)) {
          ff.stdout.pause();
          res.once('drain', () => { try { ff.stdout.resume(); } catch (e) {} });
        }
      });
      ff.stderr.on('data', (d) => {
        const s = d.toString();
        if (s.includes('error') || s.includes('Error') || s.includes('Invalid')) {
          console.log(`[fMP4/ff] ${s.trim().slice(0, 200)}`);
        }
      });

      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        activeStreamClients = Math.max(0, activeStreamClients - 1);
        try { ff.kill('SIGKILL'); } catch (e) {}
        console.log(`[fMP4] Client disconnected (pid=${ff.pid}, ${activeStreamClients} remaining)`);
      };
      req.on('close', cleanup);
      req.on('end', cleanup);
      ff.on('exit', () => { try { res.end(); } catch (e) {} });
      return;
    }

    // === Probe the stream codec for client-side MSE mime negotiation ===
    if (pathname === '/api/stream/codec' && req.method === 'GET') {
      try {
        // ffprobe to extract codec_tag_string + profile + level for accurate MSE codec string
        const probe = spawn('ffprobe', [
          '-v', 'error',
          '-rtsp_transport', 'tcp',
          '-select_streams', 'v:0',
          '-show_entries', 'stream=codec_name,codec_tag_string,profile,level,width,height',
          '-of', 'json',
          '-i', config.camera.rtspUrl
        ]);
        let out = '';
        let err = '';
        probe.stdout.on('data', d => out += d);
        probe.stderr.on('data', d => err += d);
        const timer = setTimeout(() => { try { probe.kill('SIGKILL'); } catch (e) {} }, 8000);
        probe.on('close', () => {
          clearTimeout(timer);
          try {
            const info = JSON.parse(out).streams?.[0] || {};
            // Build MSE codec string for HEVC: hvc1.{profile_id}.{compat_flags}.L{level}.B0
            // profile_id: Main=1, Main10=2, MainSP=3
            // level value from ffprobe is level*30 (e.g. 4K Main L5.0 = 150)
            // NOTE: /api/stream/fmp4 outputs 1080p Constrained Baseline level 4.0
            // (re-encoded from source for VTDecoder compatibility, regardless of
            //  what the source codec is). Always return that codec string so the
            //  browser-side MSE.isTypeSupported check reflects the actual stream.
            const mse = 'avc1.42E028';   // baseline + constraint_set1_flag + level 4.0
            const outWidth = 1280;
            const outHeight = 720;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              srcCodec: info.codec_name,
              srcProfile: info.profile,
              srcLevel: info.level,
              srcWidth: info.width,
              srcHeight: info.height,
              codec: 'h264',
              profile: 'Constrained Baseline',
              level: 40,
              width: outWidth,
              height: outHeight,
              mseCodec: mse,
              mseMime: `video/mp4; codecs="${mse}"`,
              transcoded: true
            }));
            return;
          } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message, stderr: err.slice(0, 200) }));
            return;
          }
        });
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    if (pathname === '/api/stream') {
      stopSnapshotDaemon('live stream client connected');
      const boundary = 'ffmpegmjpeg';
      res.writeHead(200, {
        'Content-Type': `multipart/x-mixed-replace; boundary=${boundary}`,
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
        'X-Accel-Buffering': 'no',
        'Connection': 'close'
      });
      // Force headers out immediately so browser starts the multipart parser
      try { res.flushHeaders(); } catch(e) {}
      try { req.socket.setNoDelay(true); } catch(e) {}

      const rtspUrl = config.camera.rtspUrl;
      // Adaptive: prefer auto-detected profile values; fall back to config; final to defaults
      const fps = streamProfile.recommendedStreamFps || config.camera.streamFps || 8;
      const width = streamProfile.recommendedStreamWidth || config.camera.streamWidth || 720;
      const qv = String(streamProfile.recommendedQv || 10);

      // Low-latency ffmpeg pipeline:
      //  - probesize/analyzeduration tiny → skip the 1-2s stream-analysis phase
      //  - nobuffer + low_delay + flush_packets → don't buffer demuxer output
      //  - -r N at INPUT side decimates frames cheaply (no fps-filter buffering)
      //  - -threads 1 → no multi-frame thread queue (1 frame in = 1 frame out)
      //  - rtbufsize 1M → enough for 4K I-frames but no more
      const snapW = config.camera.snapshotWidth || 640;
      const ff = spawn('ffmpeg', [
        '-hide_banner',
        '-loglevel', 'error',
        // 4K RTSP access units can be much larger than the old 2M/200ms
        // low-latency window. Dropping a late slice corrupts the remainder of
        // the decoded frame (large grey blocks / stale silhouettes), so keep a
        // modest jitter buffer and favour complete frames over sub-second lag.
        '-fflags', 'genpts+discardcorrupt',
        '-strict', 'experimental',
        '-probesize', '2000000',         // include a complete 4K keyframe + SPS/PPS
        '-analyzeduration', '1000000',   // 1s startup analysis for stable timestamps
        '-rtsp_transport', 'tcp',
        '-rtbufsize', '16M',              // absorb large 4K I-frames and LAN jitter
        '-max_delay', '1000000',          // favour frame integrity over minimum latency
        '-i', rtspUrl,
        // Output 1: live MJPEG stream to client (low-latency)
        '-map', '0:v:0',
        '-an',
        '-vf', `scale=${width}:-2:in_range=tv:out_range=pc,fps=${fps}:round=zero,format=yuvj420p`,
        '-q:v', qv,                      // adaptive: smaller frames = faster transit
        '-threads', '2',
        '-fps_mode', 'cfr',
        '-flush_packets', '1',
        '-f', 'mpjpeg',
        '-boundary_tag', boundary,
        'pipe:1',
        // Output 2: periodic snapshot file (1 frame every 5s) for AI/rules
        '-map', '0:v:0',
        '-an',
        '-vf', `scale=${snapW}:-2:in_range=tv:out_range=pc,fps=1/5,format=yuvj420p`,
        '-q:v', '5',
        '-threads', '1',
        '-update', '1',
        '-y',
        SNAPSHOT_PATH
      ], { stdio: ['ignore', 'pipe', 'pipe'] });

      console.log(`[Stream] Client connected (pid=${ff.pid}, ${width}p@${fps}fps low-latency)`);
      activeStreamClients++;

      // Manual write loop (avoid Node's pipe high-water-mark buffering of ~16KB)
      ff.stdout.on('data', (chunk) => {
        if (!res.write(chunk)) {
          // Backpressure — pause ffmpeg until drain
          ff.stdout.pause();
          res.once('drain', () => { try { ff.stdout.resume(); } catch(e){} });
        }
      });
      ff.stderr.on('data', (d) => {
        const s = d.toString();
        if (s.includes('error') || s.includes('Error')) {
          console.log(`[Stream/ff] ${s.trim().slice(0, 200)}`);
        }
      });

      // Watch for snapshot file updates from stream's second output (every ~5s)
      // and bump lastSnapshotTime so periodic AI analysis sees fresh frames.
      let lastWatchedMtime = 0;
      const snapWatcher = setInterval(() => {
        try {
          if (fs.existsSync(SNAPSHOT_PATH)) {
            const st = fs.statSync(SNAPSHOT_PATH);
            if (st.mtimeMs > lastWatchedMtime && st.size > 5000) {
              lastWatchedMtime = st.mtimeMs;
              lastSnapshotTime = st.mtimeMs;
            }
          }
        } catch (e) {}
      }, 2000);

      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        clearInterval(snapWatcher);
        activeStreamClients = Math.max(0, activeStreamClients - 1);
        try { ff.kill('SIGKILL'); } catch (e) {}
        console.log(`[Stream] Client disconnected (pid=${ff.pid}, ${activeStreamClients} remaining)`);
      };

      req.on('close', cleanup);
      req.on('end', cleanup);
      ff.on('exit', () => { try { res.end(); } catch (e) {} });
      return;
    }


    // Trigger manual capture
    if (pathname === '/api/capture' && req.method === 'POST') {
      const success = await captureSnapshot();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success, timestamp: lastSnapshotTime }));
    }

    // Get AI analysis
    if (pathname === '/api/analysis') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(lastAnalysis));
    }

    // LLM token usage stats
    if (pathname === '/api/usage') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(TokenUsage.summary()));
    }

    if (pathname === '/api/memory' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(MemoryEngine.summary()));
    }

    if (pathname === '/api/memory/feedback' && req.method === 'POST') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        try {
          const item = MemoryEngine.addFeedback(JSON.parse(body || '{}'));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, item, summary: MemoryEngine.summary() }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    // ============ Automation Rules ============
    // List all rules + meta
    if (pathname === '/api/rules' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        enabled: AutomationEngine.enabled,
        rules: AutomationEngine.rules,
        defaultCooldownSec: AutomationEngine.defaultCooldown
      }));
    }

    // Add new rule
    if (pathname === '/api/rules' && req.method === 'POST') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        try {
          const rule = JSON.parse(body || '{}');
          const created = AutomationEngine.add(rule);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(created));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    // Update rule  PUT /api/rules/{id}
    if (pathname.startsWith('/api/rules/') && req.method === 'PUT') {
      const id = pathname.replace('/api/rules/', '').split('/')[0];
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        try {
          const patch = JSON.parse(body || '{}');
          const updated = AutomationEngine.update(id, patch);
          if (!updated) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'rule not found' }));
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(updated));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    // Delete rule  DELETE /api/rules/{id}
    if (pathname.startsWith('/api/rules/') && req.method === 'DELETE') {
      const id = pathname.replace('/api/rules/', '').split('/')[0];
      const ok = AutomationEngine.remove(id);
      res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: ok }));
    }

    // Toggle global automation  POST /api/automation/toggle
    if (pathname === '/api/automation/toggle' && req.method === 'POST') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        try {
          const { enabled } = JSON.parse(body || '{}');
          AutomationEngine.enabled = !!enabled;
          AutomationEngine.save();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ enabled: AutomationEngine.enabled }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    // Trigger history
    if (pathname === '/api/rules/history') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ history: AutomationEngine.history }));
    }

    // SSE event stream for rule fires
    if (pathname === '/api/rules/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*'
      });
      res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);
      AutomationEngine.sseClients.add(res);
      const hb = setInterval(() => { try { res.write(': hb\n\n'); } catch (e) {} }, 30000);
      req.on('close', () => { clearInterval(hb); AutomationEngine.sseClients.delete(res); });
      return;
    }

    // Manually trigger a rule (testing)  POST /api/rules/{id}/trigger
    if (pathname.match(/^\/api\/rules\/[^/]+\/trigger$/) && req.method === 'POST') {
      const id = pathname.split('/')[3];
      const rule = AutomationEngine.rules.find(r => r.id === id);
      if (!rule) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'rule not found' }));
      }
      AutomationEngine.lastTriggered.delete(id); // bypass cooldown for manual test
      AutomationEngine._fireRule(rule, '手动触发测试').catch(() => {});
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ triggered: true }));
    }

    // Trigger manual analysis
    if (pathname === '/api/analyze' && req.method === 'POST') {
      const result = await analyzeSnapshot();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(result));
    }

    // Natural language command
    if (pathname === '/api/command' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        try {
          const { command } = JSON.parse(body);

          // Broadcast intent shortcut: user wants Xiaoai to literally speak some text.
          // Bypass home parser and QA fallback entirely — fastest, cheapest, correct.
          const broadcast = tryBroadcastIntent(command);
          if (broadcast.matched) {
            console.log(`[Broadcast] "${command}" → speak "${broadcast.text}" (${broadcast.reason})`);
            speakReply(broadcast.text, 'broadcast');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              understood: true,
              broadcast: true,
              reply: broadcast.text,
              source: 'broadcast'
            }));
            return;
          }

          const result = await processNLCommand(command);
          
          // Execute actions if understood
          if (result.understood && result.actions?.length > 0) {
            const states = await haRequest('GET', '/api/states');
            const executed = [];
            let totalMatches = 0;
            
            for (const action of result.actions) {
              // Find matching entities (fuzzy)
              const matches = states.filter(e => {
                const domain = e.entity_id.split('.')[0];
                const name = e.attributes?.friendly_name || '';
                return domain === action.domain &&
                       fuzzyKeywordMatch(name, action.target_keyword || '');
              });
              totalMatches += matches.length;
              
              for (const entity of matches) {
                const recs = await executeServiceSafe(action, entity);
                executed.push(...recs);
              }
            }
            result.executed = executed;
            // Anti-hallucination guard + fact-based reply override.
            const okCount = executed.filter(r => r.ok).length;
            const skippedCount = executed.filter(r => r.skipped).length;
            if (totalMatches === 0) {
              result.reply = `没找到匹配「${result.actions[0].target_keyword || ''}」的设备，操作未执行`;
              result.understood = false;
            } else if (okCount === 0 && skippedCount === 0) {
              result.reply = `找到设备但执行失败，请检查设备状态`;
              result.understood = false;
            } else {
              // Replace LLM reply with natural-language summary grounded in actual records.
              const summary = await naturalizeReply(executed, command);
              if (summary) result.reply = summary;
            }
          } else if (config.voice?.qa?.enabled !== false) {
            // Home parser couldn't act → fall back to QA general assistant
            const qa = await answerLocalHomeQuestion(command) || await chitchatLLM(command);
            if (qa.reply) {
              result.reply = qa.reply;
              result.qaSource = qa.source;
            }
          }

          // Broadcast reply through Xiaoai speaker
          if (result.reply) {
            const eventType = (result.executed && result.executed.length) ? 'nlCommand' : 'qaCommand';
            speakReply(result.reply, eventType);
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    // HA states proxy
    if (pathname === '/api/ha/states') {
      const states = await haRequest('GET', '/api/states');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(states));
    }

    // === Environment snapshot (hero bar) ===
    if (pathname === '/api/env/snapshot' && req.method === 'GET') {
      // Force refresh if cache is stale (>10s) or missing
      const stale = !lastEnvSnapshot || (Date.now() - lastEnvSnapshot.ts) > 10000;
      if (stale) await sampleEnvHistory();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        snapshot: lastEnvSnapshot,
        history: envHistory
      }));
    }

    // HA service call proxy
    if (pathname.startsWith('/api/ha/services/') && req.method === 'POST') {
      const servicePath = pathname.replace('/api/ha/services/', '');
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        const result = await haRequest('POST', `/api/services/${servicePath}`, JSON.parse(body || '{}'));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      });
      return;
    }

    // === Xiaoai speaker ===
    // GET /api/xiaoai/config — list configured speakers + current toggle state
    if (pathname === '/api/xiaoai/config' && req.method === 'GET') {
      const cfg = config.xiaoai || {};
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        enabled: cfg.enabled !== false,
        defaultSpeaker: cfg.defaultSpeaker || null,
        speakers: cfg.speakers || [],
        triggerOn: cfg.triggerOn || { nlCommand: true, ruleTrigger: true, aiSuggestion: false },
        fallbackToLocalSay: !!cfg.fallbackToLocalSay,
        maxLength: cfg.maxLength || 200
      }));
    }

    // POST /api/xiaoai/config — patch config (enabled / defaultSpeaker / triggerOn)
    if (pathname === '/api/xiaoai/config' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const patch = JSON.parse(body || '{}');
          if (!config.xiaoai) config.xiaoai = {};
          if (typeof patch.enabled === 'boolean') config.xiaoai.enabled = patch.enabled;
          if (typeof patch.defaultSpeaker === 'string') config.xiaoai.defaultSpeaker = patch.defaultSpeaker;
          if (patch.triggerOn && typeof patch.triggerOn === 'object') {
            config.xiaoai.triggerOn = { ...(config.xiaoai.triggerOn || {}), ...patch.triggerOn };
          }
          if (typeof patch.fallbackToLocalSay === 'boolean') config.xiaoai.fallbackToLocalSay = patch.fallbackToLocalSay;
          // Persist to config.json
          try {
            fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
          } catch (e) {
            console.error('[Xiaoai] persist config failed:', e.message);
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, xiaoai: config.xiaoai }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
      });
      return;
    }

    // POST /api/xiaoai/speak — manual speak (test button / external triggers)
    // body: { message: string, speaker?: string }
    if (pathname === '/api/xiaoai/speak' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        try {
          const { message, speaker } = JSON.parse(body || '{}');
          const result = await notifyXiaoai(message, speaker);
          res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
      });
      return;
    }

    // === RTSP camera URL config ===
    // GET /api/rtsp/config — return current URL + classification
    if (pathname === '/api/rtsp/config' && req.method === 'GET') {
      const url = config.camera?.rtspUrl || '';
      const masked = url.replace(/:[^@/]+@/, ':***@').replace(/StmKey=([0-9a-f]{4})[0-9a-f]+/i, 'StmKey=$1***');
      const hasStmKey = /StmKey=/.test(url);
      const hasUserPass = /:\/\/[^/@]+:[^/@]+@/.test(url);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        masked,
        configured: !!url,
        type: hasStmKey ? 'stmkey' : (hasUserPass ? 'userpass' : 'plain'),
        ttlNote: hasStmKey ? '永久授权 (StmKey)' : (hasUserPass ? '可能受 DSM 流密码 TTL 影响' : '未识别')
      }));
    }

    // POST /api/rtsp/config — update RTSP URL, persist, hot-restart pipelines
    // body: { rtspUrl: string }
    if (pathname === '/api/rtsp/config' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const { rtspUrl } = JSON.parse(body || '{}');
          if (!rtspUrl || typeof rtspUrl !== 'string' || !/^rtsp:\/\//i.test(rtspUrl)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ ok: false, error: 'rtspUrl must start with rtsp://' }));
          }
          // Persist (re-read disk to merge any concurrent edits)
          let onDisk;
          try { onDisk = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')); } catch { onDisk = config; }
          if (!onDisk.camera) onDisk.camera = {};
          onDisk.camera.rtspUrl = rtspUrl;
          fs.writeFileSync(CONFIG_PATH, JSON.stringify(onDisk, null, 2));
          // Update in-memory config
          if (!config.camera) config.camera = {};
          config.camera.rtspUrl = rtspUrl;
          console.log(`[RTSP] URL updated → ${rtspUrl.replace(/:[^@/]+@/, ':***@').replace(/StmKey=([0-9a-f]{4})[0-9a-f]+/i, 'StmKey=$1***')}`);
          // Hot-kill any ffmpeg currently bound to old URL; periodic loops will respawn with new URL
          try {
            require('child_process').execSync('pkill -9 -f "ffmpeg.*rtsp" 2>/dev/null', { stdio: 'ignore' });
            console.log('[RTSP] Killed running ffmpeg processes; pipelines will respawn with new URL');
          } catch {}
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, rtspUrl }));
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
      });
      return;
    }

    // POST /api/rtsp/test — verify a candidate URL.
    // Strategy: same as current rtspUrl → just check snapshot mtime (zero camera pressure);
    //           different URL → preempt host, spawn one-shot ffmpeg.
    if (pathname === '/api/rtsp/test' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const { rtspUrl } = JSON.parse(body || '{}');
          if (!rtspUrl || !/^rtsp:\/\//i.test(rtspUrl)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ ok: false, error: 'rtspUrl must start with rtsp://' }));
          }
          const t0 = Date.now();
          const currentUrl = (config.camera && config.camera.rtspUrl) || config.rtspUrl || '';
          const isCurrentUrl = currentUrl.trim() === rtspUrl.trim();

          // Path A: same as current URL → trust periodic captureAll's snapshot freshness
          if (isCurrentUrl) {
            try {
              const stat = fs.statSync(SNAPSHOT_PATH);
              const ageSec = Math.round((Date.now() - stat.mtimeMs) / 1000);
              const fresh = ageSec < 90;
              res.writeHead(200, { 'Content-Type': 'application/json' });
              return res.end(JSON.stringify({
                ok: fresh,
                bytes: stat.size,
                elapsedMs: Date.now() - t0,
                ageSec,
                mode: 'snapshot-mtime',
                error: fresh ? null : `snapshot 已 ${ageSec}s 未更新`,
                hint: fresh
                  ? '当前 URL 正在使用，周期任务最近抓帧成功。'
                  : '可能：(1) 语音监听占用 ssrtspd；(2) 摄像头密码过期；(3) 相机或网络问题。建议先关语音再观察。'
              }));
            } catch (e) {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              return res.end(JSON.stringify({
                ok: false, bytes: 0, elapsedMs: Date.now() - t0,
                mode: 'snapshot-mtime', error: 'snapshot 文件不存在',
                hint: '主流从未抓帧成功。先确认密码与 URL 是否正确。'
              }));
            }
          }

          // Path B: new URL → preempt + spawn ffmpeg
          const tmpFile = `/tmp/rtsp_test_${Date.now()}.jpg`;
          const host = (rtspUrl.match(/@([^:/]+)/) || [])[1] || '';
          const exec = require('child_process').exec;
          const preempt = host ? new Promise(r => exec(`pkill -9 -f "ffmpeg.*${host}" 2>/dev/null; sleep 1.5`, () => r())) : Promise.resolve();
          preempt.then(() => {
            const cmd = `ffmpeg -hide_banner -loglevel warning -fflags nobuffer+flush_packets -flags low_delay -rtsp_transport tcp -probesize 200K -analyzeduration 200K -i "${rtspUrl}" -t 6 -an -vf "scale=320:-2:in_range=tv:out_range=pc" -frames:v 1 -update 1 -q:v 5 -y "${tmpFile}"`;
            exec(cmd, { timeout: 28000, killSignal: 'SIGKILL' }, (err, stdout, stderr) => {
              const elapsedMs = Date.now() - t0;
              try {
                const ok = !err && fs.existsSync(tmpFile) && fs.statSync(tmpFile).size > 1000;
                const bytes = ok ? fs.statSync(tmpFile).size : 0;
                try { fs.unlinkSync(tmpFile); } catch {}
                const stderrTail = (stderr || '').toString().split('\n')
                  .filter(l => l && !l.includes('Multi-layer HEVC')).slice(-3).join(' | ');
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                  ok, bytes, elapsedMs, mode: 'spawn-test',
                  error: ok ? null : (stderrTail || (err && err.message) || 'no frame within 28s'),
                  hint: ok ? null : '已自动 pkill 让出 ssrtspd 但仍超时。可能：(1) URL/密码错；(2) IP 被相机临时拉黑；(3) 流编码不可解。'
                }));
              } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: e.message, elapsedMs }));
              }
            });
          });
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
      });
      return;
    }

    // Get audio transcripts
    if (pathname === '/api/audio/transcripts') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ transcripts: audioTranscripts }));
    }

    // Trigger manual audio capture + transcribe
    if (pathname === '/api/audio/capture' && req.method === 'POST') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      captureAll().then(result => {
        if (result.audio) {
          setTimeout(() => transcribeAudio().catch(e => {}), 500);
        }
      });
      return res.end(JSON.stringify({ started: true }));
    }

    // === Voice control ===
    if (pathname === '/api/voice/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(VoicePipeline.status()));
    }

    // Audio source switch
    if (pathname === '/api/voice/source' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ audioSource: VoicePipeline.audioSource, options: ['rtsp', 'local'] }));
    }
    if (pathname === '/api/voice/source' && req.method === 'POST') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        try {
          const { source } = JSON.parse(body);
          const result = VoicePipeline.switchSource(source);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
      });
      return;
    }

    if (pathname === '/api/voice/start' && req.method === 'POST') {
      config.voiceControl = config.voiceControl || {};
      config.voiceControl.enabled = true;
      try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2)); } catch (e) {}
      const ok = VoicePipeline.start();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok, status: VoicePipeline.status() }));
    }

    if (pathname === '/api/voice/stop' && req.method === 'POST') {
      if (config.voiceControl) config.voiceControl.enabled = false;
      try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2)); } catch (e) {}
      const ok = VoicePipeline.stop();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok, status: VoicePipeline.status() }));
    }

    if (pathname === '/api/voice/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
      });
      // Send current status snapshot first
      res.write(`data: ${JSON.stringify({ type: 'state', state: VoicePipeline.state, ts: Date.now() })}\n\n`);
      VoicePipeline.sseClients.add(res);
      const heartbeat = setInterval(() => {
        try { res.write(`: hb ${Date.now()}\n\n`); } catch (e) {}
      }, 15000);
      const cleanup = () => {
        clearInterval(heartbeat);
        VoicePipeline.sseClients.delete(res);
      };
      req.on('close', cleanup);
      req.on('end', cleanup);
      return; // long-lived
    }

    if (pathname === '/api/voice/config' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(config.voiceControl || {}));
    }

    if (pathname === '/api/voice/config' && req.method === 'POST') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        try {
          const patch = JSON.parse(body || '{}');
          config.voiceControl = { ...(config.voiceControl || {}), ...patch };
          // Persist to disk (best-effort)
          try {
            fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
          } catch (e) { console.error('[Voice] config persist failed:', e.message); }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, voiceControl: config.voiceControl }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    // === QA fallback config (general assistant via LLM after wake-word) ===
    if (pathname === '/api/voice/qa/config' && req.method === 'GET') {
      const qa = config.voice?.qa || {};
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        enabled: qa.enabled !== false,
        model: qa.model || 'qwen-turbo',
        maxTokens: qa.maxTokens || 80,
        timeoutMs: qa.timeoutMs || 8000,
        systemPrompt: qa.systemPrompt || '',
        fallbackText: qa.fallbackText || ''
      }));
    }

    if (pathname === '/api/voice/qa/config' && req.method === 'POST') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        try {
          const patch = JSON.parse(body || '{}');
          if (!config.voice) config.voice = {};
          if (!config.voice.qa) config.voice.qa = {};
          if (typeof patch.enabled === 'boolean') config.voice.qa.enabled = patch.enabled;
          if (typeof patch.model === 'string') config.voice.qa.model = patch.model;
          if (typeof patch.maxTokens === 'number') config.voice.qa.maxTokens = patch.maxTokens;
          if (typeof patch.timeoutMs === 'number') config.voice.qa.timeoutMs = patch.timeoutMs;
          if (typeof patch.systemPrompt === 'string') config.voice.qa.systemPrompt = patch.systemPrompt;
          if (typeof patch.fallbackText === 'string') config.voice.qa.fallbackText = patch.fallbackText;
          try {
            fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
          } catch (e) { console.error('[QA] config persist failed:', e.message); }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, qa: config.voice.qa }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    // Get config (sanitized)
    // === System Settings: LLM (apiKey/baseUrl/models) + Home Assistant (url/token) ===
    if (pathname === '/api/settings' && req.method === 'GET') {
      const ai = config.ai || {};
      const ha = config.homeAssistant || {};
      const apiKey = ai.apiKey || '';
      const haToken = ha.token || '';
      // mask sensitive: show first 6 + last 4
      const mask = s => (s && s.length > 12) ? `${s.slice(0,6)}${'*'.repeat(Math.min(s.length-10, 24))}${s.slice(-4)}` : (s ? '***' : '');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        llm: {
          baseUrl: ai.baseUrl || '',
          apiKeyMasked: mask(apiKey),
          hasApiKey: !!apiKey,
          visionModel: ai.model || '',
          commandModel: ai.commandModel || '',
          qaModel: config.voice?.qa?.model || '',
          asrModel: config.voiceControl?.asrModel || '',
          audioModel: config.audio?.model || 'qwen-omni-turbo',
          analysisIntervalSec: ai.analysisIntervalSec || 60
        },
        homeAssistant: {
          url: ha.url || '',
          tokenMasked: mask(haToken),
          hasToken: !!haToken
        },
        availableModels: {
          vision: ['qwen3-vl-235b-a22b-instruct', 'qwen3-vl-plus', 'qwen-vl-max', 'qwen-vl-plus'],
          command: ['qwen3-max', 'qwen-max', 'qwen-plus', 'qwen-turbo'],
          qa: ['qwen-turbo', 'qwen-plus', 'qwen3-omni-flash'],
          asr: ['qwen3-omni-flash', 'qwen-omni-turbo'],
          audio: ['qwen-omni-turbo', 'qwen3-omni-flash']
        },
        pricing: config.llmPricing || {}
      }));
    }

    if (pathname === '/api/settings' && req.method === 'PUT') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        try {
          const patch = JSON.parse(body || '{}');
          if (patch.llm) {
            config.ai = config.ai || {};
            const L = patch.llm;
            if (typeof L.baseUrl === 'string') config.ai.baseUrl = L.baseUrl.trim();
            if (typeof L.apiKey === 'string' && !L.apiKey.includes('*')) config.ai.apiKey = L.apiKey.trim();
            if (typeof L.visionModel === 'string') config.ai.model = L.visionModel.trim();
            if (typeof L.commandModel === 'string') config.ai.commandModel = L.commandModel.trim();
            if (typeof L.analysisIntervalSec === 'number' && L.analysisIntervalSec >= 10) config.ai.analysisIntervalSec = L.analysisIntervalSec;
            if (typeof L.qaModel === 'string') {
              config.voice = config.voice || {}; config.voice.qa = config.voice.qa || {};
              config.voice.qa.model = L.qaModel.trim();
            }
            if (typeof L.asrModel === 'string') {
              config.voiceControl = config.voiceControl || {};
              config.voiceControl.asrModel = L.asrModel.trim();
            }
            if (typeof L.audioModel === 'string') {
              config.audio = config.audio || {};
              config.audio.model = L.audioModel.trim();
            }
          }
          if (patch.homeAssistant) {
            config.homeAssistant = config.homeAssistant || {};
            const H = patch.homeAssistant;
            if (typeof H.url === 'string') config.homeAssistant.url = H.url.trim().replace(/\/$/, '');
            if (typeof H.token === 'string' && !H.token.includes('*')) config.homeAssistant.token = H.token.trim();
          }
          try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2)); }
          catch (e) { console.error('[Settings] persist failed:', e.message); }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, message: '已保存。LLM/HA 配置在下一次调用时生效，无需重启服务。' }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    // Test HA connectivity
    if (pathname === '/api/settings/test/ha' && req.method === 'POST') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', async () => {
        try {
          const p = JSON.parse(body || '{}');
          const url = (p.url || config.homeAssistant?.url || '').replace(/\/$/, '');
          const tokenRaw = p.token && !p.token.includes('*') ? p.token : config.homeAssistant?.token;
          if (!url || !tokenRaw) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ ok: false, error: 'url 或 token 为空' }));
          }
          const t0 = Date.now();
          const resp = await fetch(`${url}/api/states`, {
            headers: { 'Authorization': `Bearer ${tokenRaw}`, 'Content-Type': 'application/json' },
            signal: AbortSignal.timeout(6000)
          });
          const elapsed = Date.now() - t0;
          if (!resp.ok) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ ok: false, status: resp.status, elapsed, error: `HTTP ${resp.status} ${resp.statusText}` }));
          }
          const arr = await resp.json();
          const entityCount = Array.isArray(arr) ? arr.length : 0;
          const domains = new Set();
          if (Array.isArray(arr)) for (const e of arr) { const d = e.entity_id?.split('.')[0]; if (d) domains.add(d); }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, elapsed, entityCount, domainCount: domains.size, sampleDomains: [...domains].slice(0, 8) }));
        } catch (e) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: e.message || String(e) }));
        }
      });
      return;
    }

    // Test LLM API key
    if (pathname === '/api/settings/test/llm' && req.method === 'POST') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', async () => {
        try {
          const p = JSON.parse(body || '{}');
          const baseUrl = (p.baseUrl || config.ai?.baseUrl || '').trim();
          const apiKey = p.apiKey && !p.apiKey.includes('*') ? p.apiKey : config.ai?.apiKey;
          const model = (p.model || config.ai?.commandModel || 'qwen-turbo').trim();
          if (!baseUrl || !apiKey) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ ok: false, error: 'baseUrl 或 apiKey 为空' }));
          }
          // baseUrl 通常以 /chat/completions 结尾；若没有则补
          const endpoint = /\/chat\/completions$/.test(baseUrl) ? baseUrl : `${baseUrl.replace(/\/$/,'')}/chat/completions`;
          const t0 = Date.now();
          const resp = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model,
              messages: [{ role: 'user', content: '回复"ok"' }],
              max_tokens: 4
            }),
            signal: AbortSignal.timeout(8000)
          });
          const elapsed = Date.now() - t0;
          const text = await resp.text();
          if (!resp.ok) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ ok: false, status: resp.status, elapsed, error: text.slice(0, 200) }));
          }
          let parsed; try { parsed = JSON.parse(text); } catch {}
          const reply = parsed?.choices?.[0]?.message?.content || '';
          const usage = parsed?.usage || {};
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, elapsed, model, reply: reply.slice(0, 50), usage }));
        } catch (e) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: e.message || String(e) }));
        }
      });
      return;
    }

    // === Prompts CRUD: GET/PUT 4 关键提示词 ===
    if (pathname === '/api/prompts' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        analysisPrompt: config.ai?.analysisPrompt || '',
        transcribePrompt: config.audio?.transcribePrompt || '',
        asrPrompt: config.voiceControl?.asrPrompt || '',
        qaSystemPrompt: config.voice?.qa?.systemPrompt || '',
        qaFallbackText: config.voice?.qa?.fallbackText || ''
      }));
    }

    if (pathname === '/api/prompts' && req.method === 'PUT') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        try {
          const patch = JSON.parse(body || '{}');
          if (typeof patch.analysisPrompt === 'string') {
            config.ai = config.ai || {};
            config.ai.analysisPrompt = patch.analysisPrompt;
          }
          if (typeof patch.transcribePrompt === 'string') {
            config.audio = config.audio || {};
            config.audio.transcribePrompt = patch.transcribePrompt;
          }
          if (typeof patch.asrPrompt === 'string') {
            config.voiceControl = config.voiceControl || {};
            config.voiceControl.asrPrompt = patch.asrPrompt;
          }
          if (typeof patch.qaSystemPrompt === 'string') {
            config.voice = config.voice || {};
            config.voice.qa = config.voice.qa || {};
            config.voice.qa.systemPrompt = patch.qaSystemPrompt;
          }
          if (typeof patch.qaFallbackText === 'string') {
            config.voice = config.voice || {};
            config.voice.qa = config.voice.qa || {};
            config.voice.qa.fallbackText = patch.qaFallbackText;
          }
          try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2)); }
          catch (e) { console.error('[Prompts] persist failed:', e.message); }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            ok: true,
            analysisPrompt: config.ai?.analysisPrompt || '',
            transcribePrompt: config.audio?.transcribePrompt || '',
            asrPrompt: config.voiceControl?.asrPrompt || '',
            qaSystemPrompt: config.voice?.qa?.systemPrompt || '',
            qaFallbackText: config.voice?.qa?.fallbackText || ''
          }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    if (pathname === '/api/config') {
      const safeConfig = {
        camera: { captureIntervalSec: config.camera.captureIntervalSec },
        ai: { analysisIntervalSec: config.ai.analysisIntervalSec, model: config.ai.model },
        audio: { enabled: config.audio?.enabled !== false, captureIntervalSec: config.audio?.captureIntervalSec || 15 },
        server: config.server,
        rooms: config.rooms || []
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(safeConfig));
    }

    // Execute AI suggestion
    if (pathname === '/api/execute-suggestion' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        try {
          const { action, domain } = JSON.parse(body);
          const result = await processNLCommand(action);
          if (result.understood && result.actions?.length > 0) {
            const states = await haRequest('GET', '/api/states');
            const executed = [];
            let totalMatches = 0;
            for (const a of result.actions) {
              const matches = states.filter(e => {
                const d = e.entity_id.split('.')[0];
                const name = e.attributes?.friendly_name || '';
                return d === a.domain && fuzzyKeywordMatch(name, a.target_keyword || '');
              });
              totalMatches += matches.length;
              for (const entity of matches) {
                const recs = await executeServiceSafe(a, entity);
                executed.push(...recs);
              }
            }
            result.executed = executed;
            const okCount = executed.filter(r => r.ok).length;
            const skippedCount = executed.filter(r => r.skipped).length;
            if (totalMatches === 0) {
              result.reply = `没找到匹配「${result.actions[0].target_keyword || ''}」的设备`;
              result.understood = false;
            } else if (okCount === 0 && skippedCount === 0) {
              result.reply = `找到设备但执行失败`;
              result.understood = false;
            } else {
              const summary = await naturalizeReply(executed, action);
              if (summary) result.reply = summary;
            }
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    // === Static Files ===
    let filePath = pathname === '/' ? '/index-world.html' : pathname;
    filePath = path.join(__dirname, filePath);
    
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath);
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';
      const content = fs.readFileSync(filePath);
      res.writeHead(200, { 'Content-Type': contentType });
      return res.end(content);
    }

    res.writeHead(404);
    res.end('Not Found');
  } catch (e) {
    console.error('[Server] Error:', e.message);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
});

server.listen(PORT, () => {
  console.log(`\n${'='.repeat(50)}`);
  console.log(`  Smart Home AI Control Panel`);
  console.log(`${'='.repeat(50)}`);
  console.log(`  Server:    http://localhost:${PORT}`);
  console.log(`  HA:        ${config.homeAssistant.url}`);
  console.log(`  Camera:    ${config.camera.rtspUrl.replace(/:[^@]+@/, ':***@')}`);
  console.log(`  AI Model:  ${config.ai.model}`);
  if (config.voiceControl?.enabled) {
    console.log(`  Voice:     ENABLED, wake words: ${(config.voiceControl.wakeWords || []).join(', ')}`);
  } else {
    console.log(`  Voice:     disabled (POST /api/voice/start to enable)`);
  }
  console.log(`${'='.repeat(50)}\n`);
  AutomationEngine.load();
  startPeriodicTasks();
  if (config.voiceControl?.enabled) {
    setTimeout(() => VoicePipeline.start(), 1500);
  }
});
