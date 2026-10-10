/**
 * Spatial intelligence above the normalized household state.
 *
 * This layer owns explicit room bindings, sensor health, room context
 * transitions and inert intervention candidates. It never controls devices;
 * authorization remains the automation engine's responsibility.
 */

class SpaceRegistry {
  constructor(config = {}) {
    this.rooms = Array.isArray(config.rooms) ? config.rooms : [];
    this.bindings = { ...(config.bindings || {}) };
    this.environmentSources = { ...(config.environmentSources || {}) };
    this.unassigned = new Map();
  }

  resolve(entity) {
    const entityId = entity?.entity_id;
    if (!entityId) return null;
    const boundId = this.bindings[entityId];
    if (boundId) {
      const room = this.rooms.find(item => item.id === boundId || item.name === boundId);
      return { id: room?.name || boundId, name: room?.name || boundId, registryId: room?.id || boundId, provenance: 'user-binding' };
    }
    const explicitName = entity.attributes?.area_name;
    const explicitId = entity.attributes?.area_id;
    if (explicitName || explicitId) {
      return { id: String(explicitId || explicitName), name: String(explicitName || explicitId), provenance: 'ha-area' };
    }
    const searchable = `${entity.attributes?.friendly_name || ''} ${entityId}`;
    const room = this.rooms.find(item => searchable.includes(item.name));
    if (room) return { id: room.name, name: room.name, registryId: room.id, provenance: 'name-inference' };
    this.unassigned.set(entityId, { entityId, name: entity.attributes?.friendly_name || entityId, lastSeenAt: Date.now() });
    return null;
  }

  bind(entityId, spaceId) {
    const room = this.rooms.find(item => item.id === spaceId || item.name === spaceId);
    if (!room) throw new Error('目标空间不存在');
    this.bindings[entityId] = room.id;
    this.unassigned.delete(entityId);
    return { entityId, spaceId: room.id, spaceName: room.name };
  }

  bindEnvironmentSource(spaceId, metric, entityId) {
    const room = this.rooms.find(item => item.id === spaceId || item.name === spaceId);
    if (!room) throw new Error('目标空间不存在');
    if (!['temperature', 'humidity', 'illuminance'].includes(metric)) throw new Error('不支持的环境指标');
    this.environmentSources[room.id] = { ...(this.environmentSources[room.id] || {}), [metric]: entityId };
    return { spaceId: room.id, spaceName: room.name, metric, entityId };
  }

  environmentSource(spaceId, metric) {
    const room = this.rooms.find(item => item.id === spaceId || item.name === spaceId);
    return this.environmentSources[room?.id || spaceId]?.[metric] || null;
  }

  snapshot() {
    return {
      rooms: this.rooms.map(room => ({
        ...room,
        entityIds: Object.entries(this.bindings).filter(([, spaceId]) => spaceId === room.id).map(([entityId]) => entityId)
      })),
      bindings: { ...this.bindings },
      environmentSources: JSON.parse(JSON.stringify(this.environmentSources)),
      unassigned: [...this.unassigned.values()].slice(-100)
    };
  }
}

function activityContext(state, spaceId) {
  const activities = Object.values(state.activities || {}).filter(item => item.spaceId === spaceId && item.label?.value !== 'unknown');
  const text = activities.map(item => `${item.label?.value || ''} ${item.scene || ''}`).join(' ');
  if (/电脑|办公|工作|computer|working/i.test(text)) return 'working';
  if (/吃饭|用餐|dining|eating/i.test(text)) return 'dining';
  if (/电视|观影|watching/i.test(text)) return 'watching';
  return null;
}

function absenceGraceMs(spaceName) {
  if (/卫|卫生间/.test(spaceName)) return 3 * 60 * 1000;
  if (/厨房/.test(spaceName)) return 5 * 60 * 1000;
  if (/书房/.test(spaceName)) return 15 * 60 * 1000;
  if (/卧/.test(spaceName)) return 20 * 60 * 1000;
  return 10 * 60 * 1000;
}

/** Only genuine perception observations participate in source-health scoring. */
function isPerceptionEvent(event) {
  return new Set([
    'environment.observed',
    'space.occupancy.observed',
    'activity.observed',
    'person.identity.observed'
  ]).has(event?.type);
}

