/**
 * NOVA household event and state core.
 *
 * Device platforms provide raw facts; this module turns them into a durable,
 * inspectable household state without granting any execution authority. It is
 * intentionally dependency-free so reducers can be tested offline and reused
 * by future HA, MQTT, Matter, camera, and voice adapters.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_EVENT_LIMIT = 2000;
const KNOWN_SPACE_NAMES = ['客厅', '餐厅', '书房', '主卧', '次卧', '北卧', '厨房', '阳台', '公卫', '主卫', '走廊'];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function atomicWrite(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const nextPath = `${filePath}.next`;
  fs.writeFileSync(nextPath, JSON.stringify(value, null, 2));
  fs.renameSync(nextPath, filePath);
}

function stateValue(value, options = {}) {
  const now = options.updatedAt || Date.now();
  return {
    value,
    kind: options.kind || 'fact',
    confidence: Math.max(0, Math.min(1, Number(options.confidence ?? 1))),
    since: options.since || now,
    updatedAt: now,
    ...(options.expiresAt ? { expiresAt: options.expiresAt } : {}),
    sources: Array.isArray(options.sources) ? options.sources : [],
    ...(options.conflicts?.length ? { conflicts: options.conflicts } : {})
  };
}

function freshInitialState(homeId) {
  return {
    schemaVersion: 1,
    homeId,
    revision: 0,
    observedAt: 0,
    people: {},
    spaces: {},
    activities: {},
    environment: {},
    devices: {},
    alerts: []
  };
}

function normalizeEvent(input, homeId, nextSequence) {
  const now = Date.now();
  if (!input || typeof input.type !== 'string' || !input.type.trim()) {
    throw new Error('home event type is required');
  }
  return {
    schemaVersion: 1,
    id: input.id || `evt-${now}-${nextSequence}`,
    type: input.type.trim(),
    homeId: input.homeId || homeId,
    ...(input.spaceId ? { spaceId: input.spaceId } : {}),
    ...(input.personId ? { personId: input.personId } : {}),
    source: {
      adapter: input.source?.adapter || 'system',
      sourceId: input.source?.sourceId || 'nova'
    },
    occurredAt: Number(input.occurredAt) || now,
    receivedAt: now,
    confidence: Math.max(0, Math.min(1, Number(input.confidence ?? 1))),
    ...(input.correlationId ? { correlationId: input.correlationId } : {}),
    ...(input.causationId ? { causationId: input.causationId } : {}),
    payload: input.payload ?? {}
  };
}

function isPresenceEntity(entity) {
  const entityId = entity.entity_id || '';
  const deviceClass = entity.attributes?.device_class;
  return (entityId.startsWith('binary_sensor.') && ['occupancy', 'motion', 'presence'].includes(deviceClass)) ||
    (entityId.startsWith('sensor.') && /(occupancy_status|no_one_duration|has_someone_duration)/i.test(entityId));
}

/** Returns true/false only for explicit presence values; unknown is not vacancy. */
function presenceIsActive(entity) {
  const raw = String(entity.state || '').toLowerCase();
  if (['unknown', 'unavailable', 'none', 'null', ''].includes(raw)) return null;
  const entityId = entity.entity_id || '';
  if (/no_one_duration/i.test(entityId)) return /无人|no one/i.test(raw) ? false : null;
  if (/has_someone_duration/i.test(entityId)) return /有人|has (?:one|someone)/i.test(raw) ? true : null;
  if (['on', '有人', 'has one', 'true', '1', 'detected', 'moveless'].includes(raw)) return true;
  if (['off', '无人', 'no one', 'false', '0', 'clear', 'not detected'].includes(raw)) return false;
  return null;
}

function presenceSourceKey(entity) {
  const entityId = entity.entity_id || '';
  return entityId.replace(/_(?:occupancy_status|no_one_duration|has_someone_duration)_p_.+$/i, '');
}

function entitySourceTime(entity) {
  return Date.parse(entity.last_updated || entity.last_changed || '') || 0;
}

