/**
 * HTTP bodies arrive at arbitrary byte boundaries. Decode only after all
 * chunks are joined so a multi-byte Chinese character can never be split into
 * Unicode replacement characters.
 */

function decodeUtf8Body(chunks) {
  const buffers = (chunks || []).map(chunk => Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(buffers).toString('utf8');
}

module.exports = { decodeUtf8Body };