/**
 * Filters HA helper/configuration entities out of household interventions.
 * A switch is retained unless HA marks it as diagnostic/configuration or its
 * name clearly describes an implementation helper rather than an appliance.
 */
function isPrimaryRunningDevice(device) {
  if (!device || !['on', 'cool', 'heat', 'playing'].includes(device.state?.value)) return false;
  if (!['light', 'switch', 'climate', 'fan', 'media_player', 'humidifier'].includes(device.domain)) return false;
  const category = String(device.attributes?.entity_category || '').toLowerCase();
  if (category === 'diagnostic' || category === 'config') return false;
  const label = `${device.name || ''} ${device.entityId || ''}`;
  return !/指示灯|防闪烁|状态灯|indicator|anti.?flicker|led.?mode|child.?lock|童锁/i.test(label);
}

class SpatialIntelligence {
  constructor(options = {}) {
    this.sourceHealth = new Map();
    this.contexts = new Map();
    this.lastVerifiedCommands = new Map();
    this.corrections = [];
    this.contextEvents = [];
    this.onCorrection = options.onCorrection || (() => {});
  }

  observe(event, state) {
    if (event.type === 'command.verified' && event.payload?.entityId) {
      this.lastVerifiedCommands.set(event.payload.entityId, {
        entityId: event.payload.entityId,
        expectedState: event.payload.resultingState,
        action: `${event.payload.service || ''} ${event.payload.name || event.payload.entityId}`.trim(),
        verifiedAt: event.receivedAt || Date.now(),
        correlationId: event.correlationId || null
      });
    }
    if (event.type === 'device.state.changed' && event.payload?.entity_id) {
      const command = this.lastVerifiedCommands.get(event.payload.entity_id);
      const now = event.receivedAt || Date.now();
      if (command && now - command.verifiedAt <= 120000 && String(event.payload.state) !== String(command.expectedState)) {
        this.corrections.unshift({
          id: `correction-${now}-${event.payload.entity_id}`,
          entityId: event.payload.entity_id,
          name: event.payload.attributes?.friendly_name || event.payload.entity_id,
          expectedState: command.expectedState,
          correctedState: event.payload.state,
          correctedAt: now,
          correlationId: command.correlationId,
          meaning: '自动操作后短时间内状态被改变，可能是用户纠正'
        });
        this.corrections = this.corrections.slice(0, 100);
        this.lastVerifiedCommands.delete(event.payload.entity_id);
        try { this.onCorrection(this.corrections[0]); } catch {}
      }
    }
    if (!isPerceptionEvent(event)) return;
    const sourceKey = `${event.source?.adapter || 'system'}:${event.source?.sourceId || 'nova'}`;
    const health = this.sourceHealth.get(sourceKey) || { sourceKey, eventCount: 0, conflictCount: 0 };
    health.eventCount += 1;
    health.lastSeenAt = event.receivedAt || Date.now();
    health.adapter = event.source?.adapter;
    health.sourceId = event.source?.sourceId;
    health.spaceId = event.spaceId || health.spaceId || null;
    health.expectedIntervalMs = event.source?.adapter === 'camera' ? 120000 : 90000;
    this.sourceHealth.set(sourceKey, health);

    if (!event.spaceId) return;
    const space = state.spaces?.[event.spaceId];
    if (!space) return;
    if (space.occupancy?.decision?.status === 'conflict') health.conflictCount += 1;
    this.updateContext(space, state, event.receivedAt || Date.now());
  }

  updateContext(space, state, now) {
    const previous = this.contexts.get(space.id) || { state: 'unknown', since: now, updatedAt: now };
    const occupancy = space.occupancy?.value || 'unknown';
    const activity = activityContext(state, space.id);
    let nextState = previous.state;
    if (space.occupancy?.decision?.status === 'conflict') nextState = 'uncertain';
    else if (occupancy === 'occupied') nextState = activity || (previous.state === 'entering' && now - previous.since >= 15000 ? 'active' : previous.state === 'away' || previous.state === 'unknown' ? 'entering' : previous.state);
    else if (occupancy === 'vacant') nextState = ['active', 'working', 'dining', 'watching', 'entering'].includes(previous.state) ? 'temporarily_away' : 'away';
    else nextState = 'uncertain';
    const next = {
      spaceId: space.id,
      spaceName: space.name || space.id,
      state: nextState,
      since: nextState === previous.state ? previous.since : now,
      updatedAt: now,
      occupancy,
      confidence: space.occupancy?.confidence || 0,
      reason: space.occupancy?.decision?.reason || '等待空间证据',
      absenceGraceMs: absenceGraceMs(space.name || space.id)
    };
    this.contexts.set(space.id, next);
    if (nextState !== previous.state) {
      const continuing = !['away', 'unknown'].includes(previous.state) && !['away', 'unknown'].includes(nextState);
      this.contextEvents.unshift({
        id: `context-${space.id}-${now}`,
        spaceId: space.id,
        spaceName: next.spaceName,
        type: ['away', 'unknown'].includes(nextState) ? 'scene.ended' : (continuing ? 'scene.changed' : 'scene.started'),
        from: previous.state,
        to: nextState,
        occurredAt: now,
        reason: next.reason
      });
      this.contextEvents = this.contextEvents.slice(0, 100);
    }
    return next;
  }

