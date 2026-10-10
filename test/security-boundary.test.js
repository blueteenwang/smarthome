const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveSecurity, authenticateRequest, corsOrigin } = require('../lib/security-boundary');

test('localhost remains zero-configuration and rejects unrelated web origins', () => {
  const security = resolveSecurity({ server: {} }, {});
  assert.equal(security.host, '127.0.0.1');
  assert.equal(authenticateRequest({ headers: {} }, security), true);
  assert.equal(corsOrigin({ headers: { origin: 'http://localhost:8090' } }, security), 'http://localhost:8090');
  assert.equal(corsOrigin({ headers: { origin: 'https://attacker.example' } }, security), null);
});

test('LAN binding refuses to start without a strong access token', () => {
  assert.throws(() => resolveSecurity({ server: { host: '0.0.0.0' } }, {}), /NOVA_ACCESS_TOKEN/);
});

test('HomeSense environment settings override legacy names while old deployments still work', () => {
  const legacy = { NOVA_HOST: '0.0.0.0', NOVA_ACCESS_TOKEN: 'legacy-token-with-at-least-24-characters' };
  assert.equal(resolveSecurity({}, legacy).accessToken, legacy.NOVA_ACCESS_TOKEN);
  const interim = { ...legacy, HAVENMIND_HOST: '127.0.0.1', HAVENMIND_ACCESS_TOKEN: 'interim-token-with-at-least-24-characters' };
  assert.equal(resolveSecurity({}, interim).host, interim.HAVENMIND_HOST);
  assert.equal(resolveSecurity({}, interim).accessToken, interim.HAVENMIND_ACCESS_TOKEN);
  const current = { ...interim, HOMESENSE_HOST: '0.0.0.0', HOMESENSE_ACCESS_TOKEN: 'current-token-with-at-least-24-characters' };
  const security = resolveSecurity({}, current);
  assert.equal(security.host, current.HOMESENSE_HOST);
  assert.equal(security.accessToken, current.HOMESENSE_ACCESS_TOKEN);
  assert.throws(() => resolveSecurity({}, { ...current, HOMESENSE_HOST: '0.0.0.0', HOMESENSE_ACCESS_TOKEN: 'short' }), /HOMESENSE_ACCESS_TOKEN/);
});

test('LAN binding accepts bearer and browser basic authentication', () => {
  const token = 'a-secure-token-with-24-characters';
  const security = resolveSecurity({ server: { host: '0.0.0.0', accessToken: token } }, {});
  assert.equal(authenticateRequest({ headers: { authorization: `Bearer ${token}` } }, security), true);
  assert.equal(authenticateRequest({ headers: { authorization: `Basic ${Buffer.from(`nova:${token}`).toString('base64')}` } }, security), true);
  assert.equal(authenticateRequest({ headers: { authorization: 'Bearer wrong' } }, security), false);
});
