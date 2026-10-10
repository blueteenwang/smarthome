/**
 * Home Assistant WebSocket subscriber.
 *
 * REST polling remains the recovery path, while this client delivers
 * state_changed events with sub-second latency during normal operation.
 */

function websocketUrl(baseUrl) {
  const target = new URL(baseUrl);
  target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:';
  target.pathname = `${target.pathname.replace(/\/$/, '')}/api/websocket`;
  target.search = '';
  return target.toString();
}

class HaRealtimeClient {
  constructor(options) {
    this.url = websocketUrl(options.url);
    this.token = options.token;
    this.onStateChanged = options.onStateChanged || (() => {});
    this.onStatus = options.onStatus || (() => {});
    this.WebSocketImpl = options.WebSocketImpl || globalThis.WebSocket;
    this.socket = null;
    this.reconnectTimer = null;
    this.stopped = true;
    this.retryCount = 0;
    this.status = { connected: false, authenticated: false, lastEventAt: null, latencyMs: null, retryCount: 0 };
  }

  publishStatus(patch) {
    this.status = { ...this.status, ...patch };
    this.onStatus({ ...this.status });
  }

  start() {
    if (!this.WebSocketImpl) throw new Error('WebSocket client is unavailable');
    this.stopped = false;
    this.connect();
  }

  connect() {
    if (this.stopped) return;
    try {
      const socket = new this.WebSocketImpl(this.url);
      this.socket = socket;
      socket.addEventListener('open', () => this.publishStatus({ connected: true, authenticated: false }));
      socket.addEventListener('message', message => this.handleMessage(message.data));
      socket.addEventListener('close', () => this.scheduleReconnect('连接已断开'));
      socket.addEventListener('error', () => this.publishStatus({ connected: false, authenticated: false, error: 'WebSocket 连接失败' }));
    } catch (error) {
      this.scheduleReconnect(error.message);
    }
  }

  handleMessage(raw) {
    let message;
    try { message = JSON.parse(String(raw)); } catch { return; }
    if (message.type === 'auth_required') {
      this.socket?.send(JSON.stringify({ type: 'auth', access_token: this.token }));
      return;
    }
    if (message.type === 'auth_ok') {
      this.retryCount = 0;
      this.socket?.send(JSON.stringify({ id: 1, type: 'subscribe_events', event_type: 'state_changed' }));
      this.publishStatus({ authenticated: true, error: null, retryCount: 0 });
      return;
    }
    if (message.type === 'auth_invalid') {
      this.publishStatus({ authenticated: false, error: 'HA 实时连接鉴权失败' });
      this.stop();
      return;
    }
    const event = message.type === 'event' ? message.event : null;
    if (event?.event_type !== 'state_changed') return;
    const receivedAt = Date.now();
    const occurredAt = Date.parse(event.time_fired) || receivedAt;
    this.publishStatus({
      connected: true,
      authenticated: true,
      lastEventAt: receivedAt,
      latencyMs: Math.max(0, receivedAt - occurredAt)
    });
    if (event.data?.new_state) this.onStateChanged(event.data.new_state, occurredAt);
  }

  scheduleReconnect(error) {
    if (this.stopped) return;
    this.socket = null;
    this.retryCount += 1;
    const delay = Math.min(30000, 1000 * (2 ** Math.min(this.retryCount - 1, 5)));
    this.publishStatus({ connected: false, authenticated: false, error, retryCount: this.retryCount, reconnectInMs: delay });
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    try { this.socket?.close(); } catch {}
    this.socket = null;
    this.publishStatus({ connected: false, authenticated: false, reconnectInMs: null });
  }

  snapshot() {
    return { ...this.status, url: this.url.replace(/\/api\/websocket$/, '/api/websocket') };
  }
}

module.exports = { HaRealtimeClient, websocketUrl };