/**
 * Xiaomi presence integrations expose one physical sensor as several HA
 * entities. Pick the newest explicit semantic state from each physical sensor
 * so an old “有人” value cannot override a newer “持续无人” observation.
 */
function selectPresenceObservations(states) {
  const selected = new Map();
  for (const entity of states || []) {
    if (!isPresenceEntity(entity)) continue;
    const active = presenceIsActive(entity);
    if (active === null) continue;
    const sourceKey = presenceSourceKey(entity);
    const timestamp = entitySourceTime(entity);
    const current = selected.get(sourceKey);
    const durationPriority = /(?:no_one|has_someone)_duration/i.test(entity.entity_id || '') ? 1 : 0;
    if (!current || timestamp > current.timestamp || (timestamp === current.timestamp && durationPriority > current.durationPriority)) {
      selected.set(sourceKey, { entity, active, timestamp, durationPriority });
    }
  }
  return new Map([...selected.values()].map(observation => [observation.entity.entity_id, observation]));
}

function environmentKind(entity) {
  const deviceClass = entity.attributes?.device_class;
  if (['temperature', 'humidity', 'illuminance'].includes(deviceClass)) return deviceClass;
  return null;
}

function environmentSourceRank(evidence, preferredEntityId) {
  if (preferredEntityId && evidence.entityId === preferredEntityId) return 100;
  if (evidence.provenance === 'user-binding') return 30;
  if (evidence.provenance === 'ha-area') return 20;
  if (evidence.provenance === 'name-inference') return 10;
  return 1;
}

function selectEnvironmentEvidence(evidenceBySource, preferredEntityId) {
  const evidence = Object.values(evidenceBySource || {}).filter(item => Number.isFinite(Number(item.value)));
  return evidence.sort((a, b) => {
    const rankDelta = environmentSourceRank(b, preferredEntityId) - environmentSourceRank(a, preferredEntityId);
    return rankDelta || (b.observedAt || 0) - (a.observedAt || 0);
  })[0] || null;
}

function inferEntitySpace(entity) {
  const explicit = entity.attributes?.area_name || entity.attributes?.area_id;
  if (explicit) return { id: String(entity.attributes?.area_id || explicit), name: String(entity.attributes?.area_name || explicit), explicit: true };
  const name = `${entity.attributes?.friendly_name || ''} ${entity.entity_id || ''}`;
  const matched = KNOWN_SPACE_NAMES.find(space => name.includes(space));
  return matched ? { id: matched, name: matched, explicit: false } : null;
}

/**
 * Recompute one space's occupancy from all unexpired independent sources.
 * Positive presence may react quickly, while a vacant result requires a
 * reliable negative signal and no credible positive conflict.
 */
function fuseSpaceOccupancy(space, now = Date.now()) {
  const evidence = Object.values(space.occupancyEvidence || {})
    .filter(item => !item.expiresAt || item.expiresAt > now);
  const positive = evidence.filter(item => item.value === 'occupied').sort((a, b) => b.confidence - a.confidence);
  const negative = evidence.filter(item => item.value === 'vacant').sort((a, b) => b.confidence - a.confidence);
  const positiveStrength = positive[0]?.confidence || 0;
  const negativeStrength = negative[0]?.confidence || 0;
  let value = 'unknown';
  let confidence = 0;
  let status = evidence.length ? 'insufficient' : 'expired';
  let reason = evidence.length ? '现有证据不足以确认有人或无人' : '空间证据已经过期';

  if (positiveStrength >= 0.65 && (negativeStrength < 0.5 || positiveStrength - negativeStrength >= 0.2)) {
    value = 'occupied';
    confidence = positiveStrength;
    status = 'confirmed';
    reason = `${positive[0].sourceLabel || '存在传感器'}确认空间有人`;
  } else if (negativeStrength >= 0.7 && positiveStrength < 0.5) {
    value = 'vacant';
    confidence = negativeStrength;
    status = 'confirmed';
    reason = `${negative[0].sourceLabel || '存在传感器'}确认空间无人`;
  } else if (positiveStrength >= 0.5 && negativeStrength >= 0.5) {
    status = 'conflict';
    reason = '有人与无人证据发生冲突，暂不形成确定判断';
  }

  const previous = space.occupancy;
  space.occupancy = stateValue(value, {
    kind: 'inference',
    confidence,
    since: previous?.value === value ? previous.since : now,
    updatedAt: Math.max(0, ...evidence.map(item => item.observedAt || 0)),
    expiresAt: evidence.length ? Math.max(...evidence.map(item => item.expiresAt || now)) : undefined,
    sources: evidence.map(item => ({
      eventId: item.eventId,
      adapter: item.adapter,
      sourceId: item.sourceId,
      weight: item.confidence
    }))
  });
  space.occupancy.decision = {
    status,
    reason,
    positiveEvidence: positive.length,
    negativeEvidence: negative.length,
    evidenceCount: evidence.length,
    freshestAt: Math.max(0, ...evidence.map(item => item.observedAt || 0)) || null
  };
  return space.occupancy;
}

