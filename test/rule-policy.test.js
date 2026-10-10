const test = require('node:test');
const assert = require('node:assert/strict');
const { compileRuleIntent, evaluatePolicy, attachDeviceGuard, bindRuleTarget } = require('../lib/rule-policy');

test('natural language compiles to a safe multi-sensor observation rule', () => {
  const draft = compileRuleIntent('书房有人使用电脑而且光线低于80 lx时，打开书房灯，不要频繁开关');
  assert.equal(draft.dryRun, true);
  assert.equal(draft.policy.conditions.length, 3);
  assert.equal(draft.policy.conditions.find(item => item.metric === 'illuminance').value, 80);
  assert.equal(draft.action, '打开书房灯');
});

test('policy requires all sensor conditions to match deterministically', () => {
  const draft = compileRuleIntent('书房有人使用电脑而且光线暗时，打开书房灯');
  const snapshot = {
    spaces: { study: { id: 'study', name: '书房', occupancy: { value: 'occupied', confidence: 0.8 }, environment: { illuminance: { value: 40, confidence: 1 } } } },
    activities: { work: { spaceId: '书房', label: { value: '有人正在使用电脑', confidence: 0.9 } } },
    environment: { illuminance: { value: 300, confidence: 1 } }
  };
  assert.equal(evaluatePolicy(draft.policy, snapshot).matched, true);
  snapshot.spaces.study.environment.illuminance.value = 300;
  assert.equal(evaluatePolicy(draft.policy, snapshot).matched, false);
});

test('room-specific policy never falls back to unrelated whole-home evidence', () => {
  const draft = compileRuleIntent('书房有人而且光线暗时，打开书房灯');
  const snapshot = {
    spaces: { home: { id: 'home', occupancy: { value: 'occupied', confidence: 0.9 } } },
    environment: { illuminance: { value: 10, confidence: 1 } }
  };
  assert.equal(evaluatePolicy(draft.policy, snapshot).matched, false);
});

test('compiler rejects intent without an action', () => {
  assert.throws(() => compileRuleIntent('书房有人而且光线很暗'), /执行动作/);
});

test('unique target device adds a current-state guard', () => {
  const draft = attachDeviceGuard(compileRuleIntent('书房有人而且光线暗时，打开书房灯'), {
    devices: { 'light.study': { entityId: 'light.study', domain: 'light', name: '书房灯', available: true, state: { value: 'off' } } }
  });
  const guard = draft.policy.conditions.find(item => item.kind === 'device');
  assert.equal(guard.entityId, 'light.study');
  assert.equal(guard.value, 'off');
});

test('ambiguous target devices require confirmation and are not silently bound', () => {
  const draft = attachDeviceGuard(compileRuleIntent('书房有人而且光线暗时，打开书房灯'), {
    devices: {
      one: { entityId: 'light.one', domain: 'light', name: '书房灯一', available: true, state: { value: 'off' } },
      two: { entityId: 'light.two', domain: 'light', name: '书房灯二', available: true, state: { value: 'off' } }
    }
  });
  assert.equal(draft.explanation.requiresTargetConfirmation, true);
  assert.equal(draft.policy.conditions.some(item => item.kind === 'device'), false);
});

test('missing target device also blocks later authorization', () => {
  const draft = attachDeviceGuard(compileRuleIntent('书房有人而且光线暗时，打开书房灯'), { devices: {} });
  assert.equal(draft.explanation.requiresTargetConfirmation, true);
});

test('selected target is bound to a deterministic HA service', () => {
  const snapshot = { devices: { lamp: { entityId: 'lamp', domain: 'light', name: '书房主灯', available: true, state: { value: 'off' } } } };
  const draft = bindRuleTarget(compileRuleIntent('书房有人而且光线暗时，打开书房灯'), 'lamp', snapshot);
  assert.deepEqual(draft.policy.actionTarget, { entityId: 'lamp', domain: 'light', service: 'turn_on' });
  assert.equal(draft.explanation.requiresTargetConfirmation, false);
});

test('light intent excludes climate devices and de-duplicates mirrored entities', () => {
  const draft = attachDeviceGuard(compileRuleIntent('书房有人而且光线暗时，打开书房灯'), {
    devices: {
      'light.study': { entityId: 'light.study', domain: 'light', name: '书房主灯', available: true, state: { value: 'off' } },
      'switch.study': { entityId: 'switch.study', domain: 'switch', name: '书房主灯', available: true, state: { value: 'off' } },
      'climate.study': { entityId: 'climate.study', domain: 'climate', name: '书房空调', available: true, state: { value: 'off' } }
    }
  });
  assert.deepEqual(draft.explanation.targetCandidates.map(item => item.entityId), ['switch.study']);
});
