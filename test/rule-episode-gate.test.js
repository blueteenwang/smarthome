const test = require('node:test');
const assert = require('node:assert/strict');
const { RuleEpisodeGate } = require('../lib/rule-episode-gate');

test('continuous matches fire once and can fire again after the scene ends', () => {
  const gate = new RuleEpisodeGate();
  assert.deepEqual(gate.update('vision', ['rule-1']), ['rule-1']);
  assert.deepEqual(gate.update('vision', ['rule-1']), []);
  assert.deepEqual(gate.update('vision', []), []);
  assert.deepEqual(gate.update('vision', ['rule-1']), ['rule-1']);
});

test('the same rule seen by audio and vision is one active household episode', () => {
  const gate = new RuleEpisodeGate();
  assert.deepEqual(gate.update('vision', ['rule-1']), ['rule-1']);
  assert.deepEqual(gate.update('audio', ['rule-1']), []);
  gate.update('vision', []);
  assert.deepEqual(gate.update('audio', ['rule-1']), []);
  gate.update('audio', []);
  assert.deepEqual(gate.update('vision', ['rule-1']), ['rule-1']);
});
