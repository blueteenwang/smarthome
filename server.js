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
const { execSync, execFileSync, execFile, exec, spawn } = require('child_process');
const url = require('url');
const { HomeStateEngine } = require('./lib/home-state');
const { buildAutomationTimeline } = require('./lib/automation-timeline');
const { compileRuleIntent, evaluatePolicy, attachDeviceGuard, bindRuleTarget } = require('./lib/rule-policy');
const { HaRealtimeClient } = require('./lib/ha-realtime');
const { SpaceRegistry, SpatialIntelligence } = require('./lib/spatial-intelligence');
const { DecisionQualityStore } = require('./lib/decision-quality');
const { resolveSecurity, authenticateRequest, corsOrigin } = require('./lib/security-boundary');
const { writeJsonAtomic } = require('./lib/atomic-json');
const { RuntimeLedger } = require('./lib/runtime-ledger');
const { RuleEpisodeGate } = require('./lib/rule-episode-gate');
const { answerHouseholdHistoryQuestion } = require('./lib/home-history-qa');
const { answerDeviceStatusQuestion, parseDeviceStatusQuestion } = require('./lib/device-status-qa');
const { resolveVoiceOutput, VoiceEchoGuard } = require('./lib/voice-output-router');
const { decodeUtf8Body } = require('./lib/utf8-body');
const { AdaptiveVadThreshold } = require('./lib/adaptive-vad');
const { VoiceConversationSession, expandHouseholdFollowUp } = require('./lib/voice-conversation');
const { isVisualQuestion } = require('./lib/visual-question');

// Load config
const CONFIG_PATH = path.join(__dirname, 'config.json');
const ACTIVITY_HISTORY_PATH = path.join(__dirname, 'activity-history.json');
const FACE_DATA_DIR = path.join(__dirname, 'face-data');
const FACE_INDEX_PATH = path.join(FACE_DATA_DIR, 'index.json');
const FACE_HELPER_PATH = path.join(__dirname, '.local', 'bin', 'face-vision');
const FACE_HELPER_SOURCE = path.join(__dirname, 'scripts', 'face-vision.swift');
let config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
config.spaceRegistry = config.spaceRegistry || { bindings: {} };
config.spaceRegistry.environmentSources = config.spaceRegistry.environmentSources || {};

const PORT = config.server.port || 8090;
const SECURITY = resolveSecurity(config);
const SNAPSHOT_DIR = path.join(__dirname, 'snapshots');
const SNAPSHOT_PATH = path.join(SNAPSHOT_DIR, 'latest.jpg');
const HOME_STATE_PATH = path.join(__dirname, 'home-state.json');
const HOME_EVENTS_PATH = path.join(__dirname, 'home-events.json');
const DECISION_QUALITY_PATH = path.join(__dirname, 'decision-quality.json');
const RUNTIME_DATA_DIR = process.env.HOMESENSE_DATA_DIR || process.env.HAVENMIND_DATA_DIR || process.env.NOVA_DATA_DIR || __dirname;
const RUNTIME_LEDGER_PATH = path.join(RUNTIME_DATA_DIR, 'nova-runtime.sqlite');

// The household state core is the stable boundary between unreliable sensor
// observations and automation decisions. Existing features can migrate onto
// it incrementally without changing their public behavior in one release.
const RuntimeStore = new RuntimeLedger(RUNTIME_LEDGER_PATH, { retentionDays: config.privacy?.runtimeRetentionDays || 30 });
const SpatialRegistry = new SpaceRegistry({
  rooms: config.rooms || [],
  bindings: config.spaceRegistry.bindings || {},
  environmentSources: config.spaceRegistry.environmentSources || {}
});
const DecisionQuality = new DecisionQualityStore(DECISION_QUALITY_PATH, { ledger: RuntimeStore });
const SpatialEngine = new SpatialIntelligence({ onCorrection: correction => handleCorrectionSignal(correction) });
let HaRealtime = null;
const HomeState = new HomeStateEngine({
  homeId: config.home?.id || 'home',
  statePath: HOME_STATE_PATH,
  eventsPath: HOME_EVENTS_PATH,
  ledger: RuntimeStore,
  spaceResolver: entity => SpatialRegistry.resolve(entity),
  sourceReliability: (adapter, sourceId) => SpatialEngine.reliabilityFor(adapter, sourceId),
  environmentSource: (spaceId, metric) => SpatialRegistry.environmentSource(spaceId, metric)
});

if (!fs.existsSync(SNAPSHOT_DIR)) fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
if (!fs.existsSync(FACE_DATA_DIR)) fs.mkdirSync(FACE_DATA_DIR, { recursive: true });

function ensureFaceHelper() {
  if (fs.existsSync(FACE_HELPER_PATH)) return true;
  try {
    fs.mkdirSync(path.dirname(FACE_HELPER_PATH), { recursive: true });
    execFileSync('/usr/bin/swiftc', [FACE_HELPER_SOURCE, '-o', FACE_HELPER_PATH, '-framework', 'Vision', '-framework', 'CoreGraphics', '-framework', 'ImageIO'], { timeout: 60000 });
    return true;
  } catch (e) {
    console.error('[Face] Local Vision helper unavailable:', e.message);
    return false;
  }
}
ensureFaceHelper();

// ============ Local Face Identity ============
// Explicit enrollment only. The uploaded image is held in a temporary file,
// converted to an Apple Vision feature print, and immediately deleted.
const FaceIdentity = {
  people: [],
  // Apple Vision feature-print distance. 0.45 tolerates normal camera angle
  // and lighting drift while remaining conservative for household identities.
  threshold: 0.45,
  lastRecognition: null,
  recognitionInFlight: null,
  /**
   * Coalesces historical or concurrently-created records with the same name.
   * A person's stable id remains the oldest record id; every usable feature
   * print is retained as an angle sample.
   */
  mergeSameName(people) {
    const mergedByName = new Map();
    for (const rawPerson of people || []) {
      const person = {
        ...rawPerson,
        samples: Array.isArray(rawPerson.samples) && rawPerson.samples.length
          ? rawPerson.samples
          : [{ id: rawPerson.id, createdAt: rawPerson.createdAt, source: rawPerson.enrolledFrom || 'legacy' }]
      };
      const key = String(person.name || '').trim().toLocaleLowerCase();
      if (!key || !mergedByName.has(key)) {
        if (key) mergedByName.set(key, person);
        continue;
      }
      const existing = mergedByName.get(key);
      const knownSamples = new Set(existing.samples.map(sample => sample.id));
      for (const sample of person.samples) {
        if (!knownSamples.has(sample.id)) existing.samples.push(sample);
      }
      if ((person.createdAt || Infinity) < (existing.createdAt || Infinity)) {
        existing.createdAt = person.createdAt;
      }
    }
    return [...mergedByName.values()];
  },
  load() {
    try {
      this.people = this.mergeSameName(JSON.parse(fs.readFileSync(FACE_INDEX_PATH, 'utf8')).people || []);
      // Persist the migration so all subsequent reads observe one identity per
      // person, including records produced by an older multi-sample build.
      this.save();
    }
    catch { this.people = []; }
  },
  save() {
    this.people = this.mergeSameName(this.people);
    const next = `${FACE_INDEX_PATH}.next`;
    fs.writeFileSync(next, JSON.stringify({ version: 2, people: this.people }, null, 2));
    fs.renameSync(next, FACE_INDEX_PATH);
  },
  safeId() { return `face-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`; },
  extract(imagePath, featurePath) {
    const result = execFileSync(FACE_HELPER_PATH, ['extract', imagePath, featurePath], { encoding: 'utf8', timeout: 15000 });
    return JSON.parse(result);
  },
  extractAsync(imagePath, featurePath) {
    return new Promise((resolve, reject) => {
      execFile(FACE_HELPER_PATH, ['extract', imagePath, featurePath], { encoding: 'utf8', timeout: 10000 }, (error, stdout, stderr) => {
        if (error) {
          error.stderr = stderr;
          return reject(error);
        }
        try { resolve(JSON.parse(stdout)); } catch (e) { reject(e); }
      });
    });
  },
  compareAsync(firstFeaturePath, secondFeaturePath) {
    return new Promise((resolve, reject) => {
      execFile(FACE_HELPER_PATH, ['compare', firstFeaturePath, secondFeaturePath], { encoding: 'utf8', timeout: 5000 }, (error, stdout, stderr) => {
        if (error) {
          error.stderr = stderr;
          return reject(error);
        }
        try { resolve(JSON.parse(stdout)); } catch (e) { reject(e); }
      });
    });
  },
  enroll(name, imageBuffer) {
    const cleanName = String(name || '').trim().slice(0, 40);
    if (!cleanName) throw new Error('请输入姓名');
    if (!Buffer.isBuffer(imageBuffer) || imageBuffer.length < 1000 || imageBuffer.length > 8 * 1024 * 1024) throw new Error('照片大小必须在 1KB–8MB');
    const sampleId = this.safeId(), tempPath = path.join(FACE_DATA_DIR, `${sampleId}.enroll.tmp`), featurePath = path.join(FACE_DATA_DIR, `${sampleId}.faceprint`);
    try {
      fs.writeFileSync(tempPath, imageBuffer);
      this.extract(tempPath, featurePath);
      let person = this.people.find(item => item.name.toLocaleLowerCase() === cleanName.toLocaleLowerCase());
      const sample = { id: sampleId, createdAt: Date.now(), source: 'upload' };
      if (person) person.samples.push(sample);
      else { person = { id: this.safeId(), name: cleanName, createdAt: sample.createdAt, samples: [sample] }; this.people.push(person); }
      this.save(); return { ...person, sampleCount: person.samples.length };
    } finally { try { fs.unlinkSync(tempPath); } catch {} }
  },
  async enrollFromSnapshot(name) {
    const cleanName = String(name || '').trim().slice(0, 40);
    if (!cleanName) throw new Error('请输入姓名');
    if (!fs.existsSync(SNAPSHOT_PATH)) throw new Error('当前没有可用的摄像头画面');
    const sampleId = this.safeId(), featurePath = path.join(FACE_DATA_DIR, `${sampleId}.faceprint`), frozenSnapshot = path.join(FACE_DATA_DIR, `${sampleId}.camera.tmp`);
    try {
      // Freeze one complete frame so the stream cannot replace latest.jpg while
      // Vision is decoding it. Async execution keeps the web UI responsive.
      fs.copyFileSync(SNAPSHOT_PATH, frozenSnapshot);
      await this.extractAsync(frozenSnapshot, featurePath);
      let person = this.people.find(item => item.name.toLocaleLowerCase() === cleanName.toLocaleLowerCase());
      const sample = { id: sampleId, createdAt: Date.now(), source: 'camera' };
      if (person) person.samples.push(sample);
      else { person = { id: this.safeId(), name: cleanName, createdAt: sample.createdAt, samples: [sample] }; this.people.push(person); }
      this.save(); return { ...person, sampleCount: person.samples.length };
    } finally { try { fs.unlinkSync(frozenSnapshot); } catch {} }
  },
  remove(id) {
    const index = this.people.findIndex(p => p.id === id);
    if (index < 0) return false;
    const [person] = this.people.splice(index, 1);
    for (const sample of person.samples || [{ id: person.id }]) {
      try { fs.unlinkSync(path.join(FACE_DATA_DIR, `${sample.id}.faceprint`)); } catch {}
    }
    this.save(); return true;
  },
  recognize(imagePath) {
    if (!this.people.length || !fs.existsSync(imagePath)) return null;
    const probe = path.join(FACE_DATA_DIR, `.probe-${process.pid}.faceprint`);
    try {
      this.extract(imagePath, probe);
      let best = null;
      for (const person of this.people) {
        for (const sample of person.samples || [{ id: person.id }]) try {
          const raw = execFileSync(FACE_HELPER_PATH, ['compare', probe, path.join(FACE_DATA_DIR, `${sample.id}.faceprint`)], { encoding: 'utf8', timeout: 5000 });
          const distance = JSON.parse(raw).distance;
          if (Number.isFinite(distance) && (!best || distance < best.distance)) best = { ...person, sampleId: sample.id, distance };
        } catch {}
      }
      if (!best || best.distance > this.threshold) return { matched: false, distance: best?.distance ?? null };
      return { matched: true, id: best.id, name: best.name, sampleId: best.sampleId, sampleCount: best.samples?.length || 1, distance: best.distance, confidence: Math.max(0, Math.min(1, 1 - best.distance / this.threshold)) };
    } catch { return null; }
    finally { try { fs.unlinkSync(probe); } catch {} }
  },
  async recognizeAsync(imagePath) {
    if (!this.people.length || !fs.existsSync(imagePath)) return null;
    const probeId = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const frozenImage = path.join(FACE_DATA_DIR, `.probe-${probeId}.jpg`);
    const probeFeature = path.join(FACE_DATA_DIR, `.probe-${probeId}.faceprint`);
    try {
      fs.copyFileSync(imagePath, frozenImage);
      await this.extractAsync(frozenImage, probeFeature);
      let best = null;
      for (const person of this.people) {
        for (const sample of person.samples || [{ id: person.id }]) try {
          const result = await this.compareAsync(probeFeature, path.join(FACE_DATA_DIR, `${sample.id}.faceprint`));
          const distance = result.distance;
          if (Number.isFinite(distance) && (!best || distance < best.distance)) best = { ...person, sampleId: sample.id, distance };
        } catch {}
      }
      if (!best || best.distance > this.threshold) return { matched: false, distance: best?.distance ?? null };
      return { matched: true, id: best.id, name: best.name, sampleId: best.sampleId, sampleCount: best.samples?.length || 1, distance: best.distance, confidence: Math.max(0, Math.min(1, 1 - best.distance / this.threshold)) };
    } finally {
      try { fs.unlinkSync(frozenImage); } catch {}
      try { fs.unlinkSync(probeFeature); } catch {}
    }
  },
  refreshRecognition(imagePath) {
    if (this.recognitionInFlight || !this.people.length) return;
    this.recognitionInFlight = this.recognizeAsync(imagePath)
      .then(result => { this.lastRecognition = result; })
      .catch(error => console.warn('[Face] Background recognition failed:', error.message))
      .finally(() => { this.recognitionInFlight = null; });
  }
};
FaceIdentity.load();

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
let snapshotRefreshProcess = null;

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
        // The boot-time compatibility hint may start UDP before the real source
        // dimensions are known. If probing reveals a smaller stream and UDP has
        // not produced a frame, immediately retry the fast TCP profile.
        if (typeof MediaHub !== 'undefined' && next.width < 3000 && MediaHub.currentTransport === 'udp' && MediaHub.videoBytes === 0) {
          MediaHub.transportFallback = 'tcp';
          MediaHub.lastError = '已根据实时码流切换 TCP';
          MediaHub.restart('profile resolved to non-4K source');
        }
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
    console.warn('[Health] 🔧 recovering snapshot pipeline without touching live media');
    if (snapshotDaemon && !snapshotDaemon.killed) {
      try { snapshotDaemon.kill('SIGTERM'); } catch {}
    }
    // Live media owns a separate lifecycle. A stale snapshot result must never
    // kill a newly-established browser stream from the same camera address.
    setTimeout(() => detectStreamProfile().catch(() => {}), 2000);
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
let snapshotDaemonRequested = false;
let snapshotPipeBuffer = Buffer.alloc(0);
let lastSnapshotHealthCheckAt = 0;

