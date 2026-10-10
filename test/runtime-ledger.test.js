const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { RuntimeLedger } = require('../lib/runtime-ledger');

test('SQLite ledger stores indexed events and calculates a rolling quality window', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-ledger-'));
  const ledger = new RuntimeLedger(path.join(dir, 'runtime.sqlite'));
  const now = Date.now();
  ledger.appendEvents([
    { id: '1', type: 'command.verified', occurredAt: now, correlationId: 'a' },
    { id: '2', type: 'command.failed', occurredAt: now + 1, correlationId: 'b' },
    { id: '3', type: 'rule.observed', occurredAt: now + 2, correlationId: 'c' }
  ]);
  assert.equal(ledger.recentEvents({ limit: 2 })[0].id, '3');
  assert.equal(ledger.recentEvents({ type: 'command.failed' })[0].id, '2');
  const quality = ledger.qualityWindow(7, now + 3);
  assert.equal(quality.commandAttempts, 2);
  assert.equal(quality.verified, 1);
  assert.equal(quality.failed, 1);
  assert.equal(quality.observationMatches, 1);
  assert.equal(quality.verificationRate, 50);
  assert.equal(quality.failureRate, 50);
  ledger.close();
});
