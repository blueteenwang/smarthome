const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { DecisionQualityStore } = require('../lib/decision-quality');

test('decision runs and corrections persist with rule attribution', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-quality-'));
  const file = path.join(dir, 'quality.json');
  const store = new DecisionQualityStore(file);
  store.observe({ type: 'rule.triggered', correlationId: 'run-1', occurredAt: 1000, payload: { ruleId: 'rule-1', ruleName: '测试规则', dryRun: false } });
  store.observe({ type: 'command.verified', correlationId: 'run-1', occurredAt: 1200, payload: { entityId: 'light.study', resultingState: 'on' } });
  const result = store.recordCorrection({ id: 'c1', correlationId: 'run-1', correctedAt: 2000 });
  assert.equal(result.item.ruleId, 'rule-1');
  assert.equal(store.summary().metrics.corrected, 1);
  assert.equal(new DecisionQualityStore(file).summary().corrections.length, 1);
});

test('observation matches are not counted as failed execution attempts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-quality-'));
  const store = new DecisionQualityStore(path.join(dir, 'quality.json'));
  store.observe({ type: 'rule.triggered', correlationId: 'observe-1', occurredAt: 1000, payload: { ruleId: 'rule-1', dryRun: true } });
  store.observe({ type: 'rule.observed', correlationId: 'observe-1', occurredAt: 1100, payload: {} });
  const metrics = store.summary().metrics;
  assert.equal(metrics.observationMatches, 1);
  assert.equal(metrics.executionAttempts, 0);
  assert.equal(metrics.successRate, null);
  assert.equal(metrics.averageLatencyMs, null);
});

test('execution and verification rates use only real execution attempts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-quality-'));
  const store = new DecisionQualityStore(path.join(dir, 'quality.json'));
  store.observe({ type: 'rule.triggered', correlationId: 'run-ok', occurredAt: 1000, payload: { dryRun: false } });
  store.observe({ type: 'command.verified', correlationId: 'run-ok', occurredAt: 1200, payload: {} });
  store.observe({ type: 'rule.triggered', correlationId: 'run-fail', occurredAt: 2000, payload: { dryRun: false } });
  store.observe({ type: 'rule.failed', correlationId: 'run-fail', occurredAt: 2400, payload: {} });
  const metrics = store.summary().metrics;
  assert.equal(metrics.executionAttempts, 2);
  assert.equal(metrics.successRate, 50);
  assert.equal(metrics.verificationRate, 100);
  assert.equal(metrics.averageLatencyMs, 300);
});
