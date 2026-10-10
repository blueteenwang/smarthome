/**
 * Voice output routing and local-speaker echo suppression.
 *
 * Input origin and capture source are intentionally separate: a browser command
 * should stay textual, while an automation may still notify the household.
 */

const OUTPUT_MODES = new Set(['follow', 'local', 'xiaoai', 'silent']);

/** Resolve exactly one output route for a reply. */
function resolveVoiceOutput({
  mode = 'follow',
  origin = 'web',
  audioSource = 'rtsp',
  eventEnabled = true,
  xiaoaiEnabled = true,
  localEnabled = true
} = {}) {
  const normalizedMode = OUTPUT_MODES.has(mode) ? mode : 'follow';

  // A literal broadcast request is an explicit destination, not a generic reply.
  if (origin === 'broadcast') return xiaoaiEnabled && eventEnabled ? 'xiaoai' : 'silent';
  if (normalizedMode === 'silent') return 'silent';
  if (normalizedMode === 'local') return localEnabled ? 'local' : 'silent';
  if (normalizedMode === 'xiaoai') return xiaoaiEnabled && eventEnabled ? 'xiaoai' : 'silent';

  if (origin === 'automation') return xiaoaiEnabled && eventEnabled ? 'xiaoai' : 'silent';
  if (origin === 'voice') {
    if (audioSource === 'local') return localEnabled ? 'local' : 'silent';
    return xiaoaiEnabled && eventEnabled ? 'xiaoai' : 'silent';
  }
  return 'silent';
}

/** Tracks local playback and a short tail window so TTS cannot wake NOVA itself. */
class VoiceEchoGuard {
  constructor(guardMs = 500) {
    this.guardMs = guardMs;
    this.activeCount = 0;
    this.suppressUntil = 0;
  }

  begin() {
    this.activeCount += 1;
  }

  end(now = Date.now(), guardMs = this.guardMs) {
    this.activeCount = Math.max(0, this.activeCount - 1);
    if (this.activeCount === 0) this.suppressUntil = now + Math.max(0, guardMs);
  }

  shouldSuppress(now = Date.now()) {
    return this.activeCount > 0 || now < this.suppressUntil;
  }

  remaining(now = Date.now()) {
    return this.activeCount > 0 ? null : Math.max(0, this.suppressUntil - now);
  }
}

module.exports = { resolveVoiceOutput, VoiceEchoGuard };
