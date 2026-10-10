const test = require('node:test');
const assert = require('node:assert/strict');
const { isVisualQuestion } = require('../lib/visual-question');

test('object and activity questions use the latest camera frame', () => {
  assert.equal(isVisualQuestion('客厅有花吗'), true);
  assert.equal(isVisualQuestion('画面里有没有杯子'), true);
  assert.equal(isVisualQuestion('王小明在做什么'), true);
});

test('occupancy and device commands never enter visual chat', () => {
  assert.equal(isVisualQuestion('客厅现在有人吗'), false);
  assert.equal(isVisualQuestion('打开客厅灯'), false);
  assert.equal(isVisualQuestion('主卧温度多少'), false);
});
