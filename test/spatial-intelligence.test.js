const test = require('node:test');
const assert = require('node:assert/strict');

const { SpaceRegistry, SpatialIntelligence } = require('../lib/spatial-intelligence');

test('space registry prefers explicit bindings over name inference', () => {
  const registry = new SpaceRegistry({ rooms: [{ id: 'study', name: '书房' }, { id: 'living', name: '客厅' }], bindings: { 'sensor.ambiguous': 'study' } });
  assert.equal(registry.resolve({ entity_id: 'sensor.ambiguous', attributes: { friendly_name: '客厅传感器' } }).name, '书房');
  assert.equal(registry.resolve({ entity_id: 'sensor.living_lux', attributes: { friendly_name: '客厅光照' } }).provenance, 'name-inference');
});

test('user binding overrides an incorrect HA area', () => {
  const registry = new SpaceRegistry({ rooms: [{ id: 'study', name: '书房' }], bindings: { 'sensor.temperature': 'study' } });
  const resolved = registry.resolve({ entity_id: 'sensor.temperature', attributes: { area_id: 'cabinet', area_name: '弱电箱' } });
  assert.equal(resolved.name, '书房');
  assert.equal(resolved.provenance, 'user-binding');
});

test('context becomes working from occupied visual activity and only proposes an inert suggestion', () => {
  const intelligence = new SpatialIntelligence();
  const now = Date.now();
  const state = {
    spaces: { study: { id: 'study', name: '书房', occupancy: { value: 'occupied', confidence: 0.8, decision: { status: 'confirmed', reason: '人体传感器确认有人' } }, environment: { illuminance: { value: 35 } } } },
    activities: { work: { spaceId: 'study', label: { value: '使用电脑' }, scene: '书房办公' } },
    devices: {}
  };
  intelligence.observe({ type: 'activity.observed', spaceId: 'study', source: { adapter: 'camera', sourceId: 'camera.study' }, receivedAt: now }, state);
  const snapshot = intelligence.snapshot(state, now);
  assert.equal(snapshot.contexts[0].state, 'working');
  assert.equal(snapshot.decisions[0].proposedAction, '打开书房灯');
  assert.equal(snapshot.decisions[0].executable, false);
  assert.equal(snapshot.contextEvents[0].type, 'scene.started');
  assert.equal(snapshot.contextEvents[0].to, 'working');
});

test('conflicting space evidence yields observation only', () => {
  const intelligence = new SpatialIntelligence();
  const now = Date.now();
  const state = {
    spaces: { kitchen: { id: 'kitchen', name: '厨房', occupancy: { value: 'unknown', confidence: 0, decision: { status: 'conflict', reason: '证据冲突' } } } },
    activities: {}, devices: {}
  };
  intelligence.observe({ type: 'space.occupancy.observed', spaceId: 'kitchen', source: { adapter: 'ha', sourceId: 'sensor.kitchen' }, receivedAt: now }, state);
  const decision = intelligence.snapshot(state, now).decisions[0];
  assert.equal(decision.level, 'observe');
  assert.equal(decision.executable, false);
});

test('ordinary device events do not pollute sensor health', () => {
  const intelligence = new SpatialIntelligence();
  intelligence.observe({ type: 'device.state.changed', source: { adapter: 'ha', sourceId: 'light.study' }, payload: { entity_id: 'light.study', state: 'on' } }, { spaces: {} });
  assert.equal(intelligence.healthSnapshot().length, 0);
});

test('helper entities are excluded from away-room running suggestions', () => {
  const intelligence = new SpatialIntelligence();
  const now = Date.now();
  intelligence.contexts.set('study', { spaceId: 'study', spaceName: '书房', state: 'away', since: now - 600000, updatedAt: now, absenceGraceMs: 60000 });
  const state = {
    spaces: { study: { id: 'study', name: '书房', occupancy: { value: 'vacant', decision: { status: 'confirmed' } } } },
    activities: {},
    devices: {
      helper: { entityId: 'switch.study_anti_flicker', domain: 'switch', name: '书房防闪烁模式', state: { value: 'on' }, attributes: {} },
      indicator: { entityId: 'light.study_indicator', domain: 'light', name: '书房指示灯', state: { value: 'on' }, attributes: {} }
    }
  };
  assert.equal(intelligence.snapshot(state, now).decisions.length, 0);
  state.devices.lamp = { entityId: 'light.study_main', domain: 'light', name: '书房主灯', state: { value: 'on' }, attributes: {} };
  assert.match(intelligence.snapshot(state, now).decisions[0].reason, /书房主灯/);
});

test('a quick state reversal after verification is recorded as a possible correction', () => {
  const intelligence = new SpatialIntelligence();
  const now = Date.now();
  intelligence.observe({ type: 'command.verified', receivedAt: now, correlationId: 'run-1', payload: { entityId: 'light.study', name: '书房灯', service: 'turn_on', resultingState: 'on' }, source: { adapter: 'system', sourceId: 'executor' } }, { spaces: {} });
  intelligence.observe({ type: 'device.state.changed', receivedAt: now + 10000, payload: { entity_id: 'light.study', state: 'off', attributes: { friendly_name: '书房灯' } }, source: { adapter: 'ha', sourceId: 'light.study' } }, { spaces: {} });
  const snapshot = intelligence.snapshot({ spaces: {}, activities: {}, devices: {} }, now + 10000);
  assert.equal(snapshot.corrections.length, 1);
  assert.equal(snapshot.corrections[0].correctedState, 'off');
});
