/**
 * Deterministic read-only answers for current Home Assistant device state.
 * Device facts must come from HA rather than the general chat model, which has
 * no access to the user's home and otherwise tends to answer with a refusal.
 */

const DEVICE_TYPES = [
  // HA integrations often expose televisions by brand (for example BRAVIA)
  // instead of putting “电视” in friendly_name.
  { words: ['电视', '电视机', 'TV'], domains: ['media_player'], matches: entity => /电视|\btv\b|bravia/i.test(`${entityName(entity)} ${entity.entity_id || ''}`) || entity.attributes?.device_class === 'tv' },
  { words: ['空调', '冷气'], domains: ['climate'] },
  { words: ['灯', '灯光'], domains: ['light'] },
  { words: ['风扇'], domains: ['fan'] },
  { words: ['窗帘', '纱帘'], domains: ['cover'] },
  { words: ['加湿器'], domains: ['humidifier'] },
  { words: ['扫地机', '扫地机器人'], domains: ['vacuum'] }
];

function entityName(entity) {
  return String(entity?.attributes?.friendly_name || entity?.entity_id || '');
}

function parseDeviceStatusQuestion(text, rooms = []) {
  const normalized = String(text || '').trim();
  if (!normalized || !/(吗|没|是否|是不是|有没有|状态|开着|关着|开启|关闭|打开|运行)/.test(normalized)) return null;
  // Commands are handled by the control pipeline, never by this read-only path.
  if (/^(请|麻烦|帮我|给我|把|打开|开启|关闭|关掉|启动|停止)/.test(normalized)) return null;
  const type = DEVICE_TYPES.find(item => item.words.some(word => normalized.toLowerCase().includes(word.toLowerCase())));
  if (!type) return null;
  const room = rooms.map(item => typeof item === 'string' ? item : item?.name).filter(Boolean).find(name => normalized.includes(name)) || '';
  return { type, room };
}

function readableState(entity) {
  const state = String(entity?.state || '').toLowerCase();
  if (['unknown', 'unavailable', 'none', ''].includes(state)) return { known: false, text: '当前状态不可用' };
  const domain = String(entity?.entity_id || '').split('.')[0];
  if (domain === 'cover') {
    if (state === 'open' || state === 'opening') return { known: true, on: true, text: state === 'opening' ? '正在打开' : '已打开' };
    if (state === 'closed' || state === 'closing') return { known: true, on: false, text: state === 'closing' ? '正在关闭' : '已关闭' };
  }
  if (domain === 'media_player') {
    if (['off', 'standby'].includes(state)) return { known: true, on: false, text: '已关闭' };
    if (['on', 'playing', 'paused', 'buffering', 'idle'].includes(state)) {
      const detail = { playing: '正在播放', paused: '已开启，当前暂停', buffering: '已开启，正在加载', idle: '已开启，当前空闲' }[state];
      return { known: true, on: true, text: detail || '已开启' };
    }
  }
  if (domain === 'climate') return state === 'off'
    ? { known: true, on: false, text: '已关闭' }
    : { known: true, on: true, text: `已开启，当前为${entity.attributes?.hvac_action || state}模式` };
  if (state === 'off') return { known: true, on: false, text: '已关闭' };
  if (state === 'on') return { known: true, on: true, text: '已开启' };
  return { known: true, on: true, text: `当前状态为${entity.state}` };
}

function answerDeviceStatusQuestion({ text, states = [], rooms = [] }) {
  const query = parseDeviceStatusQuestion(text, rooms);
  if (!query) return null;
  let matches = states.filter(entity => {
    const domain = String(entity?.entity_id || '').split('.')[0];
    if (!query.type.domains.includes(domain)) return false;
    if (query.room && !entityName(entity).includes(query.room)) return false;
    return !query.type.matches || query.type.matches(entity);
  });
  if (!matches.length) {
    const target = `${query.room}${query.type.words[0]}`;
    return { ok: false, reply: `Home Assistant 中没有找到${target}。`, source: 'home_assistant' };
  }
  // HA can retain unavailable duplicate entities after an integration is
  // re-added. Prefer live entities so one physical TV produces one useful fact.
  const available = matches.filter(entity => !['unknown', 'unavailable'].includes(String(entity.state).toLowerCase()));
  if (available.length) matches = available;
  const facts = matches.map(entity => ({ name: entityName(entity), ...readableState(entity) }));
  const reply = facts.map(fact => `${fact.name}${fact.text}`).join('；') + '。';
  return { ok: facts.some(fact => fact.known), reply, source: 'home_assistant' };
}

module.exports = { parseDeviceStatusQuestion, answerDeviceStatusQuestion, readableState };