function startSnapshotDaemon() {
  if (snapshotDaemon && snapshotDaemon.exitCode === null) return;
  if (isSnapshotRefreshing || (snapshotRefreshProcess && snapshotRefreshProcess.exitCode === null)) {
    snapshotDaemonRequested = true;
    return;
  }
  snapshotDaemonRequested = false;
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
  const highResolutionSource = streamProfile.width ? streamProfile.width >= 3000 : config.camera.forceSnapshotMode === true;
  const rtspTransport = highResolutionSource ? 'udp' : 'tcp';
  const strictSnapshotDecode = rtspTransport === 'tcp' && config.camera.forceSnapshotMode !== true;

  const args = [
    '-hide_banner', '-loglevel', 'error',
    '-fflags', strictSnapshotDecode ? 'genpts+discardcorrupt' : 'genpts',
    ...(strictSnapshotDecode ? ['-err_detect', 'explode'] : []),
    '-rtsp_transport', rtspTransport,
    '-buffer_size', highResolutionSource ? '16777216' : '4194304',
    '-reorder_queue_size', highResolutionSource ? '4096' : '0',
    '-probesize', highResolutionSource ? '16M' : '2M', '-analyzeduration', highResolutionSource ? '4M' : '1M',
    '-rtbufsize', highResolutionSource ? '64M' : '16M', '-max_delay', highResolutionSource ? '3000000' : '0',
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
  console.log(`[Daemon] ✅ started pid=${launchedPid} → ${width}p@${fps}fps q=${qv} transport=${rtspTransport}`);

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
    // MediaHub publishes its own periodic snapshots from the same RTSP ingest.
    // Do not bring up a second decoder while the shared pipeline is healthy.
    if (typeof MediaHub !== 'undefined' && MediaHub.status().running) return;
    // 退避重启：避免 RTSP 频繁重连引起摄像头封禁
    daemonRestartTimer = setTimeout(startSnapshotDaemon, 3000);
  });
}

function stopSnapshotDaemon(reason) {
  if (daemonRestartTimer) { clearTimeout(daemonRestartTimer); daemonRestartTimer = null; }
  if (snapshotDaemon && snapshotDaemon.exitCode === null) {
    const daemonToStop = snapshotDaemon;
    console.log(`[Daemon] 🛑 stopping (${reason})`);
    if (!daemonToStop.killed) {
      try { daemonToStop.kill('SIGTERM'); } catch (_) {}
    }
    const forceTimer = setTimeout(() => {
      if (daemonToStop.exitCode === null) {
        try { daemonToStop.kill('SIGKILL'); } catch {}
      }
    }, 1500);
    forceTimer.unref();
  }
}

function refreshSnapshot() {
  if (typeof MediaHub !== 'undefined' && (MediaHub.status().running || MediaHub.videoClients.size > 0 || MediaHub.audioSubscribers.size > 0 || MediaHub.restartTimer)) return Promise.resolve(true);
  if (snapshotDaemonRequested) return Promise.resolve(false);
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
  return new Promise((resolve) => {
    const ff = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-fflags', 'nobuffer+flush_packets', '-flags', 'low_delay',
      '-rtsp_transport', 'tcp', '-probesize', '200K', '-analyzeduration', '200K',
      '-i', rtspUrl, '-t', '4', '-an',
      '-vf', `scale=${width}:-2:in_range=tv:out_range=pc`,
      '-frames:v', '1', '-update', '1', '-q:v', '5', '-y', SNAPSHOT_PATH
    ], { stdio: ['ignore', 'ignore', 'ignore'] });
    snapshotRefreshProcess = ff;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      if (ff.exitCode === null) try { ff.kill('SIGKILL'); } catch {}
    }, 12000);
    ff.on('close', () => {
      clearTimeout(timeout);
      if (snapshotRefreshProcess !== ff) return resolve(false);
      snapshotRefreshProcess = null;
      isSnapshotRefreshing = false;
      if (snapshotDaemonRequested) {
        snapshotDaemonRequested = false;
        setTimeout(startSnapshotDaemon, 250);
      }
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
        console.log(`[Camera] Snapshot failed: ${timedOut ? 'timeout' : 'no file'}`);
        recordFrameHealth({ ok: false, reason: 'no-output' });
        resolve(false);
      }
    });
    ff.on('error', () => {
      clearTimeout(timeout);
      if (snapshotRefreshProcess === ff) snapshotRefreshProcess = null;
      isSnapshotRefreshing = false;
      resolve(false);
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
          AutomationEngine.updateMatches('audio', parsed?.matched_rules || [], transcript.text);
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
let analysisInFlight = null;
const visionSseClients = new Set();

function broadcastVision(event) {
  const enriched = { ...event, timestamp: Date.now() };
  const payload = `data: ${JSON.stringify(enriched)}\n\n`;
  for (const client of visionSseClients) {
    try { client.write(payload); } catch { visionSseClients.delete(client); }
  }
}

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
      status: Array.isArray(parsed.status) ? parsed.status.slice(0, 8) : [],
      suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions.slice(0, 5).map(item => ({
        action: String(item?.action || '').trim().slice(0, 160),
        domain: String(item?.domain || '').trim().slice(0, 30)
      })).filter(item => item.action) : []
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
  removeFeedback(id) {
    const index = this.data.feedback.findIndex(item => item.id === id);
    if (index < 0) return false;
    this.data.feedback.splice(index, 1);
    this.save();
    return true;
  },
  /** User-authored preferences guide reasoning but never authorize actions. */
  promptFragment() {
    const feedback = this.data.feedback.slice(0, 20).filter(item => item.text);
    if (!feedback.length) return '';
    const lines = feedback.map(item => `- ${item.rating > 0 ? '偏好' : '避免'}：${item.text.slice(0, 180)}`).join('\n');
    return `\n\n【本机家庭偏好】\n${lines}\n这些内容仅用于理解、建议和回复，不构成设备执行授权；不得覆盖用户本次明确指令，也不得自行创建或执行自动化。`;
  },
  /**
   * Mines repeated AI suggestions from recent observations. A candidate is
   * surfaced only after three independent occurrences and remains inert until
   * the user reviews it in the rule editor and explicitly saves it.
   */
  learnedCandidates() {
    const groups = new Map();
    for (const observation of this.data.observations.slice(0, 120)) {
      for (const suggestion of observation.suggestions || []) {
        const normalized = suggestion.action.replace(/[，。！？\s]/g, '').toLowerCase();
        if (!normalized) continue;
        const key = `${suggestion.domain || 'unknown'}:${normalized}`;
        if (!groups.has(key)) groups.set(key, { action: suggestion.action, domain: suggestion.domain, observations: [] });
        groups.get(key).observations.push(observation);
      }
    }
    return [...groups.entries()].filter(([, group]) => group.observations.length >= 3).map(([key, group]) => {
      const evidence = group.observations.slice(0, 12);
      const statusCounts = new Map();
      evidence.flatMap(item => item.status || []).forEach(status => statusCounts.set(status, (statusCounts.get(status) || 0) + 1));
      const commonStatus = [...statusCounts.entries()].filter(([, count]) => count >= Math.ceil(evidence.length * 0.5)).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([status]) => status);
      const hours = evidence.map(item => new Date(item.ts).getHours());
      const averageHour = Math.round(hours.reduce((sum, hour) => sum + hour, 0) / hours.length);
      const condition = commonStatus.length ? `检测到${commonStatus.join('、')}` : `出现与「${evidence[0]?.scene || '当前场景'}」相似的场景`;
      let hash = 2166136261;
      for (const char of key) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
      return {
        id: `learned-${(hash >>> 0).toString(36)}`,
        name: `建议：${group.action.slice(0, 28)}`,
        condition,
        action: group.action,
        domain: group.domain,
        occurrences: group.observations.length,
        confidence: Math.min(95, 55 + group.observations.length * 6),
        typicalHour: averageHour,
        evidence: evidence.slice(0, 3).map(item => ({ ts: item.ts, scene: item.scene }))
      };
    }).sort((a, b) => b.confidence - a.confidence).slice(0, 8);
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
      feedback: this.data.feedback.slice(0, 12),
      learnedCandidates: this.learnedCandidates(),
      learningThreshold: 3
    };
  }
};
MemoryEngine.load();

function handleCorrectionSignal(correction) {
  const quality = DecisionQuality.recordCorrection(correction);
  if (!quality.shouldPause || !quality.item.ruleId) return;
  const rule = AutomationEngine.rules.find(item => item.id === quality.item.ruleId);
  if (!rule || !rule.enabled) return;
  rule.enabled = false;
  rule.pausedReason = `连续检测到 ${quality.correctionCount} 次用户纠正`;
  rule.pausedAt = new Date().toISOString();
  AutomationEngine.save();
  console.warn(`[Automation] Rule "${rule.name}" paused after ${quality.correctionCount} corrections`);
}

// ============ Automation Rules Engine ============
// Rules are evaluated piggyback on existing vision/audio analysis (zero extra LLM calls).
// Matched rules → cooldown check → dry-run guard → processNLCommand → HA execute → SSE broadcast.
function currentAutomationEvidence() {
  const snapshot = HomeState.snapshot();
  return {
    revision: snapshot.revision,
    observedAt: snapshot.observedAt,
    spaces: Object.values(snapshot.spaces || {}).map(space => ({
      id: space.id,
      name: space.name,
      occupancy: space.occupancy?.value,
      confidence: space.occupancy?.confidence
    })),
    people: Object.values(snapshot.people || {}).map(person => ({
      id: person.id,
      name: person.name?.value || person.name,
      confidence: person.identity?.confidence || person.confidence
    })),
    activities: Object.values(snapshot.activities || {}).slice(0, 5).map(activity => ({
      label: activity.label?.value,
      confidence: activity.label?.confidence
    })),
    environment: Object.fromEntries(Object.entries(snapshot.environment || {}).map(([key, value]) => [key, {
      value: value.value,
      unit: value.unit,
      updatedAt: value.updatedAt
    }]))
  };
}

