const test = require('node:test');
const assert = require('node:assert/strict');
const { answerDeviceStatusQuestion, parseDeviceStatusQuestion } = require('../lib/device-status-qa');

const rooms = [{ name: '客厅' }, { name: '主卧' }];

test('answers television state from HA instead of general chat', () => {
  const answer = answerDeviceStatusQuestion({
    text: '电视是开着的吗', rooms,
    states: [{ entity_id: 'media_player.living_room_tv', state: 'playing', attributes: { friendly_name: '客厅电视', device_class: 'tv' } }]
  });
  assert.equal(answer.source, 'home_assistant');
  assert.equal(answer.reply, '客厅电视正在播放。');
});

test('room-qualified television questions select only that room', () => {
  const answer = answerDeviceStatusQuestion({
    text: '主卧电视关了吗', rooms,
    states: [
      { entity_id: 'media_player.living_tv', state: 'playing', attributes: { friendly_name: '客厅电视' } },
      { entity_id: 'media_player.bedroom_tv', state: 'off', attributes: { friendly_name: '主卧电视' } }
    ]
  });
  assert.equal(answer.reply, '主卧电视已关闭。');
});

test('device control commands do not enter read-only status QA', () => {
  assert.equal(parseDeviceStatusQuestion('关闭客厅电视', rooms), null);
  assert.equal(parseDeviceStatusQuestion('帮我打开电视', rooms), null);
});

test('unavailable device state is reported honestly', () => {
  const answer = answerDeviceStatusQuestion({
    text: '电视现在是什么状态', rooms,
    states: [{ entity_id: 'media_player.tv', state: 'unavailable', attributes: { friendly_name: '客厅电视' } }]
  });
  assert.equal(answer.ok, false);
  assert.equal(answer.reply, '客厅电视当前状态不可用。');
});

test('recognizes a television exposed by its brand and ignores stale duplicates', () => {
  const answer = answerDeviceStatusQuestion({
    text: '电视开着吗', rooms,
    states: [
      { entity_id: 'media_player.bravia_5_5', state: 'idle', attributes: { friendly_name: 'BRAVIA 5' } },
      { entity_id: 'media_player.bravia_5', state: 'unavailable', attributes: {} }
    ]
  });
  assert.equal(answer.reply, 'BRAVIA 5已开启，当前空闲。');
});
