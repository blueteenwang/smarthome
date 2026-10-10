const test = require('node:test');
const assert = require('node:assert/strict');

const { HomeStateEngine } = require('../lib/home-state');

test('HA entities become device facts and normalized environment state', () => {
  const engine = new HomeStateEngine({ persist: false });
  const events = engine.ingestHaStates([
    { entity_id: 'light.study', state: 'on', attributes: { friendly_name: '书房灯', brightness: 128 } },
    { entity_id: 'sensor.study_temperature', state: '26.5', attributes: { device_class: 'temperature', unit_of_measurement: '°C' } }
  ], 1000);

  assert.equal(events.length, 3);
  const state = engine.snapshot();
  assert.equal(state.devices['light.study'].state.value, 'on');
  assert.equal(state.devices['light.study'].state.kind, 'fact');
  assert.equal(state.environment.temperature.value, 26.5);
  assert.equal(state.environment.temperature.unit, '°C');
  assert.equal(state.environment.temperature.sources[0].adapter, 'ha');
});

test('trusted environment source wins over a newer low-authority sensor', () => {
  const engine = new HomeStateEngine({
    persist: false,
    spaceResolver: entity => ({ id: 'study', name: '书房', provenance: entity.entity_id.includes('trusted') ? 'user-binding' : 'ha-area' }),
    environmentSource: () => 'sensor.trusted_temperature'
  });
  engine.ingestHaStates([
    { entity_id: 'sensor.trusted_temperature', state: '25.1', attributes: { friendly_name: '书房温度', device_class: 'temperature', unit_of_measurement: '°C' } },
    { entity_id: 'sensor.cabinet_temperature', state: '39.8', attributes: { friendly_name: '弱电箱温度', device_class: 'temperature', unit_of_measurement: '°C' } }
  ], 1000);
  const temperature = engine.snapshot().spaces.study.environment.temperature;
  assert.equal(temperature.value, 25.1);
  assert.equal(temperature.entityId, 'sensor.trusted_temperature');
  assert.equal(temperature.candidateCount, 2);
  assert.equal(engine.snapshot().environment.temperature, undefined);
});

test('unchanged HA device state is not emitted twice', () => {
  const engine = new HomeStateEngine({ persist: false });
  const entity = { entity_id: 'switch.gateway', state: 'off', attributes: { friendly_name: '小米网关' } };
  engine.ingestHaStates([entity], 1000);
  const second = engine.ingestHaStates([entity], 2000);
  assert.equal(second.length, 0);
});

test('presence observations are inferred state with expiry and evidence', () => {
  const engine = new HomeStateEngine({ persist: false });
  engine.ingestHaStates([{
    entity_id: 'binary_sensor.study_presence',
    state: 'on',
    attributes: { device_class: 'presence', area_id: 'study', area_name: '书房' }
  }], 1000);

  const occupancy = engine.snapshot().spaces.study.occupancy;
  assert.equal(occupancy.value, 'unknown'); // The fixed 1970 test event is expired now.
  assert.equal(occupancy.kind, 'inference');
  assert.equal(occupancy.decision.status, 'expired');
});

test('space occupancy becomes unknown when reliable sources conflict', () => {
  const engine = new HomeStateEngine({ persist: false });
  const now = Date.now();
  engine.emit({
    type: 'space.occupancy.observed',
    spaceId: 'study',
    source: { adapter: 'ha', sourceId: 'binary_sensor.study_presence' },
    occurredAt: now,
    confidence: 0.8,
    payload: { active: true, spaceName: '书房', ttlMs: 90000 }
  });
  engine.emit({
    type: 'space.occupancy.observed',
    spaceId: 'study',
    source: { adapter: 'camera', sourceId: 'study-camera' },
    occurredAt: now + 1,
    confidence: 0.7,
    payload: { active: false, spaceName: '书房', ttlMs: 120000 }
  });

  const occupancy = engine.snapshot().spaces.study.occupancy;
  assert.equal(occupancy.value, 'unknown');
  assert.equal(occupancy.decision.status, 'conflict');
  assert.equal(occupancy.decision.evidenceCount, 2);
});

