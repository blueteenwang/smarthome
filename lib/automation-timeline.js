/**
 * Builds the user-facing automation audit trail from immutable household events.
 * The projection is deliberately pure: persistence and execution remain owned by
 * their respective subsystems, while the UI receives one stable explanation model.
 */

const STEP_LABELS = {
  'rule.matched': '条件匹配',
  'rule.cooldown': '冷却跳过',
  'rule.triggered': '规则触发',
  'rule.observed': '观察模式',
  'rule.completed': '规则完成',
  'rule.failed': '规则失败',
  'command.requested': '请求设备控制',
  'command.dispatched': '指令已下发',
  'command.verified': '设备状态已验证',
  'command.accepted_unverified': '指令已受理',
  'command.skipped': '设备已是目标状态',
  'command.failed': '设备执行失败'
};

function eventDetail(event) {
  const payload = event.payload || {};
  if (event.type === 'rule.matched') return payload.condition || payload.context || '';
  if (event.type === 'rule.cooldown') return `剩余 ${payload.remainingSec || 0} 秒`;
  if (event.type === 'rule.observed') return '仅记录命中，本次没有控制设备';
  if (event.type.startsWith('command.')) {
    return [payload.name || payload.entityId, payload.error || payload.reason || payload.resultingState]
      .filter(Boolean).join(' · ');
  }
  return payload.reply || payload.action || payload.error || '';
}

function timelineStatus(events) {
  const types = new Set(events.map(event => event.type));
  if (types.has('rule.failed') || types.has('command.failed')) return 'failed';
  if (types.has('rule.cooldown') || types.has('rule.observed') ||
      (types.has('command.skipped') && !types.has('command.dispatched'))) return 'skipped';
  if (types.has('rule.completed') || types.has('command.verified') || types.has('command.accepted_unverified')) return 'success';
  return 'pending';
}

function buildAutomationTimeline({ events = [], activities = [], limit = 100 } = {}) {
  const groups = new Map();
  for (const event of events) {
    if (!event.correlationId || (!event.type.startsWith('rule.') && !event.type.startsWith('command.'))) continue;
    const group = groups.get(event.correlationId) || [];
    group.push(event);
    groups.set(event.correlationId, group);
  }

  const correlatedActivityIds = new Set();
  const timeline = [];
  for (const [correlationId, group] of groups) {
    group.sort((a, b) => a.occurredAt - b.occurredAt);
    const first = group[0];
    const ruleEvent = group.find(event => event.payload?.ruleName || event.payload?.ruleId);
    const activity = activities.find(item => item.id === correlationId);
    if (activity) correlatedActivityIds.add(activity.id);
    timeline.push({
      id: correlationId,
      ts: first.occurredAt,
      completedAt: group[group.length - 1].occurredAt,
      name: ruleEvent?.payload?.ruleName || activity?.name || first.payload?.name || '设备控制',
      source: ruleEvent ? 'automation' : (activity?.source || 'system'),
      condition: ruleEvent?.payload?.condition || activity?.condition || '',
      context: ruleEvent?.payload?.context || activity?.context || '',
      status: timelineStatus(group),
      evidence: ruleEvent?.payload?.evidence || null,
      reply: activity?.reply || group.findLast?.(event => event.payload?.reply)?.payload?.reply || '',
      steps: group.map(event => ({
        id: event.id,
        type: event.type,
        label: STEP_LABELS[event.type] || event.type,
        detail: eventDetail(event),
        ts: event.occurredAt,
        confidence: event.confidence
      }))
    });
  }

  for (const activity of activities) {
    if (correlatedActivityIds.has(activity.id)) continue;
    timeline.push({
      id: activity.id,
      ts: activity.ts,
      completedAt: activity.ts,
      name: activity.name,
      source: activity.source,
      condition: activity.condition || '',
      context: activity.context || '',
      status: activity.success === false ? 'failed' : activity.dryRun ? 'skipped' : 'success',
      evidence: null,
      reply: activity.reply || '',
      steps: [{ id: `${activity.id}-legacy`, type: 'legacy.activity', label: '历史记录', detail: activity.reply || activity.context || '', ts: activity.ts, confidence: 1 }]
    });
  }

  return timeline.sort((a, b) => b.ts - a.ts).slice(0, Math.max(1, Math.min(Number(limit) || 100, 500)));
}

module.exports = { buildAutomationTimeline, timelineStatus, eventDetail };