class HomeStateEngine {
  /**
   * @param {{homeId?: string, statePath?: string, eventsPath?: string,
   * eventLimit?: number, persist?: boolean}} options
   */
  constructor(options = {}) {
    this.homeId = options.homeId || 'home';
    this.statePath = options.statePath;
    this.eventsPath = options.eventsPath;
    this.eventLimit = options.eventLimit || DEFAULT_EVENT_LIMIT;
    this.persistEnabled = options.persist !== false;
    this.spaceResolver = typeof options.spaceResolver === 'function' ? options.spaceResolver : inferEntitySpace;
    this.sourceReliability = typeof options.sourceReliability === 'function' ? options.sourceReliability : (() => 1);
    this.environmentSource = typeof options.environmentSource === 'function' ? options.environmentSource : (() => null);
    this.ledger = options.ledger || null;
    this.pendingEvents = [];
    this.sequence = 0;
    this.listeners = new Set();
    this.events = [];
    this.state = freshInitialState(this.homeId);
    this.load();
    // Older builds let any room sensor overwrite the home-wide temperature.
    // Remove those ambiguous aggregates; room cards retain their own values.
    for (const [metric, value] of Object.entries(this.state.environment || {})) {
      const entity = this.state.devices?.[value?.entityId];
      if (entity && this.spaceResolver({ entity_id: entity.entityId, attributes: entity.attributes })) delete this.state.environment[metric];
    }
  }

  load() {
    if (!this.persistEnabled) return;
    try {
      if (this.statePath && fs.existsSync(this.statePath)) {
        this.state = { ...freshInitialState(this.homeId), ...JSON.parse(fs.readFileSync(this.statePath, 'utf8')) };
      }
      if (this.eventsPath && fs.existsSync(this.eventsPath)) {
        const stored = JSON.parse(fs.readFileSync(this.eventsPath, 'utf8'));
        this.events = Array.isArray(stored.events) ? stored.events.slice(-this.eventLimit) : [];
      }
      if (this.ledger) {
        if (this.ledger.eventCount() === 0 && this.events.length) this.ledger.appendEvents(this.events);
        const ledgerEvents = this.ledger.recentEvents({ limit: this.eventLimit });
        if (ledgerEvents.length) this.events = ledgerEvents.reverse();
      }
      this.sequence = this.events.length;
    } catch (error) {
      console.warn('[HomeState] load failed:', error.message);
      this.events = [];
      this.state = freshInitialState(this.homeId);
    }
  }

