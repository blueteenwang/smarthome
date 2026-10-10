const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeJsonAtomic } = require('../lib/atomic-json');

test('atomic JSON replacement leaves one complete document and no next file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-json-'));
  const file = path.join(dir, 'config.json');
  writeJsonAtomic(file, { revision: 1 });
  writeJsonAtomic(file, { revision: 2, nested: { ok: true } });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { revision: 2, nested: { ok: true } });
  assert.equal(fs.existsSync(`${file}.next`), false);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});
