const test = require('node:test');
const assert = require('node:assert/strict');
const { parseTimeRange, answerHouseholdHistoryQuestion } = require('../lib/home-history-qa');

const rooms = [{ id: 'living_room', name: '客厅' }, { id: 'study', name: '书房' }];

test('今天下午 resolves to noon through the current time', () => {
  const now = new Date(2026, 7, 15, 15, 30).getTime();
  const range = parseTimeRange('今天下午客厅有人吗', now);
  assert.equal(new Date(range.since).getHours(), 12);
  assert.equal(range.until, now);
  assert.equal(range.label, '今天下午');
});

test('presence history answers from local evidence with source and time coverage', () => {
  const now = new Date(2026, 7, 15, 16, 0).getTime();
  const events = [
    { type: 'space.occupancy.observed', spaceId: 'living_room', occurredAt: new Date(2026, 7, 15, 13, 10).getTime(), confidence: 0.8, source: { adapter: 'ha' }, payload: { active: true, spaceName: '客厅' } },
    { type: 'space.occupancy.observed', spaceId: 'living_room', occurredAt: new Date(2026, 7, 15, 14, 20).getTime(), confidence: 0.7, source: { adapter: 'camera' }, payload: { active: true, spaceName: '客厅' } },
    { type: 'space.occupancy.observed', spaceId: 'study', occurredAt: new Date(2026, 7, 15, 14, 30).getTime(), confidence: 0.9, source: { adapter: 'ha' }, payload: { active: false, spaceName: '书房' } }
  ];
  const ledger = { eventsBetween: ({ since, until }) => events.filter(event => event.occurredAt >= since && event.occurredAt <= until) };
  const answer = answerHouseholdHistoryQuestion({ text: '今天下午客厅有人吗', rooms, ledger, currentState: {}, now });
  assert.equal(answer.ok, true);
  assert.equal(answer.occupiedEvidence, 2);
  assert.match(answer.reply, /今天下午客厅有人/);
  assert.match(answer.reply, /13:10到14:20之间多次/);
  assert.match(answer.reply, /人体传感器和摄像头/);
});

test('absence answer states evidence limits instead of claiming certainty', () => {
  const now = new Date(2026, 7, 15, 16, 0).getTime();
  const ledger = { eventsBetween: () => [{ type: 'space.occupancy.observed', spaceId: 'living_room', occurredAt: now - 1000, confidence: 0.8, source: { adapter: 'ha' }, payload: { active: false } }] };
  const answer = answerHouseholdHistoryQuestion({ text: '今天下午客厅有人吗', rooms, ledger, currentState: {}, now });
  assert.match(answer.reply, /没有检测到有人/);
  assert.match(answer.reply, /现有传感器覆盖范围/);
});

test('current presence uses the fused household state without reading history', () => {
  const now = Date.now();
  const answer = answerHouseholdHistoryQuestion({
    text: '客厅现在有人吗', rooms, ledger: { eventsBetween: () => { throw new Error('history should not be queried'); } }, now,
    currentState: { spaces: { living_room: { id: 'living_room', name: '客厅', occupancy: { value: 'occupied', confidence: 0.82, updatedAt: now - 4000 } } } }
  });
  assert.match(answer.reply, /客厅现在有人/);
  assert.match(answer.reply, /82%/);
  assert.match(answer.reply, /4秒前/);
});

test('which-room question aggregates only reliable occupied spaces', () => {
  const answer = answerHouseholdHistoryQuestion({
    text: '现在哪个房间有人', rooms: [...rooms, { id: 'kitchen', name: '厨房' }], ledger: { eventsBetween: () => { throw new Error('history should not be queried'); } },
    currentState: { spaces: {
      living_room: { id: 'living_room', name: '客厅', occupancy: { value: 'occupied', confidence: 0.84 } },
      study: { id: 'study', name: '书房', occupancy: { value: 'vacant', confidence: 0.91 } },
      kitchen: { id: 'kitchen', name: '厨房', occupancy: { value: 'unknown', confidence: 0.2 } }
    } }
  });
  assert.equal(answer.answerType, 'presence_current_rooms');
  assert.deepEqual(answer.occupiedRooms, ['客厅']);
  assert.match(answer.reply, /目前客厅有人/);
  assert.match(answer.reply, /厨房目前证据不足/);
  assert.doesNotMatch(answer.reply, /书房有人/);
});

test('which-room question does not turn unknown spaces into occupancy', () => {
  const answer = answerHouseholdHistoryQuestion({
    text: '现在哪里有人', rooms, ledger: { eventsBetween: () => [] },
    currentState: { spaces: { living_room: { id: 'living_room', occupancy: { value: 'unknown', confidence: 0 } } } }
  });
  assert.equal(answer.ok, false);
  assert.deepEqual(answer.occupiedRooms, []);
  assert.match(answer.reply, /没有可靠证据/);
});

test('missing room asks a clarification and never guesses', () => {
  const answer = answerHouseholdHistoryQuestion({ text: '今天下午有人吗', rooms, ledger: { eventsBetween: () => [] }, currentState: {} });
  assert.equal(answer.answerType, 'clarification');
  assert.match(answer.reply, /哪个房间/);
});