  healthSnapshot(now = Date.now()) {
    return [...this.sourceHealth.values()].map(item => {
      const ageMs = now - item.lastSeenAt;
      const stale = ageMs > item.expectedIntervalMs * 2;
      const conflictRate = item.eventCount ? item.conflictCount / item.eventCount : 0;
      return {
        ...item,
        ageMs,
        status: stale ? 'stale' : conflictRate > 0.3 ? 'unstable' : 'healthy',
        reliability: stale ? 0.2 : Math.max(0.4, 1 - conflictRate)
      };
    });
  }

  /** Reliability multiplier used by subsequent observations from a source. */
  reliabilityFor(adapter, sourceId) {
    const item = this.sourceHealth.get(`${adapter}:${sourceId}`);
    if (!item?.eventCount) return 1;
    const conflictRate = item.conflictCount / item.eventCount;
    return Math.max(0.5, 1 - conflictRate);
  }

  snapshot(state, now = Date.now()) {
    for (const space of Object.values(state.spaces || {})) this.updateContext(space, state, now);
    const contexts = [...this.contexts.values()].map(context => {
      const activityAnchors = Object.values(state.devices || {}).filter(device => device.name?.includes(context.spaceName) && isPrimaryRunningDevice(device));
      if (context.state === 'temporarily_away' && now - context.since >= context.absenceGraceMs && activityAnchors.length === 0) return { ...context, state: 'away', since: context.since };
      return context;
    });
    const decisions = this.candidates(state, contexts, now);
    return { observedAt: now, contexts, sensorHealth: this.healthSnapshot(now), decisions, contextEvents: this.contextEvents.slice(0, 20), corrections: this.corrections.slice(0, 20) };
  }

  candidates(state, contexts, now) {
    const candidates = [];
    for (const context of contexts) {
      const space = state.spaces?.[context.spaceId];
      if (!space) continue;
      if (space.occupancy?.decision?.status === 'conflict') {
        candidates.push({ id: `conflict:${context.spaceId}`, spaceId: context.spaceId, level: 'observe', risk: 'none', title: `${context.spaceName}感知证据冲突`, reason: space.occupancy.decision.reason, executable: false });
        continue;
      }
      const lux = Number(space.environment?.illuminance?.value);
      if (['entering', 'active', 'working'].includes(context.state) && Number.isFinite(lux) && lux < 80) {
        candidates.push({ id: `dark:${context.spaceId}`, spaceId: context.spaceId, level: 'suggest', risk: 'low', title: `${context.spaceName}有人且光线较暗`, reason: `空间状态为${context.state}，光照 ${lux} lx`, proposedAction: `打开${context.spaceName}灯`, executable: false });
      }
      if (context.state === 'away' && now - context.since >= 180000) {
        const running = Object.values(state.devices || {}).filter(device => device.name?.includes(context.spaceName) && isPrimaryRunningDevice(device));
        if (running.length) candidates.push({ id: `running-away:${context.spaceId}`, spaceId: context.spaceId, level: 'ask', risk: 'medium', title: `${context.spaceName}无人但仍有设备运行`, reason: running.slice(0, 3).map(item => item.name).join('、'), proposedAction: `关闭${context.spaceName}非必要设备`, executable: false });
      }
    }
    return candidates;
  }
}

module.exports = { SpaceRegistry, SpatialIntelligence, activityContext, absenceGraceMs, isPerceptionEvent, isPrimaryRunningDevice };
