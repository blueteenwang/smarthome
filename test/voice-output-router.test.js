const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveVoiceOutput, VoiceEchoGuard } = require('../lib/voice-output-router');

test('follow mode keeps a local voice conversation on the local speaker', () => {
  assert.equal(resolveVoiceOutput({ mode: 'follow', origin: 'voice', audioSource: 'local' }), 'local');
});

test('follow mode sends camera voice replies and automations to Xiaoai', () => {
  assert.equal(resolveVoiceOutput({ mode: 'follow', origin: 'voice', audioSource: 'rtsp' }), 'xiaoai');
  assert.equal(resolveVoiceOutput({ mode: 'follow', origin: 'automation' }), 'xiaoai');
});

test('follow mode leaves browser commands text-only', () => {
  assert.equal(resolveVoiceOutput({ mode: 'follow', origin: 'web', audioSource: 'local' }), 'silent');
});

test('explicit overrides select one destination and respect disabled outputs', () => {
  assert.equal(resolveVoiceOutput({ mode: 'local', origin: 'web' }), 'local');
  assert.equal(resolveVoiceOutput({ mode: 'xiaoai', origin: 'web' }), 'xiaoai');
  assert.equal(resolveVoiceOutput({ mode: 'silent', origin: 'automation' }), 'silent');
  assert.equal(resolveVoiceOutput({ mode: 'local', localEnabled: false }), 'silent');
  assert.equal(resolveVoiceOutput({ mode: 'xiaoai', xiaoaiEnabled: false }), 'silent');
});

test('literal broadcast remains explicitly routed to Xiaoai', () => {
  assert.equal(resolveVoiceOutput({ mode: 'local', origin: 'broadcast' }), 'xiaoai');
  assert.equal(resolveVoiceOutput({ mode: 'silent', origin: 'broadcast', xiaoaiEnabled: false }), 'silent');
});

test('echo guard suppresses during playback and for its configured tail', () => {
  const guard = new VoiceEchoGuard(500);
  assert.equal(guard.shouldSuppress(1000), false);
  guard.begin();
  assert.equal(guard.shouldSuppress(1000), true);
  assert.equal(guard.remaining(1000), null);
  guard.end(1200);
  assert.equal(guard.shouldSuppress(1699), true);
  assert.equal(guard.remaining(1699), 1);
  assert.equal(guard.shouldSuppress(1700), false);
});

test('nested local playback only starts the tail after the final child exits', () => {
  const guard = new VoiceEchoGuard(300);
  guard.begin();
  guard.begin();
  guard.end(1000);
  assert.equal(guard.shouldSuppress(5000), true);
  guard.end(1100);
  assert.equal(guard.shouldSuppress(1399), true);
  assert.equal(guard.shouldSuppress(1400), false);
});
