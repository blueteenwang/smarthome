/**
 * Adaptive voice-activity thresholds for microphones with different gain.
 * Fixed configuration values remain safety ceilings, while the live noise
 * floor supplies a lower threshold for quiet local microphones.
 */

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

class AdaptiveVadThreshold {
  constructor(options = {}) {
    this.enabled = options.enabled !== false;
    this.fixedOn = Number(options.fixedOn ?? 0.018);
    this.fixedOff = Number(options.fixedOff ?? 0.01);
    this.minOn = Number(options.minOn ?? 0.0065);
    this.minOff = Number(options.minOff ?? 0.004);
    this.onMultiplier = Number(options.onMultiplier ?? 1.6);
    this.offMultiplier = Number(options.offMultiplier ?? 1.15);
    this.alpha = Number(options.alpha ?? 0.04);
    this.noiseFloor = Number(options.initialNoiseFloor ?? Math.max(this.minOff, this.fixedOff * 0.65));
  }

  thresholds() {
    if (!this.enabled) return { on: this.fixedOn, off: this.fixedOff, noiseFloor: this.noiseFloor };
    const on = clamp(this.noiseFloor * this.onMultiplier, this.minOn, this.fixedOn);
    const off = clamp(this.noiseFloor * this.offMultiplier, this.minOff, Math.min(this.fixedOff, on * 0.82));
    return { on, off, noiseFloor: this.noiseFloor };
  }

  observe(rms, speaking = false) {
    const before = this.thresholds();
    // Speech must not raise the learned floor. Only frames below the current
    // start threshold are eligible as background calibration samples.
    if (this.enabled && !speaking && Number.isFinite(rms) && rms >= 0 && rms < before.on) {
      this.noiseFloor = this.noiseFloor * (1 - this.alpha) + rms * this.alpha;
    }
    return this.thresholds();
  }
}

module.exports = { AdaptiveVadThreshold };