const AutomationEngine = {
  rules: [],
  history: [], // { id, ruleId, name, ts, scene, dryRun, actions, success, reply }
  HISTORY_MAX: 500,
  sseClients: new Set(),
  lastTriggered: new Map(), // ruleId → timestamp
  policyPending: new Map(), // ruleId → sustained-condition timer
  policyActive: new Set(), // structured rules fire once per continuous scene
  matchEpisodes: new RuleEpisodeGate(),

  load() {
    const auto = config.automation || {};
    this.rules = Array.isArray(auto.rules) ? auto.rules : [];
    this.enabled = auto.enabled !== false;
    this.defaultCooldown = auto.defaultCooldownSec || 300;
    try {
      const stored = JSON.parse(fs.readFileSync(ACTIVITY_HISTORY_PATH, 'utf8'));
      this.history = Array.isArray(stored.history) ? stored.history.slice(0, this.HISTORY_MAX) : [];
    } catch (e) {
      this.history = [];
      if (e.code !== 'ENOENT') console.error('[Activity] History load failed:', e.message);
    }
    console.log(`[Automation] Loaded ${this.rules.length} rules, ${this.history.length} historical activities (enabled=${this.enabled})`);
  },

  // Execution history is an append-style local audit trail. Atomic replacement
  // prevents a service interruption from leaving partially written JSON.
  saveHistory() {
    try {
      const nextPath = `${ACTIVITY_HISTORY_PATH}.next`;
      fs.writeFileSync(nextPath, JSON.stringify({ version: 1, updatedAt: Date.now(), history: this.history }, null, 2));
      fs.renameSync(nextPath, ACTIVITY_HISTORY_PATH);
    } catch (e) {
      console.error('[Activity] History save failed:', e.message);
    }
  },

  save() {
    config.automation = config.automation || {};
    config.automation.rules = this.rules;
    config.automation.enabled = this.enabled;
    try {
      // Re-read disk to merge — prevents overwriting concurrent changes (e.g. token rotation)
      const onDisk = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
      onDisk.automation = config.automation;
      writeJsonAtomic(CONFIG_PATH, onDisk);
    } catch (e) {
      console.error('[Automation] Save failed:', e.message);
    }
  },

  /** Add a completed activity from voice, manual control, or automation. */
  recordActivity(entry) {
    const activity = {
      id: entry.id || `evt-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      ts: entry.ts || Date.now(),
      name: entry.name || '系统操作',
      source: entry.source || 'system',
      command: entry.command || '',
      context: entry.context || '',
      executed: Array.isArray(entry.executed) ? entry.executed : [],
      reply: entry.reply || '',
      success: entry.success !== false,
      dryRun: !!entry.dryRun
    };
    this.history.unshift(activity);
    if (this.history.length > this.HISTORY_MAX) this.history.length = this.HISTORY_MAX;
    this.saveHistory();
    this.broadcast({ type: 'activity', ...activity });
    return activity;
  },

  rulesByTrigger(trigger) {
    if (!this.enabled) return [];
    return this.rules.filter(r => r.enabled && !r.policy && (r.trigger === trigger || r.trigger === 'both'));
  },

  /**
   * Re-evaluates structured rules whenever household evidence changes. A
   * sustained timer prevents transient camera/sensor spikes from firing rules.
   */
  handleStateEvent(event) {
    if (!this.enabled || event.type.startsWith('rule.') || event.type.startsWith('command.')) return;
    const snapshot = HomeState.snapshot();
    for (const rule of this.rules.filter(item => item.enabled && item.policy)) {
      const cooldownMs = (rule.cooldownSec || this.defaultCooldown) * 1000;
      if (Date.now() - (this.lastTriggered.get(rule.id) || 0) < cooldownMs) continue;
      const result = evaluatePolicy(rule.policy, snapshot);
      const pending = this.policyPending.get(rule.id);
      if (!result.matched) {
        if (pending?.timer) clearTimeout(pending.timer);
        this.policyPending.delete(rule.id);
        this.policyActive.delete(rule.id);
        continue;
      }
      if (pending || this.policyActive.has(rule.id)) continue;
      const durationMs = Math.max(0, Number(rule.policy.durationSec) || 0) * 1000;
      const timer = setTimeout(() => {
        this.policyPending.delete(rule.id);
        const latest = evaluatePolicy(rule.policy, HomeState.snapshot());
        if (!latest.matched) return;
        this.policyActive.add(rule.id);
        const context = latest.results.map(item => `${item.label || item.kind}（当前 ${item.actual}）`).join('；');
        this.handleMatches([rule.id], context).catch(error => console.error('[Automation] structured rule failed:', error.message));
      }, durationMs);
      timer.unref?.();
      this.policyPending.set(rule.id, { since: Date.now(), timer });
    }
  },

  /** Fires only on entry into a matched scene, not on every analysis frame. */
  updateMatches(trigger, matchedIds, context) {
    const entered = this.matchEpisodes.update(trigger, matchedIds);
    if (entered.length) this.handleMatches(entered, context).catch(error => console.error(`[Automation] ${trigger} scene error:`, error.message));
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
      const correlationId = `rule-run-${now}-${rule.id}-${Math.random().toString(36).slice(2, 6)}`;
      const matched = HomeState.emit({
        type: 'rule.matched',
        correlationId,
        source: { adapter: 'automation', sourceId: rule.id },
        occurredAt: now,
        confidence: 0.7,
        payload: {
          ruleId: rule.id,
          ruleName: rule.name,
          condition: rule.condition,
          context: String(context || '').slice(0, 200),
          evidence: currentAutomationEvidence()
        }
      });
      const cooldownMs = (rule.cooldownSec || this.defaultCooldown) * 1000;
      const last = this.lastTriggered.get(ruleId) || 0;
      if (now - last < cooldownMs) {
        const remainingSec = Math.round((cooldownMs - (now - last)) / 1000);
        console.log(`[Automation] Rule "${rule.name}" matched but in cooldown (${remainingSec}s remaining)`);
        HomeState.emit({
          type: 'rule.cooldown',
          correlationId,
          causationId: matched.id,
          source: { adapter: 'automation', sourceId: rule.id },
          occurredAt: now,
          payload: { ruleId: rule.id, ruleName: rule.name, remainingSec }
        });
        continue;
      }
      this.lastTriggered.set(ruleId, now);
      await this._fireRule(rule, context, correlationId, matched.id);
    }
  },

  async _fireRule(rule, context, correlationId, matchedEventId) {
    const entry = {
      id: correlationId || `evt-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
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
    HomeState.emit({
      type: 'rule.triggered',
      correlationId: entry.id,
      causationId: matchedEventId,
      source: { adapter: 'automation', sourceId: rule.id },
      occurredAt: entry.ts,
      payload: { ruleId: rule.id, ruleName: rule.name, condition: rule.condition, action: rule.action, dryRun: !!rule.dryRun }
    });
    console.log(`[Automation] 🔔 Rule "${rule.name}" fired (dryRun=${rule.dryRun})`);
    this.broadcast({ type: 'fired', ...entry });

    try {
      // Structured observation rules have already been evaluated against the
      // household state. Do not call the command model or resolve devices until
      // the founder explicitly disables dry-run mode.
      if (rule.dryRun && rule.policy) {
        entry.reply = `[观察模式·未执行] ${rule.action}`;
        entry.success = true;
      } else if (rule.policy?.actionTarget) {
        const target = rule.policy.actionTarget;
        const entity = await haRequest('GET', `/api/states/${encodeURIComponent(target.entityId)}`);
        const records = await executeServiceSafe({
          domain: target.domain,
          service: target.service,
          params: {},
          correlationId: entry.id
        }, entity);
        entry.executed.push(...records);
        entry.success = records.length > 0 && records.every(record => record.ok || record.skipped);
        entry.reply = entry.success
          ? `${entity.attributes?.friendly_name || target.entityId}${records.every(record => record.skipped) ? '已是目标状态' : '已执行并验证'}`
          : `执行失败：${records.find(record => !record.ok)?.error || '设备未达到目标状态'}`;
      } else {
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
            action.correlationId = entry.id;
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
          entry.success = entry.executed.length > 0 && entry.executed.every(record => record.ok || record.skipped);
        } else {
          entry.reply = parseResult.reply || '未理解动作';
        }
      }}
    } catch (e) {
      entry.reply = `执行失败: ${e.message}`;
    }

    HomeState.emit({
      type: entry.dryRun ? 'rule.observed' : (entry.success ? 'rule.completed' : 'rule.failed'),
      correlationId: entry.id,
      source: { adapter: 'automation', sourceId: rule.id },
      occurredAt: Date.now(),
      payload: {
        ruleId: rule.id,
        ruleName: rule.name,
        condition: rule.condition,
        action: rule.action,
        reply: entry.reply,
        executedCount: entry.executed.length,
        error: entry.success || entry.dryRun ? undefined : entry.reply
      }
    });

    this.recordActivity({ ...entry, source: 'automation' });

    // Broadcast reply through Xiaoai speaker (skip dryRun observation runs to avoid noise)
    if (entry.success && !entry.dryRun && entry.reply) {
      speakReply(entry.reply, 'ruleTrigger', { origin: 'automation' });
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
      dryRun: rule.policy ? true : rule.dryRun !== false,  // generated policies always start in observation mode
      ...(rule.policy ? { policy: rule.policy } : {}),
      ...(rule.explanation ? { explanation: rule.explanation } : {}),
      createdAt: rule.createdAt || new Date().toISOString()
    };
    this.rules.push(r);
    this.save();
    return r;
  },

  update(id, patch) {
    const idx = this.rules.findIndex(r => r.id === id);
    if (idx === -1) return null;
    const current = this.rules[idx];
    if (patch.dryRun === false && current.policy && current.explanation?.requiresTargetConfirmation) {
      throw new Error('存在多个候选设备，确认具体目标前不能授权自动执行');
    }
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

function analyzeSnapshotOnce() {
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
    // Use the latest completed local result in the prompt and refresh it in the
    // background. Apple Vision must never block camera, voice, or web requests.
    const localIdentity = FaceIdentity.lastRecognition;
    FaceIdentity.refreshRecognition(SNAPSHOT_PATH);
    const identityPrompt = localIdentity?.matched
      ? `\n\n本机人脸识别结果：画面中面积最大的人脸是「${localIdentity.name}」（本地置信度 ${Math.round(localIdentity.confidence * 100)}%）。请结合画面描述此人正在做什么，并用该姓名评估规则；不得推断其他人的身份。`
      : '\n\n本机未确认画面人物身份。不得根据外貌猜测姓名。';
    const prompt = basePrompt + identityPrompt + MemoryEngine.promptFragment() + AutomationEngine.promptFragment('vision');

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
          if (res.statusCode < 200 || res.statusCode >= 300) {
            throw new Error(`Vision API HTTP ${res.statusCode}: ${data.slice(0, 160)}`);
          }
          const result = JSON.parse(data);
          TokenUsage.recordFromResponse(config.ai.model || 'qwen-vl-plus', 'vision_analyze', result);
          const content = result.choices?.[0]?.message?.content || '';
          if (!content) throw new Error('Vision API returned no content');
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
          HomeState.ingestVision(parsed, FaceIdentity.lastRecognition, lastAnalysis.timestamp);
          broadcastVision({ type: 'complete', analysis: lastAnalysis });
          MemoryEngine.recordObservation(parsed);
          console.log(`[AI] Analysis complete: ${parsed?.scene || content.slice(0, 50)}`);
          // Fire automation rules that matched
          AutomationEngine.updateMatches('vision', parsed?.matched_rules || [], parsed?.scene || content.slice(0, 200));
          resolve(lastAnalysis);
        } catch (e) {
          reject(e);
        }
      });
    });

    req.setTimeout(30000, () => req.destroy(new Error('Vision API timeout')));
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

/**
 * Runs at most one vision-model request at a time. Concurrent triggers share
 * the same promise so manual requests, motion events and heartbeat analysis do
 * not multiply model cost or race to overwrite the newest result.
 */
function analyzeSnapshot(reason = 'manual') {
  if (analysisInFlight) return analysisInFlight;
  broadcastVision({ type: 'analyzing', reason });
  analysisInFlight = analyzeSnapshotOnce()
    .catch(error => {
      broadcastVision({ type: 'error', reason, error: error.message });
      throw error;
    })
    .finally(() => { analysisInFlight = null; });
  return analysisInFlight;
}

function readVisualFingerprint() {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(SNAPSHOT_PATH)) return reject(new Error('No snapshot available'));
    const ff = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-i', SNAPSHOT_PATH,
      '-vf', 'scale=16:16', '-pix_fmt', 'gray', '-f', 'rawvideo', 'pipe:1'
    ], { stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks = [];
    ff.stdout.on('data', chunk => chunks.push(chunk));
    ff.on('error', reject);
    ff.on('close', code => {
      const pixels = Buffer.concat(chunks);
      if (code !== 0 || pixels.length < 256) return reject(new Error('snapshot fingerprint failed'));
      resolve(pixels.subarray(0, 256));
    });
  });
}

function visualDifference(previous, next) {
  if (!previous || previous.length !== next.length) return 1;
  let total = 0;
  for (let i = 0; i < next.length; i++) total += Math.abs(next[i] - previous[i]);
  return total / (next.length * 255);
}

// ============ Home Assistant Proxy ============
/**
 * Builds a Home Assistant request using the protocol configured in its URL.
 * HA is commonly exposed through an HTTPS reverse proxy on a non-standard port;
 * sending plain HTTP to that endpoint returns an nginx error page that must not
 * be mistaken for a valid HA API response.
 */
function buildHaRequest(apiPath, extra = {}) {
  const haUrl = new URL(config.homeAssistant.url);
  const transport = haUrl.protocol === 'https:' ? https : http;
  const basePath = haUrl.pathname.replace(/\/$/, '');
  return {
    transport,
    options: {
      hostname: haUrl.hostname,
      port: haUrl.port || (haUrl.protocol === 'https:' ? 443 : 8123),
      path: `${basePath}${apiPath}`,
      headers: {
        'Authorization': `Bearer ${config.homeAssistant.token}`,
        'Content-Type': 'application/json'
      },
      ...extra
    }
  };
}

function haRequest(method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const { transport, options } = buildHaRequest(apiPath, { method, timeout: 8000 });

    const req = transport.request(options, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const data = decodeUtf8Body(chunks);
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`HA HTTP ${res.statusCode}: ${data.slice(0, 160)}`));
        }
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          resolve(data);
        }
      });
    });

    req.on('timeout', () => req.destroy(new Error('HA request timeout')));
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

/** Start the low-latency HA event channel; REST sampling remains a fallback. */
function startHaRealtime() {
  try { HaRealtime?.stop(); } catch {}
  HaRealtime = new HaRealtimeClient({
    url: config.homeAssistant.url,
    token: config.homeAssistant.token,
    onStateChanged: (entity, occurredAt) => HomeState.ingestHaStates([entity], occurredAt),
    onStatus: status => {
      if (status.error && status.retryCount <= 1) console.warn('[HA Realtime]', status.error);
    }
  });
  try { HaRealtime.start(); }
  catch (error) { console.warn('[HA Realtime] unavailable, REST fallback active:', error.message); }
}

