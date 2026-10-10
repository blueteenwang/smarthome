const test = require('node:test');
const assert = require('node:assert/strict');
const { buildAutomationTimeline } = require('../lib/automation-timeline');

test('correlated rule and command events become one explainable timeline item', () => {
  const events = [
    { id: '1', type: 'rule.matched', correlationId: 'run-1', occurredAt: 10, confidence: 0.8, payload: { ruleName: '有人用电脑开灯', condition: '有人使用电脑', evidence: { spaces: ['study'] } } },
    { id: '2', type: 'rule.triggered', correlationId: 'run-1', occurredAt: 11, confidence: 1, payload: { ruleName: '有人用电脑开灯' } },
    { id: '3', type: 'command.requested', correlationId: 'run-1', occurredAt: 12, confidence: 1, payload: { name: '书房灯' } },
    { id: '4', type: 'command.verified', correlationId: 'run-1', occurredAt: 13, confidence: 1, payload: { name: '书房灯', resultingState: 'on' } },
    { id: '5', type: 'rule.completed', correlationId: 'run-1', occurredAt: 14, confidence: 1, payload: { ruleName: '有人用电脑开灯', reply: '书房灯已打开' } }
  ];
  const [item] = buildAutomationTimeline({ events });
  assert.equal(item.name, '有人用电脑开灯');
  assert.equal(item.status, 'success');
  assert.equal(item.steps.length, 5);
  assert.deepEqual(item.evidence, { spaces: ['study'] });
});

test('cooldown is visible as skipped instead of disappearing', () => {
  const [item] = buildAutomationTimeline({ events: [
    { id: '1', type: 'rule.matched', correlationId: 'run-2', occurredAt: 10, confidence: 0.7, payload: { ruleName: '夜间照明' } },
    { id: '2', type: 'rule.cooldown', correlationId: 'run-2', occurredAt: 11, confidence: 1, payload: { ruleName: '夜间照明', remainingSec: 90 } }
  ] });
  assert.equal(item.status, 'skipped');
  assert.match(item.steps[1].detail, /90/);
});

test('legacy activity remains available during migration', () => {
  const [item] = buildAutomationTimeline({ activities: [{ id: 'old-1', ts: 5, name: '旧规则', source: 'automation', success: true, reply: '已执行' }] });
  assert.equal(item.name, '旧规则');
  assert.equal(item.steps[0].type, 'legacy.activity');
});
