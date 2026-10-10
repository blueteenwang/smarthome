/**
 * Voice conversation session state.
 *
 * This module deliberately keeps conversational context separate from device
 * execution. History may help interpret questions, but it must never manufacture
 * a device action that was not present in the user's current utterance.
 */

const DEFAULT_EXIT_PATTERN = /^(结束对话|退出对话|停止对话|不用了|没事了|先这样|再见)[。！!，,\s]*$/;

class VoiceConversationSession {
  constructor(options = {}) {
    this.enabled = options.enabled !== false;
    this.idleTimeoutMs = Math.max(10_000, Number(options.idleTimeoutMs) || 60_000);
    this.maxTurns = Math.max(2, Math.min(20, Number(options.maxTurns) || 8));
    this.exitPattern = options.exitPattern || DEFAULT_EXIT_PATTERN;
    this.reset();
  }

  /** Starts a new continuous conversation and discards stale context. */
  start(wakeWord, now = Date.now()) {
    if (!this.enabled) return false;
    this.active = true;
    this.startedAt = now;
    this.lastActivityAt = now;
    this.expiresAt = now + this.idleTimeoutMs;
    this.wakeWord = wakeWord || '';
    this.endReason = '';
    this.turns = [];
    return true;
  }

  /** Returns whether follow-up speech can omit the wake word. */
  isActive(now = Date.now()) {
    if (!this.enabled || !this.active) return false;
    if (now >= this.expiresAt) {
      this.end('idle_timeout');
      return false;
    }
    return true;
  }

  /** Extends the idle deadline after an accepted user turn or reply. */
  touch(now = Date.now()) {
    if (!this.isActive(now)) return false;
    this.lastActivityAt = now;
    this.expiresAt = now + this.idleTimeoutMs;
    return true;
  }

  shouldExit(text) {
    return this.exitPattern.test(String(text || '').trim());
  }

  /** Stores one completed exchange, bounded to avoid unbounded prompt growth. */
  addExchange(userText, assistantText, metadata = {}, now = Date.now()) {
    if (!this.isActive(now)) return false;
    this.turns.push({
      user: String(userText || '').trim(),
      assistant: String(assistantText || '').trim(),
      source: metadata.source || 'unknown',
      at: now
    });
    if (this.turns.length > this.maxTurns) this.turns.splice(0, this.turns.length - this.maxTurns);
    this.touch(now);
    return true;
  }

  /** OpenAI-compatible messages for general dialogue; device records are context only. */
  messages() {
    return this.turns.flatMap(turn => [
      { role: 'user', content: turn.user },
      { role: 'assistant', content: turn.assistant }
    ]);
  }

  lastUserText() {
    return this.turns.at(-1)?.user || '';
  }

  end(reason = 'user_exit') {
    const wasActive = this.active;
    this.active = false;
    this.expiresAt = 0;
    this.endReason = reason;
    return wasActive;
  }

  reset() {
    this.active = false;
    this.startedAt = 0;
    this.lastActivityAt = 0;
    this.expiresAt = 0;
    this.wakeWord = '';
    this.endReason = '';
    this.turns = [];
  }

  status(now = Date.now()) {
    const active = this.isActive(now);
    return {
      enabled: this.enabled,
      active,
      startedAt: active ? this.startedAt : null,
      remainingMs: active ? Math.max(0, this.expiresAt - now) : 0,
      turnCount: this.turns.length,
      maxTurns: this.maxTurns,
      endReason: active ? null : (this.endReason || null)
    };
  }
}

/**
 * Expands terse household follow-ups without asking an LLM to invent facts.
 * Example: “今天下午客厅有人吗” followed by “那主卧呢” becomes
 * “今天下午主卧有人吗”. Only question-shaped history is inherited.
 */
function expandHouseholdFollowUp(text, previousUserText, roomNames = []) {
  const current = String(text || '').trim();
  const previous = String(previousUserText || '').trim();
  if (!current || !previous || current.length > 16) return current;
  const rooms = [...new Set(roomNames.filter(Boolean))].sort((a, b) => b.length - a.length);
  const currentRoom = rooms.find(room => current.includes(room));
  const previousRoom = rooms.find(room => previous.includes(room));
  const previousIsQuestion = /(有人|无人|温度|湿度|天气|下雨|气温|开着|关着|状态|多少度)/.test(previous);
  const currentHasIntent = /(有人|无人|温度|湿度|天气|下雨|气温|开着|关着|状态|多少度)/.test(current);

  if (currentRoom && previousRoom && previousIsQuestion && !currentHasIntent) {
    return previous.replace(previousRoom, currentRoom);
  }

  if (/^(那|那么)?(现在|目前|今天|今晚|下午|上午|早上|刚才)(呢|怎么样)?[？?]?$/.test(current) && previousIsQuestion) {
    const time = current.replace(/^(那|那么)/, '').replace(/(呢|怎么样)[？?]?$/, '').replace(/[？?]$/, '');
    return previous.replace(/(今天下午|今天上午|今天早上|今天晚上|今晚|下午|上午|早上|刚才|现在|目前)/, time);
  }

  return current;
}

module.exports = { VoiceConversationSession, expandHouseholdFollowUp };