function haBinaryRequest(apiPath) {
  return new Promise((resolve, reject) => {
    const { transport, options } = buildHaRequest(apiPath, { method: 'GET', timeout: 5000 });
    const req = transport.request(options, res => {
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
  const { transport, options } = buildHaRequest(
    `/api/camera_proxy_stream/${encodeURIComponent(entity)}`,
    { method: 'GET', timeout: 10000 }
  );
  const upstream = transport.request(options, cameraRes => {
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
function currentCommandContext() {
  const household = HomeState.snapshot();
  const spatial = SpatialEngine.snapshot(household);
  const active = spatial.contexts.filter(item => ['entering', 'active', 'working', 'dining', 'watching'].includes(item.state));
  if (active.length !== 1) return '\n\n【当前空间上下文】当前无法唯一确定用户所在空间；含糊指令必须询问房间，不得猜测。';
  const context = active[0];
  const space = household.spaces?.[context.spaceId] || {};
  const environment = Object.entries(space.environment || {}).map(([key, value]) => `${key}=${value.value}${value.unit || ''}`).join('，');
  return `\n\n【当前空间上下文】可靠判断用户当前在${context.spaceName}，情境为${context.state}${environment ? `，环境：${environment}` : ''}。用户说“有点暗、太热、别这么亮、还是刚才那样”等含糊表达时，优先作用于该空间；如果状态 uncertain 或存在多个有人空间，必须询问，不能猜测。`;
}
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
reply 要符合 actions 实际效果——如果你输出了 turn_on(cool)+set_temperature，就说"已为您打开客厅空调制冷至24度"。不要说没做的事。${MemoryEngine.promptFragment()}${currentCommandContext()}`
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

// Conservative keyword → entity friendly_name matching.
// Device control must require one continuous phrase. The former 2-character
// fallback made "小米网关" match every device containing "小米", causing a
// single spoken command to operate unrelated switches and indicator lights.
function fuzzyKeywordMatch(name, keyword) {
  if (!keyword || !name) return false;
  if (name.includes(keyword)) return true;
  // Only remove conversational determiners. Product-name characters such as
  // "小" in "小米" are meaningful and must never be stripped.
  const stripped = keyword.replace(/^(那个|这个|这台|那台|这个设备|那个设备)/, '');
  if (stripped && stripped !== keyword && name.includes(stripped)) return true;
  return false;
}

async function executeServiceSafeRaw(action, entity) {
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

function actionReachedState(record, entity) {
  if (!record?.ok || !entity) return false;
  const state = entity.state;
  const attrs = entity.attributes || {};
  if (record.service === 'turn_on') return !['off', 'unavailable', 'unknown'].includes(state);
  if (record.service === 'turn_off') return state === 'off';
  if (record.service === 'open_cover') return state === 'open' || attrs.current_position === 100;
  if (record.service === 'close_cover') return state === 'closed' || attrs.current_position === 0;
  if (record.service === 'set_hvac_mode') return state === record.detail;
  if (record.service === 'set_temperature') {
    const target = Number(String(record.detail || '').replace('°', ''));
    return Number.isFinite(target) && Number.isFinite(Number(attrs.temperature)) && Math.abs(Number(attrs.temperature) - target) < 0.5;
  }
  if (record.service === 'set_fan_mode') return attrs.fan_mode === record.detail;
  // Some service domains have no immediate, deterministic state projection.
  // HA acceptance remains observable but is explicitly marked unverified.
  return null;
}

async function verifyActionRecord(record) {
  if (!record?.ok || !record.entity_id) return { verified: false, entity: null };
  const startedAt = Date.now();
  let attempts = 0;
  // Slow Zigbee/Wi-Fi devices often update HA after more than one second.
  // Polling is bounded and never re-sends the physical command.
  for (const delayMs of [250, 750, 1500, 2500]) {
    await new Promise(resolve => setTimeout(resolve, delayMs));
    attempts += 1;
    try {
      const entity = await haRequest('GET', `/api/states/${encodeURIComponent(record.entity_id)}`);
      const reached = actionReachedState(record, entity);
      HomeState.ingestHaStates([entity], Date.now());
      if (reached === true) return { verified: true, entity, attempts, elapsedMs: Date.now() - startedAt };
      if (reached === null) return { verified: null, entity, attempts, elapsedMs: Date.now() - startedAt };
    } catch {}
  }
  return { verified: false, entity: null, attempts, elapsedMs: Date.now() - startedAt };
}

/**
 * Executes one entity action and records the complete request → dispatch →
 * verification lifecycle in the household event stream.
 */
async function executeServiceSafe(action, entity) {
  const correlationId = action.correlationId || `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const baseEvent = {
    correlationId,
    source: { adapter: 'system', sourceId: 'action-executor' },
    payload: {
      entityId: entity.entity_id,
      name: entity.attributes?.friendly_name || entity.entity_id,
      domain: action.domain,
      service: action.service,
      params: action.params || {},
      previousState: entity.state
    }
  };
  const requested = HomeState.emit({ ...baseEvent, type: 'command.requested' });
  const records = await executeServiceSafeRaw(action, entity);

  for (const record of records) {
    if (record.skipped) {
      HomeState.emit({ ...baseEvent, type: 'command.skipped', causationId: requested.id, payload: { ...baseEvent.payload, reason: record.reason } });
      continue;
    }
    if (!record.ok) {
      HomeState.emit({ ...baseEvent, type: 'command.failed', causationId: requested.id, payload: { ...baseEvent.payload, error: record.error || 'dispatch failed' } });
      continue;
    }

    const dispatched = HomeState.emit({
      ...baseEvent,
      type: 'command.dispatched',
      causationId: requested.id,
      payload: { ...baseEvent.payload, effectiveService: record.service, detail: record.detail || '' }
    });
    HomeState.emit({
      ...baseEvent,
      type: 'command.verifying',
      causationId: dispatched.id,
      payload: { ...baseEvent.payload, effectiveService: record.service }
    });
    const verification = await verifyActionRecord(record);
    record.verified = verification.verified;
    if (verification.verified === false) {
      record.ok = false;
      record.error = '设备状态未达到目标';
      HomeState.emit({
        ...baseEvent,
        type: 'command.failed',
        causationId: dispatched.id,
        payload: { ...baseEvent.payload, effectiveService: record.service, error: record.error, verificationAttempts: verification.attempts, verificationElapsedMs: verification.elapsedMs }
      });
    } else {
      HomeState.emit({
        ...baseEvent,
        type: verification.verified === true ? 'command.verified' : 'command.accepted_unverified',
        causationId: dispatched.id,
        payload: {
          ...baseEvent.payload,
          effectiveService: record.service,
          verified: verification.verified,
          resultingState: verification.entity?.state,
          verificationAttempts: verification.attempts,
          verificationElapsedMs: verification.elapsedMs
        }
      });
    }
  }
  return records;
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
    // Light state reported by some Xiaomi gateway integrations can remain stale
    // after a physical/app-side change. HA turn_on/turn_off are idempotent, so
    // always send them instead of allowing cached state to suppress a real
    // automation action. Brightness/color operations already require a call.
    if (service === 'turn_on' || service === 'turn_off') return { skip: false };
  }

  // Climate integrations can expose a stale `off` state while the physical
  // appliance is still running. `turn_off` is itself idempotent, so an explicit
  // user shutdown must always be dispatched instead of trusting cached state.
  if (domain === 'climate') {
    if (service === 'turn_off') return { skip: false };
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
    HomeState.ingestHaStates(states, Date.now());

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
  const householdAnswer = answerHouseholdHistoryQuestion({
    text,
    rooms: config.rooms || [],
    ledger: RuntimeStore,
    currentState: HomeState.snapshot()
  });
  if (householdAnswer) return householdAnswer;
  const weatherZh = { clear: '晴', sunny: '晴', partlycloudy: '多云间晴', cloudy: '多云', fog: '有雾', rainy: '有雨', pouring: '大雨', lightning: '雷雨', lightning_rainy: '雷阵雨', snowy: '有雪', snowy_rainy: '雨夹雪', windy: '有风', windy_variant: '大风', hail: '冰雹', exceptional: '异常天气' };
  try {
    const deviceStatusQuery = parseDeviceStatusQuestion(text, config.rooms || []);
    if (deviceStatusQuery) {
      const states = await haRequest('GET', '/api/states');
      return answerDeviceStatusQuestion({ text, states, rooms: config.rooms || [] });
    }
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

/**
 * Answers a read-only question from the latest camera frame. The prompt makes
 * absence explicitly frame-scoped: not seeing an object is not proof that the
 * object is absent from the whole room or outside the camera field of view.
 */
function answerVisualQuestion(command) {
  return new Promise((resolve) => {
    if (!isVisualQuestion(command)) return resolve(null);
    if (!fs.existsSync(SNAPSHOT_PATH)) {
      return resolve({ ok: false, reply: '当前没有可用的摄像头画面，暂时无法确认。', source: 'visual_snapshot' });
    }
    let imageBase64;
    let capturedAt;
    try {
      const stat = fs.statSync(SNAPSHOT_PATH);
      imageBase64 = fs.readFileSync(SNAPSHOT_PATH).toString('base64');
      capturedAt = stat.mtimeMs;
    } catch {
      return resolve({ ok: false, reply: '读取摄像头画面失败，暂时无法确认。', source: 'visual_snapshot' });
    }

    const prompt = `你是知家 家庭视觉问答助手。请只根据这张最新摄像头画面回答用户问题：“${String(command).slice(0, 120)}”。
规则：
1. 只描述画面中可见事实，不使用常识猜测，不虚构摄像头外的信息。
2. 如果看见目标，回答“当前画面中看到了……”并简述位置。
3. 如果没看见目标，只能回答“当前画面中没有看到……”，不得声称整个房间一定没有。
4. 如果画面不是用户询问的房间、目标被遮挡或画面不清晰，明确回答无法确认。
5. 不识别或猜测未录入人员身份，不执行任何设备操作。
6. 使用一句自然中文回答，不超过45字，不要 Markdown。`;
    const payload = JSON.stringify({
      model: config.ai.model || 'qwen-vl-plus',
      messages: [{ role: 'user', content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageBase64}` } }
      ] }],
      max_tokens: 100,
      temperature: 0.1
    });
    const apiUrl = new URL(config.ai.baseUrl);
    const req = https.request({
      hostname: apiUrl.hostname,
      port: apiUrl.port || 443,
      path: apiUrl.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.ai.apiKey}`,
        'Content-Length': Buffer.byteLength(payload)
      },
      timeout: 12_000
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          if (res.statusCode < 200 || res.statusCode >= 300) throw new Error(`HTTP ${res.statusCode}`);
          const parsed = JSON.parse(data);
          TokenUsage.recordFromResponse(config.ai.model || 'qwen-vl-plus', 'visual_qa', parsed);
          const reply = String(parsed.choices?.[0]?.message?.content || '').replace(/[\r\n]+/g, ' ').trim();
          if (!reply) throw new Error('empty reply');
          console.log(`[Visual QA] "${command}" → "${reply}"`);
          resolve({ ok: true, reply, source: 'visual_snapshot', capturedAt });
        } catch (error) {
          console.error('[Visual QA] failed:', error.message);
          resolve({ ok: false, reply: '视觉分析暂时失败，请稍后再问一次。', source: 'visual_snapshot' });
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', error => {
      console.error('[Visual QA] request failed:', error.message);
      resolve({ ok: false, reply: '视觉分析暂时失败，请稍后再问一次。', source: 'visual_snapshot' });
    });
    req.write(payload);
    req.end();
  });
}

function chitchatLLM(command, conversationMessages = []) {
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
        { role: 'system', content: `${systemPrompt}\n你正在与用户连续对话。可以结合最近对话理解“那卧室呢”“为什么”等追问，但不得虚构家庭状态或声称执行了设备操作。` },
        ...conversationMessages.slice(-16),
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
const conversationConfig = config.voiceControl?.conversation || {};
const VoiceConversation = new VoiceConversationSession({
  enabled: conversationConfig.enabled !== false,
  idleTimeoutMs: (conversationConfig.idleTimeoutSec || 60) * 1000,
  maxTurns: conversationConfig.maxTurns || 8
});

const MediaHub = {
  ff: null,
  videoClients: new Set(),
  backpressuredVideoClients: new WeakSet(),
  audioSubscribers: new Set(),
  jpegBuffer: Buffer.alloc(0),
  restartTimer: null,
  lastSnapshotPublish: 0,
  videoBytes: 0,
  lastVideoAt: 0,
  ffStartedAt: 0,
  watchdogTimer: null,
  audioBytes: 0,
  audioUnavailable: false,
  lastError: null,
  transportFallback: null,
  currentTransport: null,
  corruptFrames: 0,
  lastCorruptFrameAt: 0,
  boundary: 'novahubframe',

  ensureStarted() {
    if (this.ff && this.ff.exitCode === null) return;
    // Some NVRs allow only one active media delivery session per RTSP URL.
    // Wait for the snapshot daemon's TEARDOWN to reach the server before
    // opening the shared live session, otherwise the new connection may
    // complete RTSP negotiation but receive zero RTP packets.
    if (snapshotDaemon && snapshotDaemon.exitCode === null) {
      stopSnapshotDaemon('shared media hub waiting for RTSP handoff');
      if (this.restartTimer) clearTimeout(this.restartTimer);
      this.restartTimer = setTimeout(() => { this.restartTimer = null; this.ensureStarted(); }, 1500);
      return;
    }
    stopSnapshotDaemon('shared media hub starting');
    if (snapshotRefreshProcess && !snapshotRefreshProcess.killed) {
      try { snapshotRefreshProcess.kill('SIGKILL'); } catch {}
      snapshotRefreshProcess = null;
      isSnapshotRefreshing = false;
    }
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null; }
    this.corruptFrames = 0;
    this.lastCorruptFrameAt = 0;
    if (!this.audioUnavailable) this.lastError = null;
    // The dashboard preview favours immediate interaction over surveillance
    // recording quality. Large MJPEG frames plus animated glass UI saturate
    // Chromium's compositor and make the whole home view feel sluggish.
    const width = Math.min(config.camera.streamWidth || 960, 960);
    const fps = Math.max(2, Math.min(config.camera.streamFps || 10, 22));
    const includeAudio = this.audioSubscribers.size > 0 && !this.audioUnavailable;
    // forceSnapshotMode is also a persisted compatibility hint, so the first
    // client after boot gets the safe transport even before ffprobe completes.
    const highResolutionSource = streamProfile.width ? streamProfile.width >= 3000 : config.camera.forceSnapshotMode === true;
    // Synology-style relays can corrupt large H.264 access units only on RTSP
    // interleaved TCP. A large UDP reorder/receive buffer produced complete 4K
    // frames in compatibility probing; smaller streams keep TCP reliability.
    const rtspTransport = this.transportFallback || (highResolutionSource ? 'udp' : 'tcp');
    this.currentTransport = rtspTransport;
    const strictTcpDecode = rtspTransport === 'tcp' && !this.transportFallback && config.camera.forceSnapshotMode !== true;
    const args = [
      '-hide_banner', '-loglevel', 'warning',
      // Use one stable TCP session for both tracks. Some cameras either reject
      // or starve a second RTSP session, which previously made video and voice
      // compete whenever camera-microphone listening was enabled.
      '-fflags', strictTcpDecode ? 'genpts+discardcorrupt' : 'genpts',
      // A damaged predicted frame must be dropped, not concealed and emitted
      // as a striped JPEG. This is especially important for 4K NVR relays,
      // where one missing H.264 reference slice can visually poison many
      // following frames until the next IDR.
      ...(strictTcpDecode ? ['-err_detect', 'explode'] : []),
      '-probesize', rtspTransport === 'udp' && highResolutionSource ? '8000000' : '2000000',
      '-analyzeduration', rtspTransport === 'udp' && highResolutionSource ? '2000000' : '1000000',
      '-rtsp_transport', rtspTransport,
      ...(rtspTransport === 'tcp' ? ['-rtsp_flags', 'prefer_tcp'] : []),
      '-buffer_size', highResolutionSource ? '16777216' : '4194304',
      '-reorder_queue_size', rtspTransport === 'udp' ? '4096' : '0',
      '-rtbufsize', rtspTransport === 'udp' && highResolutionSource ? '64M' : '16M',
      '-max_delay', rtspTransport === 'udp' ? '3000000' : '1000000',
      '-i', config.camera.rtspUrl,
      '-map', '0:v:0', '-an',
      '-vf', `scale=${width}:-2:in_range=tv:out_range=pc,fps=${fps}:round=zero,format=yuvj420p`,
      '-q:v', '7', '-threads', '2', '-fps_mode', 'cfr', '-flush_packets', '1',
      '-f', 'mpjpeg', '-boundary_tag', this.boundary, 'pipe:1',
      // A separate child-process fd carries raw mono PCM while retaining the
      // same RTSP input session. The optional map keeps video usable on cameras
      // that expose no audio track.
      ...(includeAudio ? [
        '-map', '0:a:0?', '-vn', '-acodec', 'pcm_s16le', '-ar', '16000', '-ac', '1',
        '-fflags', 'nobuffer', '-flush_packets', '1', '-f', 's16le', 'pipe:3'
      ] : [])
    ];
    this.jpegBuffer = Buffer.alloc(0);
    this.lastVideoAt = Date.now();
    this.ffStartedAt = Date.now();
    this.videoBytes = 0;
    this.ff = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
    const pid = this.ff.pid;
    console.log(`[MediaHub] ✅ single RTSP ingest pid=${pid}, video=${width}p@${fps}fps transport=${rtspTransport}${includeAudio ? ' + audio=16kHz' : ' (video-only fallback)'}`);
    this.ff.stdout.on('data', chunk => {
      this.videoBytes += chunk.length;
      this.lastVideoAt = Date.now();
      this.jpegBuffer = Buffer.concat([this.jpegBuffer, chunk]);
      while (true) {
        const soi = this.jpegBuffer.indexOf(Buffer.from([0xff, 0xd8]));
        if (soi < 0) { if (this.jpegBuffer.length > 1024) this.jpegBuffer = Buffer.alloc(0); break; }
        const eoi = this.jpegBuffer.indexOf(Buffer.from([0xff, 0xd9]), soi + 2);
        if (eoi < 0) { if (soi > 0) this.jpegBuffer = this.jpegBuffer.subarray(soi); break; }
        const jpeg = this.jpegBuffer.subarray(soi, eoi + 2);
        this.jpegBuffer = this.jpegBuffer.subarray(eoi + 2);
        // Fan out complete JPEGs rather than arbitrary ffmpeg stdout chunks.
        // When a browser is briefly slow, skip whole stale frames until its
        // socket drains; it then resumes from the newest frame with no backlog.
        const partHeader = Buffer.from(`--${this.boundary}\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`);
        for (const client of this.videoClients) {
          if (this.backpressuredVideoClients.has(client)) continue;
          try {
            let writable = true;
            writable = client.write(partHeader) && writable;
            writable = client.write(jpeg) && writable;
            writable = client.write('\r\n') && writable;
            if (!writable) {
              this.backpressuredVideoClients.add(client);
              client.once('drain', () => this.backpressuredVideoClients.delete(client));
            }
          } catch (e) { this.videoClients.delete(client); }
        }
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
    if (includeAudio) this.ff.stdio[3].on('data', chunk => {
      this.audioBytes += chunk.length;
      for (const subscriber of this.audioSubscribers) {
        try { subscriber(chunk); } catch (e) { this.audioSubscribers.delete(subscriber); }
      }
    });
    let ffmpegError = '';
    this.ff.stderr.on('data', d => {
      const s = d.toString().trim();
      ffmpegError = `${ffmpegError}\n${s}`.slice(-4000);
      const corruptSignals = s.match(/corrupt|missing reference|decode_slice_header|Invalid data found|missed \d+ packets/gi);
      if (corruptSignals) {
        this.corruptFrames += corruptSignals.length;
        this.lastCorruptFrameAt = Date.now();
        this.lastError = '检测到源流损坏帧，已自动丢弃并保持画面完整';
      }
      if (s && this.videoBytes === 0) console.error('[MediaHub/ffmpeg]', s.slice(0, 1600));
    });
    this.ff.on('exit', (code, signal) => {
      if (this.ff?.pid !== pid) return;
      this.ff = null;
      console.warn(`[MediaHub] exited code=${code} signal=${signal}`);
      if (includeAudio && /Error while opening decoder|AudioToolbox init error|Error opening output file pipe:3/i.test(ffmpegError)) {
        this.audioUnavailable = true;
        this.lastError = '摄像头 AAC 音轨无法解码，已自动保持视频并暂停摄像头语音';
        if (typeof VoicePipeline !== 'undefined') VoicePipeline.onSharedAudioUnavailable(this.lastError);
      }
      if (this.videoClients.size || this.audioSubscribers.size) {
        this.restartTimer = setTimeout(() => this.ensureStarted(), 1500);
      } else if (!daemonRestartTimer) {
        // Snapshot compatibility mode needs a continuously advancing local
        // frame source after the live client disconnects. Hand ownership back
        // only after this FFmpeg process has fully exited.
        daemonRestartTimer = setTimeout(() => {
          daemonRestartTimer = null;
          startSnapshotDaemon();
        }, 1500);
      }
    });
    if (!this.watchdogTimer) {
      this.watchdogTimer = setInterval(() => {
        const hasConsumers = this.videoClients.size > 0 || this.audioSubscribers.size > 0;
        // High-resolution RTSP relays may need several seconds to negotiate and
        // deliver the first complete IDR. Once video has flowed, return to the
        // short watchdog window so genuine stalls still recover quickly.
        const startupGraceMs = 30000;
        const stallLimitMs = this.videoBytes > 0 ? 6000 : startupGraceMs;
        const stalled = this.ff && this.ff.exitCode === null && !this.ff.killed && Date.now() - this.lastVideoAt > stallLimitMs;
        if (hasConsumers && stalled) {
          if (this.videoBytes === 0 && this.currentTransport === 'udp') {
            this.transportFallback = 'tcp';
            this.lastError = 'UDP 未收到媒体数据，已自动切换 TCP';
          }
          this.restart(`no video data for ${Math.round((Date.now() - this.lastVideoAt) / 1000)}s`);
        }
      }, 2000);
    }
  },
  addVideoClient(res) { this.videoClients.add(res); this.ensureStarted(); },
  /** Ends FFmpeg cleanly so its RTSP demuxer can send TEARDOWN. */
  stopProcess(reason) {
    const processToStop = this.ff;
    if (!processToStop || processToStop.exitCode !== null) return;
    if (processToStop.killed) return;
    console.log(`[MediaHub] stopping gracefully (${reason})`);
    try { processToStop.kill('SIGTERM'); } catch { return; }
    const forceTimer = setTimeout(() => {
      if (processToStop.exitCode === null) {
        try { processToStop.kill('SIGKILL'); } catch {}
      }
    }, 1500);
    forceTimer.unref();
  },
  removeVideoClient(res) {
    this.videoClients.delete(res);
    if (!this.videoClients.size && !this.audioSubscribers.size && this.ff && this.ff.exitCode === null) {
      this.stopProcess('last consumer disconnected');
    }
  },
  subscribeAudio(fn) { this.audioSubscribers.add(fn); this.ensureStarted(); },
  unsubscribeAudio(fn) { this.audioSubscribers.delete(fn); },
  status() { const running = !!(this.ff && this.ff.exitCode === null), stopping = running && this.ff.killed, videoAgeMs = this.lastVideoAt ? Date.now() - this.lastVideoAt : null, highResolutionSource = streamProfile.width ? streamProfile.width >= 3000 : config.camera.forceSnapshotMode === true; return { running, stopping, healthy: running && !stopping && videoAgeMs !== null && (this.videoBytes > 0 ? videoAgeMs < 6000 : Date.now() - this.ffStartedAt < 30000), starting: running && !stopping && this.videoBytes === 0, pid: this.ff?.pid || null, videoClients: this.videoClients.size, audioSubscribers: this.audioSubscribers.size, videoBytes: this.videoBytes, videoAgeMs, audioBytes: this.audioBytes, previewFps: Math.max(2, Math.min(config.camera.streamFps || 10, 22)), previewWidth: Math.min(config.camera.streamWidth || 960, 960), sourceWidth: streamProfile.width, sourceHeight: streamProfile.height, sourceCodec: streamProfile.codec, rtspTransport: this.currentTransport || this.transportFallback || (highResolutionSource ? 'udp' : 'tcp'), corruptFrames: this.corruptFrames, lastCorruptFrameAt: this.lastCorruptFrameAt || null, audioUnavailable: this.audioUnavailable, lastError: this.lastError }; },
  restart(reason) {
    if (!this.ff || this.ff.exitCode !== null || this.ff.killed) return;
    console.log(`[MediaHub] restarting (${reason})`);
    this.stopProcess(reason);
  }
};

const VoicePipeline = {
  ff: null,                  // ffmpeg child process
  mediaAudioHandler: null,   // subscription callback for shared RTSP ingest
  audioLeftover: Buffer.alloc(0),
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
  lastError: null,
  wakeArmedUntil: 0,       // wake word spoken alone → accept the next utterance briefly
  echoGuard: new VoiceEchoGuard(500),
  adaptiveVad: null,
  currentRms: 0,
  peakRms: 0,
  maxRmsSeen: 0,
  audioFramesReceived: 0,
  lastAudioFrameAt: 0,

  start(source, _isAutoRestart) {
    if (this.running) return false;
    const cfg = config.voiceControl;
    if (!cfg) return false;

    // Reset restart counter on user-initiated start (not on auto-restart chain)
    if (!_isAutoRestart) this.restartAttempts = 0;

    // Determine audio source
    if (source) this.audioSource = source;
    else if (!this.audioSource) this.audioSource = cfg.audioSource || 'rtsp';
    if (this.audioSource === 'rtsp' && MediaHub.audioUnavailable) {
      this.lastError = MediaHub.lastError || '摄像头音轨当前不可用';
      this.broadcast({ type: 'error', message: this.lastError });
      return false;
    }
    this.lastError = null;

    // VAD frame size: 100 ms @ 16kHz mono s16le = 1600 samples = 3200 bytes
    this.frameMs = 100;
    this.bytesPerFrame = 16 * 2 * this.frameMs; // 3200
    this.thrOn = cfg.vad?.energyThresholdOn ?? 0.018;
    this.thrOff = cfg.vad?.energyThresholdOff ?? 0.010;
    this.adaptiveVad = new AdaptiveVadThreshold({
      enabled: cfg.vad?.adaptive !== false,
      fixedOn: this.thrOn,
      fixedOff: this.thrOff,
      initialNoiseFloor: cfg.vad?.initialNoiseFloor ?? Math.max(0.004, this.thrOff * 0.65)
    });
    this.currentRms = 0;
    this.peakRms = 0;
    this.maxRmsSeen = 0;
    this.audioFramesReceived = 0;
    this.lastAudioFrameAt = 0;
    this.minSpeechFrames = Math.ceil((cfg.vad?.minSpeechMs ?? 300) / this.frameMs);
    this.silenceTimeoutFrames = Math.ceil((cfg.vad?.silenceTimeoutMs ?? 1000) / this.frameMs);
    this.maxUtteranceFrames = Math.ceil((cfg.vad?.maxUtteranceMs ?? 8000) / this.frameMs);
    this.preRollMaxFrames = Math.ceil((cfg.vad?.preRollMs ?? 200) / this.frameMs);
    this.partialIntervalFrames = Math.ceil((cfg.vad?.partialIntervalMs ?? 1500) / this.frameMs);
    this.partialEnabled = cfg.partialAsr !== false;
    this.lastPartialFrameMark = 0;
    this.partialInFlight = false;

    // Preserve frame boundaries across arbitrary stream chunks, regardless of
    // whether PCM comes from the shared RTSP hub or a local ffmpeg process.
    this.audioLeftover = Buffer.alloc(0);
    const consumePcm = chunk => {
      const merged = this.audioLeftover.length ? Buffer.concat([this.audioLeftover, chunk]) : chunk;
      let offset = 0;
      while (merged.length - offset >= this.bytesPerFrame) {
        const frame = merged.subarray(offset, offset + this.bytesPerFrame);
        offset += this.bytesPerFrame;
        this._onFrame(frame);
      }
      this.audioLeftover = merged.subarray(offset);
    };

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
      this.ff = spawn('ffmpeg', ffArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
      this.ff.stdout.on('data', consumePcm);
    } else {
      // Camera audio shares MediaHub's single RTSP connection with homepage
      // video. Keeping the subscription alive across hub restarts prevents a
      // transient camera disconnect from turning voice off.
      this.ff = null;
      this.mediaAudioHandler = consumePcm;
      MediaHub.subscribeAudio(this.mediaAudioHandler);
    }

    this.running = true;
    this.startedAt = Date.now();
    this.state = 'listening';
    this.broadcast({ type: 'state', state: 'listening', message: '语音监听已启动', audioSource: this.audioSource });
    const pipelineId = this.ff?.pid || `media-hub:${MediaHub.ff?.pid || 'starting'}`;
    console.log(`[Voice] Pipeline started (source=${this.audioSource}, input=${pipelineId}). Wake words: ${cfg.wakeWords.join(', ')}`);

    if (this.ff) this.ff.stderr.on('data', d => {
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

    const currentPid = this.ff?.pid;
    if (this.ff) this.ff.on('exit', code => {
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
    this.audioLeftover = Buffer.alloc(0);
    if (this.mediaAudioHandler) {
      MediaHub.unsubscribeAudio(this.mediaAudioHandler);
      this.mediaAudioHandler = null;
    }
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

  /** Stop only the shared camera-audio consumer while leaving video alive. */
  onSharedAudioUnavailable(message) {
    if (!this.running || this.audioSource !== 'rtsp') return;
    this.running = false;
    this.lastError = message;
    this.state = 'idle';
    this.speaking = false;
    this.buffer = [];
    this.preRoll = [];
    if (this.mediaAudioHandler) {
      MediaHub.unsubscribeAudio(this.mediaAudioHandler);
      this.mediaAudioHandler = null;
    }
    this.broadcast({ type: 'error', message });
    this.broadcast({ type: 'state', state: 'idle', message });
    console.error(`[Voice] ${message}`);
  },

  _onFrame(frame) {
    // Do not feed HomeSense's own local reply back into VAD/ASR. Clear partial
    // utterances as soon as playback starts, then retain a short acoustic tail.
    if (this.echoGuard.shouldSuppress()) {
      this.speaking = false;
      this.speechFrames = 0;
      this.silenceFrames = 0;
      this.buffer = [];
      this.preRoll = [];
      return;
    }
    // Compute RMS energy in [0, 1]
    let sumSq = 0;
    const samples = frame.length / 2;
    for (let i = 0; i < frame.length; i += 2) {
      const s = frame.readInt16LE(i) / 32768;
      sumSq += s * s;
    }
    const rms = Math.sqrt(sumSq / samples);
    this.currentRms = rms;
    this.peakRms = Math.max(rms, this.peakRms * 0.96);
    this.maxRmsSeen = Math.max(this.maxRmsSeen, rms);
    this.audioFramesReceived += 1;
    this.lastAudioFrameAt = Date.now();
    const adaptiveThreshold = this.adaptiveVad?.observe(rms, this.speaking) || { on: this.thrOn, off: this.thrOff, noiseFloor: 0 };

    // Maintain pre-roll for capturing leading speech
    this.preRoll.push(frame);
    if (this.preRoll.length > this.preRollMaxFrames) this.preRoll.shift();

    if (!this.speaking) {
      if (rms >= adaptiveThreshold.on) {
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
      if (rms < adaptiveThreshold.off) {
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
      // Partial ASR is a remote request and often returns just after a short
      // utterance has ended. Keep it visible while final ASR is running instead
      // of silently dropping the only subtitle the user could have seen.
      if (text && (this.speaking || this.state === 'asr')) {
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
    const explicitlyWoken = wakeMatch.matched;
    if (!wakeMatch.matched && Date.now() < this.wakeArmedUntil) {
      wakeMatch = { matched: true, wakeWord: (cfg.wakeWords || [])[0] || '管家', remainder: text, followUp: true };
      console.log(`[Voice] Follow-up accepted inside wake window: "${text}"`);
    }
    if (!wakeMatch.matched && VoiceConversation.isActive()) {
      wakeMatch = { matched: true, wakeWord: VoiceConversation.wakeWord || (cfg.wakeWords || [])[0] || '管家', remainder: text, conversationFollowUp: true };
      console.log(`[Voice] Follow-up accepted inside continuous conversation: "${text}"`);
    }
    if (!wakeMatch.matched) {
      this.broadcast({ type: 'ignored', text, reason: 'no_wake_word' });
      this.state = 'listening';
      this.broadcast({ type: 'state', state: 'listening', message: '继续监听...' });
      return;
    }

    const spokenCommand = wakeMatch.remainder.trim();
    this.wakeArmedUntil = 0;
    if (explicitlyWoken) VoiceConversation.start(wakeMatch.wakeWord);
    else VoiceConversation.touch();
    this.broadcast({ type: 'wake', wakeWord: wakeMatch.wakeWord, text, command: spokenCommand, continuous: VoiceConversation.isActive() });
    console.log(`[Voice] Wake matched: "${wakeMatch.wakeWord}", command: "${spokenCommand}", continuous=${VoiceConversation.isActive()}`);

    if (!spokenCommand) {
      // Wake word alone starts a continuous session. The legacy short wake
      // window remains as a fallback when continuous conversation is disabled.
      if (!VoiceConversation.isActive()) this.wakeArmedUntil = Date.now() + 8000;
      const ack = VoiceConversation.isActive() ? '我在，我们可以连续聊。' : '我在，请讲。';
      this.broadcast({ type: 'reply', text: ack, success: true });
      speakReply(ack, 'qaCommand', { origin: 'voice' });
      this.broadcast({ type: 'state', state: 'listening', message: '请说出指令...' });
      this.state = 'listening';
      return;
    }

    if (VoiceConversation.isActive() && VoiceConversation.shouldExit(spokenCommand)) {
      VoiceConversation.end('user_exit');
      const reply = '好的，对话已结束。';
      this.broadcast({ type: 'conversation_end', reason: 'user_exit', reply });
      this.broadcast({ type: 'reply', text: reply, success: true });
      speakReply(reply, 'qaCommand', { origin: 'voice' });
      this.state = 'listening';
      this.broadcast({ type: 'state', state: 'listening', message: '等待唤醒...' });
      return;
    }

    // Only factual household questions inherit terse room/time references.
    // Device actions below continue to use the current utterance verbatim.
    const expandedQuestion = expandHouseholdFollowUp(
      spokenCommand,
      VoiceConversation.lastUserText(),
      (config.rooms || []).map(room => room.name)
    );

    // Household questions are read-only and deterministic. Resolve them before
    // the command model so “今天下午客厅有人吗” can never become a device action.
    const localQuestion = await answerLocalHomeQuestion(expandedQuestion);
    if (localQuestion) {
      VoiceConversation.addExchange(spokenCommand, localQuestion.reply, { source: localQuestion.source });
      this.broadcast({ type: 'qa', text, command: spokenCommand, expandedQuestion, reply: localQuestion.reply, source: localQuestion.source });
      this.broadcast({ type: 'reply', text: localQuestion.reply, success: !!localQuestion.ok });
      speakReply(localQuestion.reply, 'qaCommand', { origin: 'voice' });
      AutomationEngine.recordActivity({ name: '家庭历史问答', source: 'voice', command: spokenCommand, reply: localQuestion.reply, success: !!localQuestion.ok });
      this.state = 'listening';
      this.broadcast({ type: 'state', state: 'listening', message: '继续监听...' });
      return;
    }

    const visualQuestion = await answerVisualQuestion(spokenCommand);
    if (visualQuestion) {
      VoiceConversation.addExchange(spokenCommand, visualQuestion.reply, { source: visualQuestion.source });
      this.broadcast({ type: 'qa', text, command: spokenCommand, reply: visualQuestion.reply, source: visualQuestion.source, capturedAt: visualQuestion.capturedAt });
      this.broadcast({ type: 'reply', text: visualQuestion.reply, success: !!visualQuestion.ok });
      speakReply(visualQuestion.reply, 'qaCommand', { origin: 'voice' });
      AutomationEngine.recordActivity({ name: '视觉问答', source: 'voice', command: spokenCommand, reply: visualQuestion.reply, success: !!visualQuestion.ok });
      this.state = 'listening';
      this.broadcast({ type: 'state', state: 'listening', message: '继续监听...' });
      return;
    }

    // 3b. Smart-home semantic gate. If command doesn't look home-related,
    // delegate to QA fallback (general assistant via LLM) when enabled, otherwise ignore.
    if (cfg.semanticGate !== false && !looksLikeCommand(spokenCommand)) {
      const qaEnabled = config.voice?.qa?.enabled !== false;
      if (qaEnabled) {
        console.log(`[Voice] Wake matched, non-home command → QA fallback: "${spokenCommand}"`);
        this.state = 'parsing';
        this.broadcast({ type: 'state', state: 'parsing', message: `问答模式: ${spokenCommand}` });
        const qa = await answerLocalHomeQuestion(expandedQuestion) || await chitchatLLM(spokenCommand, VoiceConversation.messages());
        const reply = qa.reply || '抱歉，这个问题我暂时帮不了。';
        VoiceConversation.addExchange(spokenCommand, reply, { source: qa.source });
        this.broadcast({ type: 'qa', text, command: spokenCommand, reply, source: qa.source });
        this.broadcast({ type: 'reply', text: reply, success: !!qa.ok });
        speakReply(reply, 'qaCommand', { origin: 'voice' });
        this.state = 'listening';
        this.broadcast({ type: 'state', state: 'listening', message: '继续监听...' });
        return;
      }
      console.log(`[Voice] Wake matched but command unrelated to smart home, ignored: "${spokenCommand}"`);
      this.broadcast({ type: 'ignored', text, reason: 'not_smart_home', command: spokenCommand });
      const msg = '这条指令好像跟智能家居无关，已忽略。';
      this.broadcast({ type: 'reply', text: msg, success: false });
      speakReply(msg, 'qaCommand', { origin: 'voice' });
      this.state = 'listening';
      this.broadcast({ type: 'state', state: 'listening', message: '继续监听...' });
      return;
    }

    // 4. NL parse + execute via existing pipeline
    // Broadcast intent shortcut — speak literal text via Xiaoai, bypass parser/QA.
    const broadcast = tryBroadcastIntent(spokenCommand);
    if (broadcast.matched) {
      console.log(`[Broadcast] (voice) "${spokenCommand}" → speak "${broadcast.text}" (${broadcast.reason})`);
      VoiceConversation.addExchange(spokenCommand, broadcast.text, { source: 'broadcast' });
      this.broadcast({ type: 'parse', parse: { understood: true, broadcast: true, reply: broadcast.text } });
      speakReply(broadcast.text, 'broadcast', { origin: 'broadcast' });
      this.state = 'listening';
      this.broadcast({ type: 'state', state: 'listening', message: '已代播，继续监听...' });
      return;
    }

    this.state = 'parsing';
    this.broadcast({ type: 'state', state: 'parsing', message: `解析: ${spokenCommand}` });
    const parseResult = await processNLCommand(spokenCommand);
    this.broadcast({ type: 'parse', parse: parseResult });

    if (!parseResult.understood || !parseResult.actions?.length) {
      // This branch is already known to be home-command shaped. Never ask the
      // chat model to improvise a reply here: it could say “已关闭” despite no
      // service dispatch. A failed parser must produce an explicit non-action.
      console.log(`[Voice] Home NL failed safely; no device action: "${spokenCommand}"`);
      const msg = parseResult.reply || '没有找到可执行的设备，操作未执行';
      VoiceConversation.addExchange(spokenCommand, msg, { source: 'command_not_executed' });
      this.broadcast({ type: 'reply', text: msg, success: false });
      speakReply(msg, 'qaCommand', { origin: 'voice' });
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
      finalReply = (await naturalizeReply(executed, spokenCommand)) || '所有设备已是该状态，无需更改';
    } else {
      finalReply = (await naturalizeReply(executed, spokenCommand)) || parseResult.reply || '已执行';
    }

    this.broadcast({ type: 'executed', executed, reply: finalReply });
    console.log(`[Voice] Matched ${totalMatches}, ok=${okCount} skipped=${skippedCount} — reply="${finalReply}"`);
    AutomationEngine.recordActivity({
      name: '语音控制',
      source: 'voice',
      command: spokenCommand,
      context: `唤醒词：${wakeMatch.wakeWord}`,
      executed,
      reply: finalReply,
      success: totalMatches > 0 && (okCount > 0 || skippedCount > 0)
    });

    // Speak reply: broadcast through Xiaoai speaker (preferred) and/or local `say`
    if (finalReply) {
      VoiceConversation.addExchange(spokenCommand, finalReply, { source: 'device_control' });
      speakReply(finalReply, 'nlCommand', { origin: 'voice' });
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
    const vadThreshold = this.adaptiveVad?.thresholds() || { on: this.thrOn || 0, off: this.thrOff || 0, noiseFloor: 0 };
    const audioAgeMs = this.lastAudioFrameAt ? Date.now() - this.lastAudioFrameAt : null;
    const inputHealth = !this.running ? 'stopped'
      : audioAgeMs === null || audioAgeMs > 2000 ? 'no_audio'
        : Date.now() - this.startedAt > 60000 && this.utterancesProcessed === 0 && this.maxRmsSeen < vadThreshold.on ? 'low_signal' : 'healthy';
    return {
      running: this.running,
      state: this.state,
      audioSource: this.audioSource,
      startedAt: this.startedAt,
      utterancesProcessed: this.utterancesProcessed,
      wakeWords: config.voiceControl?.wakeWords || [],
      enabled: config.voiceControl?.enabled === true,
      outputRoute: config.voiceControl?.output?.mode || 'follow',
      localOutputActive: this.echoGuard.activeCount > 0,
      echoGuardRemainingMs: this.echoGuard.remaining(),
      inputHealth,
      audioAgeMs,
      audioFramesReceived: this.audioFramesReceived,
      currentRms: Number(this.currentRms.toFixed(5)),
      peakRms: Number(this.peakRms.toFixed(5)),
      maxRmsSeen: Number(this.maxRmsSeen.toFixed(5)),
      noiseFloor: Number(vadThreshold.noiseFloor.toFixed(5)),
      effectiveThresholdOn: Number(vadThreshold.on.toFixed(5)),
      effectiveThresholdOff: Number(vadThreshold.off.toFixed(5)),
      conversation: VoiceConversation.status(),
      error: this.lastError
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
    try { writeJsonAtomic(CONFIG_PATH, config); } catch (e) {}
    if (wasRunning) this.start(newSource);
    return { ok: true, audioSource: this.audioSource, running: this.running };
  }
};

// ============ TTS (Text-to-Speech for local mode) ============
// Uses macOS `say` with a lifecycle guard so playback is never transcribed as input.
function ttsSpeak(text) {
  if (!text) return null;
  const cfg = config.voiceControl?.tts || {};
  if (cfg.enabled === false) return null;
  const voice = cfg.voice || 'Tingting';
  const rate = cfg.rate || 200; // words per minute
  // Sanitize text for shell (remove quotes and newlines)
  const safe = text.replace(/["'`\n\r\\$]/g, ' ').slice(0, 200);
  VoicePipeline.echoGuard.begin();
  const child = spawn('say', ['-v', voice, '-r', String(rate), safe], { stdio: 'ignore' });
  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    VoicePipeline.echoGuard.end(Date.now(), config.voiceControl?.output?.echoGuardMs ?? 500);
  };
  child.on('error', e => { console.error('[TTS] say error:', e.message); finish(); });
  child.on('exit', finish);
  console.log(`[TTS] Speaking: "${safe.slice(0, 40)}..."`);
  return child;
}

// ============ Xiaoai Speaker (broadcast via Mi Home notify entity) ============
// Routes a short text reply to a Xiaomi smart speaker / display via HA notify.send_message.
/**
 * Sends text to a configured Xiaoai notify entity.
 * Manual diagnostics may bypass the automation master switch so a founder can
 * verify the selected speaker before saving or enabling automatic broadcasts.
 */
async function notifyXiaoai(text, speakerEntityId, options = {}) {
  if (!text) return { ok: false, reason: 'empty' };
  const cfg = config.xiaoai || {};
  if (cfg.enabled === false && !options.ignoreEnabled) return { ok: false, reason: 'disabled' };
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

// Unified single-destination reply router. Explicit broadcast requests still
// target Xiaoai; ordinary browser text input remains text-only in follow mode.
function speakReply(text, eventType, options = {}) {
  if (!text) return 'silent';
  const xiaoai = config.xiaoai || {};
  const eventEnabled = eventType ? xiaoai.triggerOn?.[eventType] !== false : true;
  const route = resolveVoiceOutput({
    mode: config.voiceControl?.output?.mode || 'follow',
    origin: options.origin || 'web',
    audioSource: VoicePipeline?.audioSource || config.voiceControl?.audioSource || 'rtsp',
    eventEnabled,
    xiaoaiEnabled: xiaoai.enabled !== false,
    localEnabled: config.voiceControl?.tts?.enabled !== false
  });
  if (route === 'xiaoai') {
    notifyXiaoai(text).catch(() => {});
  } else if (route === 'local') {
    ttsSpeak(text);
  }
  return route;
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
  const normalizeWakeText = value => value
    .toLowerCase()
    .replace(/诺娃|诺瓦/g, 'nova')
    .replace(/\s+/g, '')
    .replace(/[，。、,.!?！？]/g, '');
  const normalized = normalizeWakeText(text);
  for (const w of wakeWords) {
    const wn = normalizeWakeText(w);
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

  const cameraVoiceOwnsRtsp = config.voiceControl?.enabled && (config.voiceControl.audioSource || 'rtsp') === 'rtsp';

  // Detect stream codec/resolution → adaptive mode/fps/width
  if (!MediaHub.status().running) {
    detectStreamProfile()
      .then(profile => {
        if (profile.recommendedMode === 'snapshot' && !MediaHub.status().running) startSnapshotDaemon();
      })
      .catch(() => {});
  }
  // Re-probe every 10 minutes to catch quality / codec changes
  setInterval(() => { if (!MediaHub.status().running) detectStreamProfile().catch(() => {}); }, 600000);

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

  // Event-driven visual perception. A tiny 16×16 grayscale fingerprint is
  // computed locally for each new candidate snapshot. Material changes trigger
  // fast analysis; static scenes use the configured heartbeat interval.
  let lastCandidateMtime = 0;
  let previousFingerprint = null;
  let lastAnalyzedFingerprint = null;
  let lastTriggeredAt = 0;
  let perceptionCheckRunning = false;
  const motionThreshold = 0.035;
  setInterval(async () => {
    if (perceptionCheckRunning || !fs.existsSync(SNAPSHOT_PATH)) return;
    let stat;
    try { stat = fs.statSync(SNAPSHOT_PATH); } catch { return; }
    if (stat.mtimeMs <= lastCandidateMtime || stat.size < 5000) return;
    lastCandidateMtime = stat.mtimeMs;
    perceptionCheckRunning = true;
    try {
      const fingerprint = await readVisualFingerprint();
      const frameDelta = visualDifference(previousFingerprint, fingerprint);
      const analyzedDelta = visualDifference(lastAnalyzedFingerprint, fingerprint);
      previousFingerprint = fingerprint;
      const now = Date.now();
      const heartbeatMs = Math.max(10, config.ai?.analysisIntervalSec || 60) * 1000;
      const firstAnalysis = !lastAnalysis.timestamp;
      const materialChange = frameDelta >= motionThreshold && analyzedDelta >= motionThreshold;
      const heartbeatDue = now - lastAnalysis.timestamp >= heartbeatMs;
      const changeDebounced = now - lastTriggeredAt >= 8000;
      broadcastVision({ type: 'observing', frameDelta: +frameDelta.toFixed(4), materialChange });
      if (firstAnalysis || heartbeatDue || (materialChange && changeDebounced)) {
        const reason = firstAnalysis ? 'first-frame' : (materialChange ? 'scene-change' : 'heartbeat');
        lastTriggeredAt = now;
        lastAnalyzedFingerprint = Buffer.from(fingerprint);
        analyzeSnapshot(reason).catch(error => console.error('[Vision] analysis error:', error.message));
      }
    } catch (error) {
      console.warn('[Vision] perception check failed:', error.message);
    } finally {
      perceptionCheckRunning = false;
    }
  }, 1000);
  
  // Full capture cycle (video + audio): for AI analysis and transcription
  setInterval(async () => {
    const result = await captureAll();
    
    // Trigger audio transcription if new audio
    if (result.audio && audioEnabled) {
      setTimeout(() => transcribeAudio().catch(e => console.error('[Audio] Transcribe error:', e.message)), 2000);
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

  // Never reflect arbitrary web origins into HomeSense's privileged household API.
  const allowedOrigin = corsOrigin(req, SECURITY);
  if (allowedOrigin) {
    res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  if (req.method === 'OPTIONS') {
    if (req.headers.origin && !allowedOrigin) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: '不允许的请求来源' }));
    }
    res.writeHead(204);
    return res.end();
  }

  // A LAN-bound HomeSense protects the UI, camera media and APIs together. Basic
  // auth gives browsers a native credential flow; Bearer remains available to
  // integrations. Localhost keeps the existing zero-configuration experience.
  if (!authenticateRequest(req, SECURITY)) {
    res.writeHead(401, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'WWW-Authenticate': 'Basic realm="HomeSense", charset="UTF-8"'
    });
    return res.end(JSON.stringify({ error: '需要知家 访问令牌' }));
  }

  try {
    // === API Routes ===

    // Unified household state. Read APIs are intentionally separate from HA's
    // raw entity proxy: consumers can depend on this stable semantic contract
    // while adapters and device vendors change underneath it.
    if (pathname === '/api/home/state' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify(HomeState.snapshot()));
    }

    if (pathname === '/api/spatial/intelligence' && req.method === 'GET') {
      const household = HomeState.snapshot();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({
        realtime: HaRealtime?.snapshot() || { connected: false, authenticated: false },
        registry: SpatialRegistry.snapshot(),
        ...SpatialEngine.snapshot(household)
      }));
    }

    if (pathname === '/api/decision-quality' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify(DecisionQuality.summary()));
    }

    if (pathname === '/api/quality/baseline' && req.method === 'GET') {
      const days = Math.max(1, Math.min(Number(parsedUrl.query.days) || 7, 30));
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({
        generatedAt: Date.now(),
        window: RuntimeStore.qualityWindow(days),
        decision: DecisionQuality.summary().metrics,
        targets: { criticalMisfires: 0, perceptionToStateP95Ms: 500, stateToActionP95Ms: 2000, verificationRate: 99, correctionRateMax: 5 }
      }));
    }

    if (pathname === '/api/spatial/registry' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify(SpatialRegistry.snapshot()));
    }

    if (pathname === '/api/spatial/registry/bind' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; if (body.length > 256 * 1024) req.destroy(); });
      req.on('end', () => {
        try {
          const input = JSON.parse(body || '{}');
          if (!input.entityId || !input.spaceId) throw new Error('请选择设备与空间');
          const binding = SpatialRegistry.bind(String(input.entityId), String(input.spaceId));
          config.spaceRegistry = config.spaceRegistry || { bindings: {} };
          config.spaceRegistry.bindings = { ...SpatialRegistry.bindings };
          writeJsonAtomic(CONFIG_PATH, config);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, binding, registry: SpatialRegistry.snapshot() }));
        } catch (error) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: error.message }));
        }
      });
      return;
    }

    if (pathname === '/api/spatial/registry/environment' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; if (body.length > 64 * 1024) req.destroy(); });
      req.on('end', () => {
        try {
          const input = JSON.parse(body || '{}');
          if (!input.spaceId || !input.metric || !input.entityId) throw new Error('请选择空间、指标和传感器');
          const binding = SpatialRegistry.bindEnvironmentSource(String(input.spaceId), String(input.metric), String(input.entityId));
          config.spaceRegistry.environmentSources = JSON.parse(JSON.stringify(SpatialRegistry.environmentSources));
          writeJsonAtomic(CONFIG_PATH, config);
          HomeState.refreshEnvironmentSelections();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, binding, registry: SpatialRegistry.snapshot() }));
        } catch (error) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: error.message }));
        }
      });
      return;
    }

    if (pathname === '/api/home/events' && req.method === 'GET') {
      const limit = Number(parsedUrl.query.limit) || 100;
      const type = typeof parsedUrl.query.type === 'string' ? parsedUrl.query.type : undefined;
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ events: HomeState.recentEvents({ limit, type }) }));
    }

    if (pathname === '/api/automation/timeline' && req.method === 'GET') {
      const limit = Number(parsedUrl.query.limit) || 100;
      const timeline = buildAutomationTimeline({
        events: HomeState.recentEvents({ limit: 500 }),
        activities: AutomationEngine.history,
        limit
      });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ timeline }));
    }

    if (pathname === '/api/home/state/refresh' && req.method === 'POST') {
      const states = await haRequest('GET', '/api/states');
      const events = HomeState.ingestHaStates(states, Date.now());
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, eventCount: events.length, state: HomeState.snapshot() }));
    }

    // Local face identity management. Enrollment is explicit and only the
    // derived Vision feature print is retained; uploaded image bytes are not.
    if (pathname === '/api/faces' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ people: FaceIdentity.people, localOnly: true, originalsRetained: false }));
    }
    if (pathname === '/api/faces/enroll' && req.method === 'POST') {
      let body = '';
      req.on('data', c => { body += c; if (body.length > 12 * 1024 * 1024) req.destroy(); });
      req.on('end', () => {
        try {
          const input = JSON.parse(body || '{}');
          const match = String(input.image || '').match(/^data:image\/(?:jpeg|jpg|png);base64,(.+)$/i);
          if (!match) throw new Error('请选择 JPG 或 PNG 人脸照片');
          const person = FaceIdentity.enroll(input.name, Buffer.from(match[1], 'base64'));
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, person, originalsRetained: false }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: e.stderr?.toString().match(/"error":"([^"]+)/)?.[1] || e.message }));
        }
      });
      return;
    }
    if (pathname === '/api/faces/enroll-camera' && req.method === 'POST') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', async () => {
        try {
          const input = JSON.parse(body || '{}');
          const person = await FaceIdentity.enrollFromSnapshot(input.name);
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, person, originalsRetained: false }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: e.stderr?.toString().match(/"error":"([^"]+)/)?.[1] || e.message }));
        }
      });
      return;
    }
    if (pathname.startsWith('/api/faces/') && req.method === 'DELETE') {
      const id = decodeURIComponent(pathname.slice('/api/faces/'.length));
      const ok = FaceIdentity.remove(id);
      res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok }));
    }
    if (pathname === '/api/faces/recognize' && req.method === 'POST') {
      const result = await FaceIdentity.recognizeAsync(SNAPSHOT_PATH);
      FaceIdentity.lastRecognition = result;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, result }));
    }

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
      stopSnapshotDaemon('shared live media hub taking over snapshots');
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
      req.on('close', cleanup); req.on('end', cleanup); res.on('close', cleanup);
      return;
    }
    if (pathname === '/api/media/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(MediaHub.status()));
    }

    // Gracefully restart only this HomeSense application. The replacement process
    // is launched after the current listener and owned media resources close.
    if (pathname === '/api/system/restart' && req.method === 'POST') {
      res.writeHead(202, { 'Content-Type': 'application/json', 'Connection': 'close' });
      res.end(JSON.stringify({ ok: true, message: '知家正在释放资源并重启' }));
      setTimeout(() => restartApplication(), 120);
      return;
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
      // Before profile probing succeeds, honour the explicit camera settings
      // instead of the conservative 8 FPS placeholder stored in streamProfile.
      const fps = streamProfile.detectedAt
        ? streamProfile.recommendedStreamFps
        : Math.max(8, Math.min(config.camera.streamFps || 15, 15));
      const width = streamProfile.detectedAt
        ? streamProfile.recommendedStreamWidth
        : Math.min(config.camera.streamWidth || 1280, 1280);
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
        '-vf', `scale=${snapW}:-2:in_range=tv:out_range=pc,fps=1/2,format=yuvj420p`,
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

    if (pathname === '/api/analysis/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-store',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
      });
      try { res.flushHeaders(); } catch {}
      visionSseClients.add(res);
      res.write(`data: ${JSON.stringify({ type: 'connected', analysis: lastAnalysis, timestamp: Date.now() })}\n\n`);
      const heartbeat = setInterval(() => { try { res.write(': heartbeat\n\n'); } catch {} }, 20000);
      req.on('close', () => { clearInterval(heartbeat); visionSseClients.delete(res); });
      return;
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

    if (pathname.startsWith('/api/memory/feedback/') && req.method === 'DELETE') {
      const id = decodeURIComponent(pathname.slice('/api/memory/feedback/'.length));
      const ok = MemoryEngine.removeFeedback(id);
      res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok }));
    }

    // ============ Automation Rules ============
    // Compile a one-sentence household intent into a deterministic, reviewable
    // policy draft. Compilation does not save a rule or control any device.
    if (pathname === '/api/rules/compile' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; if (body.length > 64 * 1024) req.destroy(); });
      req.on('end', () => {
        try {
          const { intent } = JSON.parse(body || '{}');
          const draft = attachDeviceGuard(compileRuleIntent(intent), HomeState.snapshot());
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ draft, saved: false, deviceAction: false }));
        } catch (error) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: error.message }));
        }
      });
      return;
    }

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
          let rule = JSON.parse(body || '{}');
          if (rule.policy) {
            const snapshot = HomeState.snapshot();
            rule = attachDeviceGuard(rule, snapshot);
            if (rule.targetEntityId) {
              const allowedTargets = rule.explanation?.targetCandidates || [];
              if (!allowedTargets.some(candidate => candidate.entityId === rule.targetEntityId)) {
                throw new Error('所选设备不属于该动作的候选目标');
              }
              rule = bindRuleTarget(rule, rule.targetEntityId, snapshot);
            }
          }
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
        'Connection': 'keep-alive'
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
            speakReply(broadcast.text, 'broadcast', { origin: 'broadcast' });
            AutomationEngine.recordActivity({
              name: '手动播报', source: 'manual', command,
              executed: [{ ok: true, broadcast: true, text: broadcast.text }],
              reply: broadcast.text, success: true
            });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              understood: true,
              broadcast: true,
              reply: broadcast.text,
              source: 'broadcast'
            }));
            return;
          }

          const localQuestion = await answerLocalHomeQuestion(command);
          if (localQuestion) {
            if (localQuestion.reply) speakReply(localQuestion.reply, 'qaCommand', { origin: 'web' });
            AutomationEngine.recordActivity({
              name: '家庭历史问答', source: 'manual', command,
              executed: [], reply: localQuestion.reply, success: !!localQuestion.ok
            });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ understood: true, ...localQuestion }));
            return;
          }

          const visualQuestion = await answerVisualQuestion(command);
          if (visualQuestion) {
            if (visualQuestion.reply) speakReply(visualQuestion.reply, 'qaCommand', { origin: 'web' });
            AutomationEngine.recordActivity({
              name: '视觉问答', source: 'manual', command,
              executed: [], reply: visualQuestion.reply, success: !!visualQuestion.ok
            });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ understood: true, ...visualQuestion }));
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
          } else if (!looksLikeCommand(command) && config.voice?.qa?.enabled !== false) {
            // Only genuinely conversational input may use the chat fallback.
            // A home-shaped command with no action must never receive an
            // invented “已打开/已关闭” answer from the general model.
            const qa = await answerLocalHomeQuestion(command) || await chitchatLLM(command);
            if (qa.reply) {
              result.reply = qa.reply;
              result.qaSource = qa.source;
            }
          } else {
            result.reply = result.reply || '没有找到可执行的设备，操作未执行';
            result.understood = false;
          }

          // Broadcast reply through Xiaoai speaker
          if (result.reply) {
            const eventType = (result.executed && result.executed.length) ? 'nlCommand' : 'qaCommand';
            speakReply(result.reply, eventType, { origin: 'web' });
          }

          AutomationEngine.recordActivity({
            name: result.executed?.length ? '手动控制' : '知家问答',
            source: 'manual',
            command,
            executed: result.executed || [],
            reply: result.reply || '',
            success: result.understood !== false
          });

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
        try {
          const result = await haRequest('POST', `/api/services/${servicePath}`, JSON.parse(body || '{}'));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (error) {
          // EventEmitter does not observe rejected async callbacks. Converting
          // HA failures into an HTTP response prevents one bad device service
          // call from terminating the entire HomeSense process.
          console.error(`[HA Service] ${servicePath} failed:`, error.message);
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: error.message }));
        }
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
            writeJsonAtomic(CONFIG_PATH, config);
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
          // A manual test is an explicit one-off action. It must remain usable
          // while automatic Xiaoai broadcasts are disabled or not yet saved.
          const result = await notifyXiaoai(message, speaker, { ignoreEnabled: true });
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
          writeJsonAtomic(CONFIG_PATH, onDisk);
          // Update in-memory config
          if (!config.camera) config.camera = {};
          config.camera.rtspUrl = rtspUrl;
          // A changed camera may expose a valid audio codec, so clear the
          // compatibility latch and let the shared pipeline probe it again.
          MediaHub.audioUnavailable = false;
          MediaHub.lastError = null;
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
      try { writeJsonAtomic(CONFIG_PATH, config); } catch (e) {}
      const ok = VoicePipeline.start();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok, status: VoicePipeline.status() }));
    }

    if (pathname === '/api/voice/stop' && req.method === 'POST') {
      if (config.voiceControl) config.voiceControl.enabled = false;
      try { writeJsonAtomic(CONFIG_PATH, config); } catch (e) {}
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
          if (patch.output?.mode && !['follow', 'local', 'xiaoai', 'silent'].includes(patch.output.mode)) {
            throw new Error('invalid voice output mode');
          }
          config.voiceControl = { ...(config.voiceControl || {}), ...patch };
          // Persist to disk (best-effort)
          try {
            writeJsonAtomic(CONFIG_PATH, config);
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
            writeJsonAtomic(CONFIG_PATH, config);
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
        camera: {
          previewFps: Math.max(2, Math.min(config.camera?.streamFps || 10, 22)),
          previewWidth: Math.min(config.camera?.streamWidth || 960, 960)
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
          let cameraPreviewChanged = false;
          if (patch.camera) {
            config.camera = config.camera || {};
            const requestedFps = Number(patch.camera.previewFps);
            if (Number.isFinite(requestedFps) && requestedFps >= 2 && requestedFps <= 22) {
              const nextFps = Math.round(requestedFps);
              cameraPreviewChanged = nextFps !== config.camera.streamFps;
              config.camera.streamFps = nextFps;
            }
          }
          try { writeJsonAtomic(CONFIG_PATH, config); }
          catch (e) { console.error('[Settings] persist failed:', e.message); }
          if (cameraPreviewChanged) MediaHub.restart('preview FPS changed');
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
          const url = (p.url ?? config.homeAssistant?.url ?? '').trim().replace(/\/$/, '');
          const tokenRaw = p.token && !p.token.includes('*') ? p.token : config.homeAssistant?.token;
          if (!url || !tokenRaw) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ ok: false, error: 'url 或 token 为空' }));
          }
          let parsedHaUrl;
          try {
            parsedHaUrl = new URL(url);
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ ok: false, error: 'HA 地址格式无效，请填写完整的 http:// 或 https:// 地址' }));
          }
          if (!['http:', 'https:'].includes(parsedHaUrl.protocol)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ ok: false, error: 'HA 地址只支持 http:// 或 https://' }));
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
          try { writeJsonAtomic(CONFIG_PATH, config); }
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

