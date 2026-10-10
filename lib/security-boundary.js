/**
 * HomeSense local-network security boundary.
 *
 * Localhost remains zero-configuration. Binding to a LAN interface is an
 * explicit trust expansion and therefore requires a shared access token.
 */
const crypto = require('crypto');

function isLoopbackHost(host) {
  return ['127.0.0.1', '::1', 'localhost'].includes(String(host || '').toLowerCase());
}

function resolveSecurity(config = {}, env = process.env) {
  const server = config.server || {};
  const host = env.HOMESENSE_HOST || env.HAVENMIND_HOST || env.NOVA_HOST || server.host || '127.0.0.1';
  const accessToken = env.HOMESENSE_ACCESS_TOKEN || env.HAVENMIND_ACCESS_TOKEN || env.NOVA_ACCESS_TOKEN || server.accessToken || '';
  const allowedOrigins = Array.isArray(server.allowedOrigins) ? server.allowedOrigins.filter(Boolean) : [];
  if (!isLoopbackHost(host) && accessToken.length < 24) {
    throw new Error('知家监听局域网时必须设置至少 24 位的 HOMESENSE_ACCESS_TOKEN（兼容 NOVA_ACCESS_TOKEN）；本机使用请保持 server.host=127.0.0.1');
  }
  return { host, accessToken, allowedOrigins, localOnly: isLoopbackHost(host) };
}

function safeEqual(actual, expected) {
  const left = Buffer.from(String(actual || ''));
  const right = Buffer.from(String(expected || ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function authenticateRequest(req, security) {
  if (security.localOnly) return true;
  const authorization = String(req.headers.authorization || '');
  const bearer = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
  if (safeEqual(bearer, security.accessToken)) return true;
  if (authorization.startsWith('Basic ')) {
    try {
      const decoded = Buffer.from(authorization.slice(6), 'base64').toString('utf8');
      const separator = decoded.indexOf(':');
      return separator >= 0 && safeEqual(decoded.slice(separator + 1), security.accessToken);
    } catch { return false; }
  }
  return false;
}

function corsOrigin(req, security) {
  const origin = req.headers.origin;
  if (!origin) return null;
  if (security.localOnly && /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(origin)) return origin;
  return security.allowedOrigins.includes(origin) ? origin : null;
}

module.exports = { resolveSecurity, authenticateRequest, corsOrigin, isLoopbackHost };
