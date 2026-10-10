/**
 * Deterministic multi-sensor policy compiler and evaluator.
 * Natural language is converted once at authoring time; runtime decisions use
 * explicit household state so the same evidence always yields the same result.
 */

const SPACE_WORDS = ['书房', '客厅', '餐厅', '主卧', '次卧', '北卧', '厨房', '阳台', '卫生间'];

function extractNumber(text, pattern, fallback) {
  const match = text.match(pattern);
  return match ? Number(match[1]) : fallback;
}

function compileRuleIntent(intent) {
  const text = String(intent || '').trim();
  if (text.length < 6) throw new Error('请再具体描述什么时候做什么');
  const space = SPACE_WORDS.find(word => text.includes(word)) || '全屋';
  const conditions = [];
  const sources = [];

  if (/有人|人体|存在|进入/.test(text)) {
    conditions.push({ kind: 'occupancy', space, operator: 'eq', value: 'occupied', label: `${space}有人` });
    sources.push('人体与空间感知');
  }
  if (/电脑|办公|工作/.test(text)) {
    conditions.push({ kind: 'activity', space, operator: 'contains', value: '电脑', label: '检测到使用电脑或办公活动' });
    sources.push('视觉活动理解');
  }
  if (/暗|光线不足|亮度低|光线\s*(?:低于|小于)|(?:低于|小于)\s*\d+\s*(?:lx|勒克斯)/i.test(text)) {
    const lux = extractNumber(text, /(?:低于|小于)\s*(\d+)\s*(?:lx|勒克斯)?/i, 100);
    conditions.push({ kind: 'environment', space, metric: 'illuminance', operator: 'lt', value: lux, label: `${space}光照低于 ${lux} lx` });
    sources.push('光照传感器');
  }
  if (/识别到|看到/.test(text)) sources.push('人脸与视觉识别');

  const actionMatch = text.match(/(?:就|则|时|后)[，,\s]*(.+)$/);
  let action = actionMatch?.[1]?.trim() || '';
  if (!action) {
    const actionWords = text.match(/((?:打开|关闭|调高|调低|提醒|播放|启动).+)$/);
    action = actionWords?.[1]?.trim() || '';
  }
  action = action.replace(/[，,。；;]*(?:不要|避免)频繁.*$/, '').trim();
  if (!action) throw new Error('没有识别到执行动作，请说明要打开、关闭或提醒什么');

  const durationSec = extractNumber(text, /持续\s*(\d+)\s*秒/, /长时间|一会儿/.test(text) ? 30 : 10);
  const cooldownSec = extractNumber(text, /(?:冷却|间隔)\s*(\d+)\s*(?:秒|s)/i, /不要频繁|避免频繁/.test(text) ? 300 : 180);
  const trigger = /说|声音|听到/.test(text) ? (sources.length ? 'both' : 'audio') : 'vision';
  const conditionText = conditions.length ? conditions.map(item => item.label).join('，并且') : text.replace(action, '').replace(/[，,]*(?:就|则|时|后)\s*$/, '');

  return {
    name: `${space === '全屋' ? '' : space}${action.slice(0, 18)}` || '知家智能自动化',
    trigger,
    condition: conditionText,
    action,
    cooldownSec,
    dryRun: true,
    enabled: true,
    policy: {
      schemaVersion: 1,
      logic: 'all',
      conditions,
      durationSec,
      confidenceThreshold: 0.65,
      generatedFrom: text
    },
    explanation: {
      summary: `当${conditionText}时，${action}`,
      sources: [...new Set(sources)],
      stability: [`条件持续 ${durationSec} 秒`, `执行后冷却 ${cooldownSec} 秒`, '默认先在观察模式验证'],
      action
    }
  };
}

function compare(actual, operator, expected) {
  if (operator === 'eq') return actual === expected;
  if (operator === 'contains') return String(actual || '').includes(String(expected));
  if (operator === 'lt') return Number(actual) < Number(expected);
  if (operator === 'lte') return Number(actual) <= Number(expected);
  if (operator === 'gt') return Number(actual) > Number(expected);
  if (operator === 'gte') return Number(actual) >= Number(expected);
  return false;
}

