const test = require('node:test');
const assert = require('node:assert/strict');

const { HaRealtimeClient, websocketUrl } = require('../lib/ha-realtime');

class FakeWebSocket {
  constructor(url) {
    this.url = url;
    this.listeners = {};
    this.sent = [];
    FakeWebSocket.instance = this;
  }
  addEventListener(type, listener) { this.listeners[type] = listener; }
  send(message) { this.sent.push(JSON.parse(message)); }
  close() {}
  emit(type, data) { this.listeners[type]?.({ data: JSON.stringify(data) }); }
}

test('HA URL becomes a websocket endpoint', () => {
  assert.equal(websocketUrl('https://ha.example.com:8123/'), 'wss://ha.example.com:8123/api/websocket');
});

test('client authenticates, subscribes and forwards state changes', () => {
  const received = [];
  const client = new HaRealtimeClient({
    url: 'http://ha.local:8123',
    token: 'token',
    WebSocketImpl: FakeWebSocket,
    onStateChanged: (state, occurredAt) => received.push({ state, occurredAt })
  });
  client.start();
  const socket = FakeWebSocket.instance;
  socket.emit('message', { type: 'auth_required' });
  socket.emit('message', { type: 'auth_ok' });
  assert.deepEqual(socket.sent, [
    { type: 'auth', access_token: 'token' },
    { id: 1, type: 'subscribe_events', event_type: 'state_changed' }
  ]);

  socket.emit('message', {
    type: 'event',
    event: {
      event_type: 'state_changed',
      time_fired: '2026-08-14T11:00:00.000Z',
      data: { new_state: { entity_id: 'light.study', state: 'on', attributes: {} } }
    }
  });
  assert.equal(received[0].state.entity_id, 'light.study');
  assert.equal(received[0].occurredAt, Date.parse('2026-08-14T11:00:00.000Z'));
  client.stop();
});
