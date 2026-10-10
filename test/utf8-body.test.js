const test = require('node:test');
const assert = require('node:assert/strict');
const { decodeUtf8Body } = require('../lib/utf8-body');

test('decodes Chinese text when every byte arrives in a separate chunk', () => {
  const source = JSON.stringify({ friendly_name: '走廊左三键 客厅氛围灯 接线方式' });
  const bytes = Buffer.from(source, 'utf8');
  const chunks = [...bytes].map(byte => Buffer.from([byte]));
  const decoded = decodeUtf8Body(chunks);
  assert.equal(decoded, source);
  assert.equal(decoded.includes('�'), false);
});

test('accepts a mix of buffers and strings', () => {
  assert.equal(decodeUtf8Body([Buffer.from('NOVA '), '家庭']), 'NOVA 家庭');
});
