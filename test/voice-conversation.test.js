const test = require('node:test');
const assert = require('node:assert/strict');
const { VoiceConversationSession, expandHouseholdFollowUp } = require('../lib/voice-conversation');

test('continuous conversation accepts turns until idle timeout', () => {
  const session = new VoiceConversationSession({ idleTimeoutMs: 30_000, maxTurns: 3 });
  session.start('贾维斯', 1_000);
  assert.equal(session.isActive(20_000), true);
  session.addExchange('你好', '你好呀', { source: 'llm' }, 20_000);
  assert.equal(session.status(45_000).active, true);
  assert.equal(session.status(51_000).active, false);
  assert.equal(session.status(51_000).endReason, 'idle_timeout');
});

test('conversation history is bounded and formatted for chat completion', () => {
  const session = new VoiceConversationSession({ maxTurns: 2 });
  session.start('贾维斯', 1_000);
  session.addExchange('一', '答一', {}, 2_000);
  session.addExchange('二', '答二', {}, 3_000);
  session.addExchange('三', '答三', {}, 4_000);
  assert.deepEqual(session.messages(), [
    { role: 'user', content: '二' },
    { role: 'assistant', content: '答二' },
    { role: 'user', content: '三' },
    { role: 'assistant', content: '答三' }
  ]);
});

test('explicit exit phrases end a conversation', () => {
  const session = new VoiceConversationSession();
  session.start('贾维斯', 1_000);
  assert.equal(session.shouldExit('不用了'), true);
  assert.equal(session.end('user_exit'), true);
  assert.equal(session.isActive(2_000), false);
});

test('household room follow-up inherits the prior factual question', () => {
  const rooms = ['客厅', '主卧', '书房'];
  assert.equal(
    expandHouseholdFollowUp('那主卧呢', '今天下午客厅有人吗', rooms),
    '今天下午主卧有人吗'
  );
  assert.equal(
    expandHouseholdFollowUp('那书房呢', '客厅温度多少度', rooms),
    '书房温度多少度'
  );
});

test('explicit current intent is never replaced by conversation history', () => {
  assert.equal(
    expandHouseholdFollowUp('主卧温度多少度', '客厅有人吗', ['客厅', '主卧']),
    '主卧温度多少度'
  );
});