test('one reliable fresh source can confirm occupied or vacant', () => {
  const engine = new HomeStateEngine({ persist: false });
  const now = Date.now();
  engine.emit({
    type: 'space.occupancy.observed',
    spaceId: 'kitchen',
    source: { adapter: 'ha', sourceId: 'binary_sensor.kitchen_presence' },
    occurredAt: now,
    confidence: 0.8,
    payload: { active: true, spaceName: '厨房', ttlMs: 90000 }
  });
  assert.equal(engine.snapshot().spaces.kitchen.occupancy.value, 'occupied');

  engine.emit({
    type: 'space.occupancy.observed',
    spaceId: 'balcony',
    source: { adapter: 'ha', sourceId: 'binary_sensor.balcony_presence' },
    occurredAt: now,
    confidence: 0.8,
    payload: { active: false, spaceName: '阳台', ttlMs: 90000 }
  });
  assert.equal(engine.snapshot().spaces.balcony.occupancy.value, 'vacant');
});

test('newer Xiaomi no-one duration overrides an older occupied status from the same sensor', () => {
  const engine = new HomeStateEngine({ persist: false });
  const stem = 'sensor.xiaomi_cn_example_presence';
  engine.ingestHaStates([
    {
      entity_id: `${stem}_occupancy_status_p_2_1078`, state: '有人',
      last_updated: '2026-08-16T03:15:03.090Z',
      attributes: { friendly_name: '公卫人在传感器 有人无人状态', device_class: 'enum' }
    },
    {
      entity_id: `${stem}_no_one_duration_p_2_1082`, state: '30分钟持续无人',
      last_updated: '2026-08-16T04:18:27.526Z',
      attributes: { friendly_name: '公卫人在传感器 无人持续时长', device_class: 'enum' }
    },
    {
      entity_id: `${stem}_has_someone_duration_p_2_1081`, state: '5分钟持续有人',
      last_updated: '2026-08-15T13:53:39.719Z',
      attributes: { friendly_name: '公卫人在传感器 有人持续时长', device_class: 'enum' }
    }
  ], Date.now());

  const space = engine.snapshot().spaces['公卫'];
  assert.equal(space.occupancy.value, 'vacant');
  assert.equal(space.occupancy.decision.negativeEvidence, 1);
  assert.equal(space.occupancy.decision.positiveEvidence, 0);
  assert.match(space.occupancy.sources[0].sourceId, /no_one_duration/);
});

test('unknown presence helper values never become false vacancy evidence', () => {
  const engine = new HomeStateEngine({ persist: false });
  engine.ingestHaStates([{
    entity_id: 'sensor.xiaomi_cn_example_occupancy_status_p_2_1078',
    state: 'unknown',
    attributes: { friendly_name: '书房存在传感器 有人无人状态', device_class: 'enum' }
  }], Date.now());
  assert.equal(engine.snapshot().spaces['书房'], undefined);
});

test('vision identity and activity carry confidence and expire independently', () => {
  const engine = new HomeStateEngine({ persist: false });
  const now = Date.now();
  engine.ingestVision(
    { scene: '王小明在书房使用电脑', activity: 'working_at_computer', occupied: true },
    { matched: true, id: 'person-wang', name: '王小明', confidence: 0.82 },
    now
  );

  const state = engine.snapshot();
  assert.equal(state.people['person-wang'].name, '王小明');
  assert.equal(state.people['person-wang'].identity.kind, 'inference');
  assert.equal(state.activities['书房:working_at_computer'].label.value, 'working_at_computer');
  assert.equal(state.spaces['书房'].occupancy.value, 'occupied');
});

test('command lifecycle is correlated in state and event history', () => {
  const engine = new HomeStateEngine({ persist: false });
  const requested = engine.emit({
    type: 'command.requested',
    correlationId: 'cmd-1',
    payload: { entityId: 'light.study', service: 'turn_on' }
  });
  engine.emit({
    type: 'command.verified',
    correlationId: 'cmd-1',
    causationId: requested.id,
    payload: { entityId: 'light.study', resultingState: 'on' }
  });

  assert.equal(engine.snapshot().lastCommand.type, 'command.verified');
  assert.deepEqual(engine.recentEvents({ limit: 2 }).map(item => item.type), ['command.verified', 'command.requested']);
});

test('event history enforces limit and supports type filter', () => {
  const engine = new HomeStateEngine({ persist: false, eventLimit: 3 });
  engine.emit({ type: 'system.one' });
  engine.emit({ type: 'system.two' });
  engine.emit({ type: 'system.two' });
  engine.emit({ type: 'system.three' });
  assert.equal(engine.recentEvents({ limit: 10 }).length, 3);
  assert.equal(engine.recentEvents({ limit: 10, type: 'system.two' }).length, 2);
});