  persist() {
    if (!this.persistEnabled) return;
    if (this.statePath) atomicWrite(this.statePath, this.state);
    if (this.ledger) {
      if (this.pendingEvents.length) this.ledger.appendEvents(this.pendingEvents);
      this.pendingEvents = [];
    } else if (this.eventsPath) atomicWrite(this.eventsPath, {
      schemaVersion: 1,
      updatedAt: Date.now(),
      events: this.events
    });
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(input, options = {}) {
    const event = normalizeEvent(input, this.homeId, ++this.sequence);
    if (options.dedupeKey) {
      const duplicate = this.events.slice(-100).find(item => item.dedupeKey === options.dedupeKey && item.occurredAt === event.occurredAt);
      if (duplicate) return duplicate;
      event.dedupeKey = options.dedupeKey;
    }
    this.events.push(event);
    if (this.ledger) this.pendingEvents.push(event);
    if (this.events.length > this.eventLimit) this.events.splice(0, this.events.length - this.eventLimit);
    this.reduce(event);
    if (options.persist !== false) this.persist();
    for (const listener of this.listeners) {
      try { listener(event, this.state); } catch {}
    }
    return event;
  }

  reduce(event) {
    const state = this.state;
    state.revision += 1;
    state.observedAt = Math.max(state.observedAt || 0, event.occurredAt);
    const source = [{ eventId: event.id, adapter: event.source.adapter, sourceId: event.source.sourceId, weight: event.confidence }];

    if (event.type === 'device.state.changed') {
      const entity = event.payload;
      const existing = state.devices[entity.entity_id];
      state.devices[entity.entity_id] = {
        entityId: entity.entity_id,
        domain: entity.entity_id.split('.')[0],
        name: entity.attributes?.friendly_name || entity.entity_id,
        state: stateValue(entity.state, {
          since: existing?.state?.value === entity.state ? existing.state.since : event.occurredAt,
          updatedAt: event.occurredAt,
          sources: source
        }),
        attributes: entity.attributes || {},
        available: !['unknown', 'unavailable'].includes(entity.state),
        updatedAt: event.occurredAt
      };
    }

    if (event.type === 'environment.observed') {
      const { metric, value, unit, entityId } = event.payload;
      if (event.spaceId) {
        const space = state.spaces[event.spaceId] || { id: event.spaceId, name: event.payload.spaceName || event.spaceId };
        space.environment = space.environment || {};
        space.environmentEvidence = space.environmentEvidence || {};
        space.environmentEvidence[metric] = space.environmentEvidence[metric] || {};
        space.environmentEvidence[metric][entityId] = {
          entityId, value, unit: unit || '', observedAt: event.occurredAt,
          provenance: event.payload.provenance || 'unknown', source: source[0]
        };
        const selected = selectEnvironmentEvidence(space.environmentEvidence[metric], this.environmentSource(event.spaceId, metric));
        space.environment[metric] = stateValue(selected.value, { updatedAt: selected.observedAt, sources: [selected.source] });
        space.environment[metric].unit = selected.unit;
        space.environment[metric].entityId = selected.entityId;
        space.environment[metric].provenance = selected.provenance;
        space.environment[metric].candidateCount = Object.keys(space.environmentEvidence[metric]).length;
        state.spaces[event.spaceId] = space;
      } else {
        // Only genuinely home-wide or unassigned sensors populate the global
        // environment. Room sensors must not overwrite one another globally.
        state.environment[metric] = stateValue(value, { updatedAt: event.occurredAt, sources: source });
        state.environment[metric].unit = unit || '';
        state.environment[metric].entityId = entityId;
      }
    }

    if (event.type === 'space.occupancy.observed') {
      const spaceId = event.spaceId || 'home';
      const space = state.spaces[spaceId] || { id: spaceId, name: event.payload.spaceName || spaceId };
      space.occupancyEvidence = space.occupancyEvidence || {};
      if (event.payload.physicalSource) {
        for (const [key, evidence] of Object.entries(space.occupancyEvidence)) {
          if (evidence.adapter === event.source.adapter && String(evidence.sourceId || '').startsWith(event.payload.physicalSource)) {
            delete space.occupancyEvidence[key];
          }
        }
      }
      const sourceKey = `${event.source.adapter}:${event.source.sourceId}`;
      space.occupancyEvidence[sourceKey] = {
        eventId: event.id,
        adapter: event.source.adapter,
        sourceId: event.source.sourceId,
        sourceLabel: event.payload.sourceLabel || (event.source.adapter === 'camera' ? '摄像头' : '人体传感器'),
        value: event.payload.active ? 'occupied' : 'vacant',
        confidence: event.confidence,
        observedAt: event.occurredAt,
        expiresAt: event.occurredAt + (event.payload.ttlMs || 90000)
      };
      fuseSpaceOccupancy(space, event.receivedAt);
      state.spaces[spaceId] = space;
    }

    if (event.type === 'activity.observed') {
      const activityId = event.payload.activityId || `${event.spaceId || 'home'}:${event.payload.label || 'activity'}`;
      state.activities[activityId] = {
        id: activityId,
        label: stateValue(event.payload.label || 'unknown', {
          kind: 'inference',
          confidence: event.confidence,
          updatedAt: event.occurredAt,
          expiresAt: event.occurredAt + (event.payload.ttlMs || 120000),
          sources: source
        }),
        scene: event.payload.scene || '',
        spaceId: event.spaceId || null,
        personId: event.personId || null
      };
    }

    if (event.type === 'person.identity.observed') {
      const personId = event.personId || event.payload.personId;
      if (personId) {
        const person = state.people[personId] || { id: personId };
        person.name = event.payload.name || person.name || personId;
        person.identity = stateValue(event.payload.name || personId, {
          kind: 'inference', confidence: event.confidence,
          updatedAt: event.occurredAt,
          expiresAt: event.occurredAt + (event.payload.ttlMs || 120000),
          sources: source
        });
        state.people[personId] = person;
      }
    }

    if (event.type.startsWith('command.')) {
      state.lastCommand = {
        type: event.type,
        correlationId: event.correlationId || null,
        payload: event.payload,
        updatedAt: event.occurredAt
      };
    }

    this.expire(event.receivedAt);
  }

  expire(now = Date.now()) {
    const expireValue = value => {
      if (value?.expiresAt && value.expiresAt <= now) {
        return { ...value, value: 'unknown', confidence: 0, expiredAt: now };
      }
      return value;
    };
    for (const space of Object.values(this.state.spaces)) {
      if (space.occupancyEvidence) {
        for (const [key, evidence] of Object.entries(space.occupancyEvidence)) {
          if (evidence.expiresAt && evidence.expiresAt <= now) delete space.occupancyEvidence[key];
        }
        fuseSpaceOccupancy(space, now);
      } else {
        space.occupancy = expireValue(space.occupancy);
      }
    }
    for (const activity of Object.values(this.state.activities)) activity.label = expireValue(activity.label);
    for (const person of Object.values(this.state.people)) person.identity = expireValue(person.identity);
  }

  ingestHaStates(states, occurredAt = Date.now()) {
    if (!Array.isArray(states)) return [];
    const emitted = [];
    const presenceObservations = selectPresenceObservations(states);
    for (const entity of states) {
      if (!entity?.entity_id) continue;
      const prior = this.state.devices[entity.entity_id];
      const stateChanged = !prior || prior.state?.value !== entity.state || JSON.stringify(prior.attributes) !== JSON.stringify(entity.attributes || {});
      if (stateChanged) {
        emitted.push(this.emit({
          type: 'device.state.changed',
          source: { adapter: 'ha', sourceId: entity.entity_id },
          occurredAt,
          payload: entity
        }, { persist: false }));
      }
      const metric = environmentKind(entity);
      const numericValue = Number(entity.state);
      const entitySpace = this.spaceResolver(entity) || inferEntitySpace(entity);
      if (metric && Number.isFinite(numericValue)) {
        emitted.push(this.emit({
          type: 'environment.observed',
          ...(entitySpace ? { spaceId: entitySpace.id } : {}),
          source: { adapter: 'ha', sourceId: entity.entity_id },
          occurredAt,
          payload: { metric, value: numericValue, unit: entity.attributes?.unit_of_measurement, entityId: entity.entity_id, spaceName: entitySpace?.name, provenance: entitySpace?.provenance || (entitySpace?.explicit ? 'ha-area' : 'name-inference') }
        }, { persist: false }));
      }
      const presenceObservation = presenceObservations.get(entity.entity_id);
      if (presenceObservation) {
        const reliability = this.sourceReliability('ha', entity.entity_id);
        emitted.push(this.emit({
          type: 'space.occupancy.observed',
          spaceId: entitySpace?.id || 'home',
          source: { adapter: 'ha', sourceId: entity.entity_id },
          occurredAt,
          confidence: 0.8 * reliability,
          payload: { active: presenceObservation.active, spaceName: entitySpace?.name, ttlMs: 90000, physicalSource: presenceSourceKey(entity) }
        }, { persist: false }));
      }
    }
    if (emitted.length) this.persist();
    return emitted;
  }

  ingestVision(parsed, identity, occurredAt = Date.now()) {
    if (!parsed) return [];
    const emitted = [];
    const inferredSpaceName = parsed.spaceId || KNOWN_SPACE_NAMES.find(space => String(parsed.scene || '').includes(space));
    const visionSpaceId = inferredSpaceName || 'home';
    const cameraReliability = this.sourceReliability('camera', 'primary-camera');
    if (identity?.matched) {
      emitted.push(this.emit({
        type: 'person.identity.observed',
        personId: identity.id,
        source: { adapter: 'camera', sourceId: 'primary-camera' },
        occurredAt,
        confidence: Math.max(0.5, Number(identity.confidence) || 0.5) * cameraReliability,
        payload: { personId: identity.id, name: identity.name, ttlMs: 120000 }
      }, { persist: false }));
    }
    if (parsed.scene) {
      emitted.push(this.emit({
        type: 'activity.observed',
        spaceId: visionSpaceId,
        personId: identity?.matched ? identity.id : undefined,
        source: { adapter: 'camera', sourceId: 'primary-camera' },
        occurredAt,
        confidence: (parsed.confidence ? Number(parsed.confidence) : 0.65) * cameraReliability,
        payload: { label: parsed.activity || parsed.scene, scene: parsed.scene, ttlMs: 120000 }
      }, { persist: false }));
    }
    if (typeof parsed.occupied === 'boolean') {
      emitted.push(this.emit({
        type: 'space.occupancy.observed',
        spaceId: visionSpaceId,
        source: { adapter: 'camera', sourceId: 'primary-camera' },
        occurredAt,
        confidence: 0.7 * cameraReliability,
        payload: { active: parsed.occupied, spaceName: inferredSpaceName, ttlMs: 120000 }
      }, { persist: false }));
    }
    if (emitted.length) this.persist();
    return emitted;
  }

  snapshot() {
    this.expire();
    return clone(this.state);
  }

  refreshEnvironmentSelections() {
    for (const space of Object.values(this.state.spaces || {})) {
      for (const [metric, evidence] of Object.entries(space.environmentEvidence || {})) {
        const selected = selectEnvironmentEvidence(evidence, this.environmentSource(space.id, metric));
        if (!selected) continue;
        space.environment = space.environment || {};
        space.environment[metric] = stateValue(selected.value, { updatedAt: selected.observedAt, sources: [selected.source] });
        Object.assign(space.environment[metric], {
          unit: selected.unit, entityId: selected.entityId, provenance: selected.provenance,
          candidateCount: Object.keys(evidence).length
        });
      }
    }
    this.persist();
    return this.snapshot();
  }

  recentEvents(options = {}) {
    const limit = Math.max(1, Math.min(Number(options.limit) || 100, 500));
    const type = options.type;
    if (this.ledger) return clone(this.ledger.recentEvents({ limit, type }));
    const items = type ? this.events.filter(event => event.type === type) : this.events;
    return clone(items.slice(-limit).reverse());
  }
}

module.exports = {
  HomeStateEngine,
  stateValue,
  freshInitialState,
  isPresenceEntity,
  presenceIsActive,
  presenceSourceKey,
  selectPresenceObservations,
  inferEntitySpace,
  fuseSpaceOccupancy,
  selectEnvironmentEvidence
};
