/**
 * Deterministic household-history questions over NOVA's local event ledger.
 * Answers never invoke device control and explicitly surface missing evidence.
 */

function startOfDay(timestamp) {
  const date = new Date(timestamp);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function parseNumber(text) {
  const digit = text.match(/(\d+(?:\.\d+)?)/)?.[1];
  if (digit) return Number(digit);
  const zh = { 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 半: 0.5 };
  return Object.entries(zh).find(([key]) => text.includes(key))?.[1] || null;
}

function parseTimeRange(text, now = Date.now()) {
  const input = String(text || '');
  const recent = input.match(/(?:最近|过去)([一二两三四五六七八九十半\d.]+)(分钟|小时)/);
  if (recent) {
    const amount = parseNumber(recent[1]);
    const unitMs = recent[2] === '小时' ? 3600000 : 60000;
    if (amount) return { since: now - amount * unitMs, until: now, label: `过去${recent[1]}${recent[2]}`, historical: true };
  }
  const dayOffset = /(昨天|昨日|昨晚)/.test(input) ? -1 : 0;
  const hasDay = dayOffset === -1 || /(今天|今日|今早|今晚)/.test(input);
  const periods = [
    { pattern: /(凌晨)/, start: 0, end: 6, label: '凌晨' },
    { pattern: /(早上|上午|今早)/, start: 6, end: 12, label: '上午' },
    { pattern: /(中午)/, start: 11, end: 14, label: '中午' },
    { pattern: /(下午)/, start: 12, end: 18, label: '下午' },
    { pattern: /(晚上|晚间|今晚|昨晚)/, start: 18, end: 24, label: '晚上' }
  ];
  const period = periods.find(item => item.pattern.test(input));
  if (!hasDay && !period) return null;
  const base = startOfDay(now) + dayOffset * 86400000;
  const since = base + (period?.start || 0) * 3600000;
  const nominalUntil = base + (period?.end || 24) * 3600000;
  const until = dayOffset === 0 ? Math.min(now, nominalUntil) : nominalUntil;
  const dayLabel = dayOffset === -1 ? '昨天' : '今天';
  return { since, until, label: `${dayLabel}${period?.label || ''}`, historical: true, future: since > now };
}

function resolveRoom(text, rooms = []) {
  return rooms.find(room => String(text).includes(room.name) || String(text).includes(room.id)) || null;
}

function formatClock(timestamp) {
  return new Date(timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function sourceName(event) {
  if (event.source?.adapter === 'camera') return '摄像头';
  if (event.source?.adapter === 'ha') return event.payload?.sourceLabel || '人体传感器';
  return event.source?.adapter || '家庭感知';
}

function roomMatches(event, room) {
  if (!room) return false;
  return [room.id, room.name].includes(event.spaceId) || [room.id, room.name].includes(event.payload?.spaceName);
}

function answerPresenceHistory({ text, room, range, ledger }) {
  const events = ledger.eventsBetween({ since: range.since, until: range.until, types: ['space.occupancy.observed'] })
    .filter(event => roomMatches(event, room));
  const reliable = events.filter(event => Number(event.confidence ?? 1) >= 0.55);
  const occupied = reliable.filter(event => event.payload?.active === true);
  const vacant = reliable.filter(event => event.payload?.active === false);
  const sources = [...new Set(reliable.map(sourceName))];
  if (!reliable.length) {
    return { ok: false, answerType: 'presence_history', reply: `${range.label}${room.name}没有足够的感知记录，我无法确认是否有人。`, evidenceCount: 0, source: 'local_history' };
  }
  if (occupied.length) {
    const first = occupied[0].occurredAt, last = occupied.at(-1).occurredAt;
    const when = first === last ? formatClock(first) : `${formatClock(first)}到${formatClock(last)}`;
    const coverage = vacant.length ? '其他时段也有无人记录' : '没有足够证据覆盖整个时段';
    return {
      ok: true, answerType: 'presence_history',
      reply: `${range.label}${room.name}有人。${when}${first === last ? '' : '之间多次'}检测到有人；${coverage}。证据来自${sources.join('和')}。`,
      evidenceCount: reliable.length, occupiedEvidence: occupied.length, source: 'local_history'
    };
  }
  return {
    ok: true, answerType: 'presence_history',
    reply: `${range.label}${room.name}有${vacant.length}条有效无人记录，没有检测到有人；这只代表现有传感器覆盖范围。证据来自${sources.join('和')}。`,
    evidenceCount: reliable.length, occupiedEvidence: 0, source: 'local_history'
  };
}

function answerCurrentPresence({ room, currentState, now = Date.now() }) {
  const space = Object.values(currentState?.spaces || {}).find(item => [room.id, room.name].includes(item.id) || item.name === room.name);
  const occupancy = space?.occupancy;
  if (!occupancy || occupancy.value === 'unknown') return { ok: false, answerType: 'presence_current', reply: `目前没有足够证据确认${room.name}是否有人。`, source: 'home_state' };
  const ageSeconds = occupancy.updatedAt ? Math.max(0, Math.round((now - occupancy.updatedAt) / 1000)) : null;
  return {
    ok: true, answerType: 'presence_current',
    reply: `${room.name}现在${occupancy.value === 'occupied' ? '有人' : '没人'}，置信度${Math.round((occupancy.confidence || 0) * 100)}%${ageSeconds === null ? '' : `，证据更新于${ageSeconds}秒前`}。`,
    source: 'home_state'
  };
}

/**
 * Answers whole-home "which room" questions from fused current state only.
 * Unknown or low-confidence spaces are never promoted to occupied, because an
 * aggregate answer can otherwise amplify one bad sensor into a household claim.
 */
function answerCurrentPresenceByRoom({ rooms, currentState }) {
  const spaces = Object.values(currentState?.spaces || {});
  const readings = (rooms || []).map(room => {
    const space = spaces.find(item => [room.id, room.name].includes(item.id) || item.name === room.name);
    return { room, occupancy: space?.occupancy };
  });
  const reliable = readings.filter(item => item.occupancy && item.occupancy.value !== 'unknown' && Number(item.occupancy.confidence || 0) >= 0.55);
  const occupied = reliable.filter(item => item.occupancy.value === 'occupied').map(item => item.room.name);
  const uncertain = readings.filter(item => !item.occupancy || item.occupancy.value === 'unknown' || Number(item.occupancy.confidence || 0) < 0.55).map(item => item.room.name);

  if (occupied.length) {
    const uncertainty = uncertain.length ? `；${uncertain.join('、')}目前证据不足` : '';
    return { ok: true, answerType: 'presence_current_rooms', reply: `目前${occupied.join('、')}有人${uncertainty}。`, occupiedRooms: occupied, uncertainRooms: uncertain, source: 'home_state' };
  }
  if (reliable.length && !uncertain.length) {
    return { ok: true, answerType: 'presence_current_rooms', reply: '目前已配置的空间都没有检测到有人。', occupiedRooms: [], uncertainRooms: [], source: 'home_state' };
  }
  return { ok: false, answerType: 'presence_current_rooms', reply: `目前没有可靠证据确认哪个房间有人${uncertain.length ? `；${uncertain.join('、')}的状态无法确认` : ''}。`, occupiedRooms: [], uncertainRooms: uncertain, source: 'home_state' };
}

function answerHouseholdHistoryQuestion({ text, rooms, ledger, currentState, now = Date.now() }) {
  const input = String(text || '').trim();
  const asksPresence = /(有人|没人|无人|是否有(?:人)?|出现过人)/.test(input);
  if (!asksPresence) return null;
  const asksWhichRoom = /(哪个|哪些|什么)房间|哪里|哪儿/.test(input);
  const range = parseTimeRange(input, now);
  if (asksWhichRoom && !range) return answerCurrentPresenceByRoom({ rooms, currentState });
  const room = resolveRoom(input, rooms);
  if (!room) return { ok: false, answerType: 'clarification', reply: '你想查询哪个房间？例如可以问“今天下午客厅有人吗”。', source: 'local_history' };
  if (!range) return answerCurrentPresence({ room, currentState, now });
  if (range.future) return { ok: false, answerType: 'future', reply: `${range.label}还没开始，暂时没有可查询的记录。`, source: 'local_history' };
  return answerPresenceHistory({ text: input, room, range, ledger });
}

module.exports = { parseTimeRange, resolveRoom, answerCurrentPresenceByRoom, answerHouseholdHistoryQuestion };
