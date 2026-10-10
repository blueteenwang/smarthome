const test = require('node:test');
const assert = require('node:assert/strict');
const { AdaptiveVadThreshold } = require('../lib/adaptive-vad');

test('quiet microphone receives a lower start threshold than the fixed ceiling', () => {
  const vad = new AdaptiveVadThreshold({ fixedOn: 0.018, fixedOff: 0.01, initialNoiseFloor: 0.006 });
  for (let i = 0; i < 100; i += 1) vad.observe(0.0075, false);
  const threshold = vad.thresholds();
  assert.ok(threshold.on > 0.009);
  assert.ok(threshold.on < 0.014);
  assert.ok(threshold.off < threshold.on);
});

test('speech frames do not contaminate the learned noise floor', () => {
  const vad = new AdaptiveVadThreshold({ initialNoiseFloor: 0.006 });
  const before = vad.thresholds().noiseFloor;
  for (let i = 0; i < 20; i += 1) vad.observe(0.08, true);
  assert.equal(vad.thresholds().noiseFloor, before);
});

test('adaptive mode can be disabled for deterministic fixed thresholds', () => {
  const vad = new AdaptiveVadThreshold({ enabled: false, fixedOn: 0.02, fixedOff: 0.011 });
  vad.observe(0.001, false);
  assert.deepEqual(vad.thresholds(), { on: 0.02, off: 0.011, noiseFloor: 0.00715 });
});