let applicationRestarting = false;

/**
 * Releases processes and long-lived responses owned by HomeSense, then replaces the
 * current Node process. It deliberately does not touch unrelated system tasks.
 */
function restartApplication() {
  if (applicationRestarting) return;
  applicationRestarting = true;
  console.log('[System] Graceful HomeSense restart requested');

  try { VoicePipeline.stop(); } catch {}
  try { stopSnapshotDaemon('application restart'); } catch {}
  if (snapshotRefreshProcess && !snapshotRefreshProcess.killed) {
    try { snapshotRefreshProcess.kill('SIGKILL'); } catch {}
    snapshotRefreshProcess = null;
  }
  MediaHub.videoClients.forEach(client => { try { client.end(); } catch {} });
  MediaHub.videoClients.clear();
  MediaHub.audioSubscribers.clear();
  if (MediaHub.restartTimer) { clearTimeout(MediaHub.restartTimer); MediaHub.restartTimer = null; }
  if (MediaHub.watchdogTimer) { clearInterval(MediaHub.watchdogTimer); MediaHub.watchdogTimer = null; }
  MediaHub.stopProcess('application restart');
  try { HaRealtime?.stop(); } catch {}

  for (const clients of [visionSseClients, AutomationEngine.sseClients, VoicePipeline.sseClients]) {
    clients?.forEach(client => { try { client.end(); } catch {} });
    clients?.clear?.();
  }

  // Positional shell arguments avoid interpolating executable paths into code.
  const replacement = spawn('/bin/sh', ['-c', 'sleep 1; exec "$1" "$2"', 'nova-restart', process.execPath, __filename], {
    cwd: __dirname,
    detached: true,
    stdio: 'ignore',
    env: process.env
  });
  replacement.unref();

  const exitCurrent = () => {
    try { RuntimeStore.close(); } catch {}
    process.exit(0);
  };
  try { server.close(exitCurrent); } catch { exitCurrent(); }
  setTimeout(exitCurrent, 700).unref();
}