function evaluatePolicy(policy, snapshot) {
  const results = (policy?.conditions || []).map(condition => {
    let actual;
    let confidence = 1;
    if (condition.kind === 'occupancy') {
      const candidates = Object.values(snapshot.spaces || {});
      const space = candidates.find(item => item.name === condition.space || item.id === condition.space) ||
        (condition.space === '全屋' ? candidates.find(item => item.id === 'home') : null);
      actual = space?.occupancy?.value;
      confidence = space?.occupancy?.confidence || 0;
    } else if (condition.kind === 'activity') {
      const activities = Object.values(snapshot.activities || {});
      const activity = activities.find(item => item.spaceId === condition.space) ||
        (condition.space === '全屋' ? activities[0] : null);
      actual = activity?.label?.value;
      confidence = activity?.label?.confidence || 0;
    } else if (condition.kind === 'environment') {
      const candidates = Object.values(snapshot.spaces || {});
      const space = candidates.find(item => item.name === condition.space || item.id === condition.space);
      const value = space?.environment?.[condition.metric] ||
        (condition.space === '全屋' || !condition.space ? snapshot.environment?.[condition.metric] : null);
      actual = value?.value;
      confidence = value?.confidence ?? 1;
    } else if (condition.kind === 'device') {
      const device = snapshot.devices?.[condition.entityId];
      actual = device?.state?.value;
      confidence = device ? 1 : 0;
    }
    return { ...condition, actual, confidence, matched: confidence >= (policy.confidenceThreshold || 0) && compare(actual, condition.operator, condition.value) };
  });
  const matched = results.length > 0 && (policy.logic === 'any' ? results.some(item => item.matched) : results.every(item => item.matched));
  return { matched, results };
}

function attachDeviceGuard(draft, snapshot) {
  const actionMatch = String(draft?.action || '').match(/^(打开|开启|关闭)\s*(.+)$/);
  if (!actionMatch) return draft;
  const [, verb, keyword] = actionMatch;
  const allowedDomains = /灯|照明/.test(keyword) ? ['light', 'switch']
    : /空调|温控/.test(keyword) ? ['climate']
      : /风扇|新风/.test(keyword) ? ['fan', 'switch']
        : ['light', 'switch', 'fan', 'climate'];
  const allDevices = Object.values(snapshot?.devices || {}).filter(device =>
    allowedDomains.includes(device.domain) && device.available !== false &&
    !/指示灯|防闪烁|模式|故障|异常|按键/.test(String(device.name || ''))
  );
  const space = draft.policy?.conditions?.find(condition => condition.space && condition.space !== '全屋')?.space;
  let devices = keyword === `${space}灯`
    ? allDevices.filter(device => String(device.name || '').includes(space))
    : allDevices.filter(device => String(device.name || '').includes(keyword));
  if (!devices.length && space) devices = allDevices.filter(device => String(device.name || '').includes(space));
  const deduped = new Map();
  for (const device of devices) {
    const key = String(device.name || '').replace(/\s+/g, ' ').trim();
    const existing = deduped.get(key);
    if (!existing || (existing.domain === 'light' && device.domain === 'switch')) deduped.set(key, device);
  }
  devices = [...deduped.values()];
  const exact = devices.filter(device => String(device.name || '') === keyword);
  const candidates = exact.length ? exact : devices;
  draft.explanation = draft.explanation || {};
  draft.explanation.targetCandidates = candidates.slice(0, 5).map(device => ({ entityId: device.entityId, name: device.name, state: device.state?.value }));
  if (candidates.length === 1) {
    const device = candidates[0];
    return bindRuleTarget(draft, device.entityId, snapshot);
  } else if (candidates.length > 1) {
    draft.explanation.requiresTargetConfirmation = true;
    draft.explanation.stability = [...(draft.explanation.stability || []), `发现 ${candidates.length} 个候选设备，需要先确认具体目标`];
  } else {
    draft.explanation.requiresTargetConfirmation = true;
    draft.explanation.stability = [...(draft.explanation.stability || []), '尚未找到名称完全对应的目标设备，授权前需要确认'];
  }
  return draft;
}

function bindRuleTarget(draft, entityId, snapshot) {
  const device = snapshot?.devices?.[entityId];
  if (!device || device.available === false || !['light', 'switch', 'fan', 'climate'].includes(device.domain)) {
    throw new Error('目标设备不可用或不支持自动控制');
  }
  const opening = /^(打开|开启|启动)/.test(String(draft.action || ''));
  const closing = /^关闭/.test(String(draft.action || ''));
  if (!opening && !closing) throw new Error('当前只支持绑定打开或关闭类动作');
  draft.policy.conditions = (draft.policy.conditions || []).filter(condition => condition.kind !== 'device');
  draft.policy.conditions.push({ kind: 'device', entityId, operator: 'eq', value: opening ? 'off' : 'on', label: `${device.name}当前${opening ? '关闭' : '开启'}` });
  draft.policy.actionTarget = { entityId, domain: device.domain, service: opening ? 'turn_on' : 'turn_off' };
  draft.explanation = draft.explanation || {};
  draft.explanation.requiresTargetConfirmation = false;
  draft.explanation.targetEntityId = entityId;
  draft.explanation.sources = [...new Set([...(draft.explanation.sources || []), '目标设备当前状态'])];
  return draft;
}

module.exports = { compileRuleIntent, evaluatePolicy, attachDeviceGuard, bindRuleTarget };