server.listen(PORT, SECURITY.host, () => {
  console.log(`\n${'='.repeat(50)}`);
  console.log(`  Smart Home AI Control Panel`);
  console.log(`${'='.repeat(50)}`);
  console.log(`  Server:    http://${SECURITY.host}:${PORT}`);
  console.log(`  Access:    ${SECURITY.localOnly ? 'local only' : 'token protected'}`);
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
  if (!AutomationEngine.rules.some(rule => rule.id === 'nova-study-dark-observation-v1')) {
    AutomationEngine.add({
      id: 'nova-study-dark-observation-v1',
      name: '书房晚间进入且光线较暗',
      trigger: 'vision',
      condition: '书房有人，并且光照低于 80 lx，持续 10 秒',
      action: '打开书房灯',
      cooldownSec: 300,
      enabled: true,
      policy: {
        schemaVersion: 1,
        logic: 'all',
        durationSec: 10,
        confidenceThreshold: 0.65,
        conditions: [
          { kind: 'occupancy', space: '书房', operator: 'eq', value: 'occupied', label: '书房有人' },
          { kind: 'environment', space: '书房', metric: 'illuminance', operator: 'lt', value: 80, label: '书房光照低于 80 lx' }
        ],
        generatedFrom: '系统推荐的首个低风险观察场景'
      },
      explanation: {
        summary: '验证晚间进入书房时是否需要自动开灯',
        sources: ['书房人体感知', '书房光照传感器'],
        stability: ['条件持续 10 秒', '冷却 300 秒', '观察模式不执行设备'],
        action: '打开书房灯'
      }
    });
  }
  HomeState.subscribe(event => AutomationEngine.handleStateEvent(event));
  HomeState.subscribe((event, state) => SpatialEngine.observe(event, state));
  HomeState.subscribe(event => DecisionQuality.observe(event));
  startPeriodicTasks();
  startHaRealtime();
  if (config.voiceControl?.enabled) {
    setTimeout(() => VoicePipeline.start(), 1500);
  }
});
