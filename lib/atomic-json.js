/** Durable JSON persistence shared by runtime configuration and local ledgers. */
const fs = require('fs');
const path = require('path');

/**
 * Writes a complete JSON document beside its destination and atomically swaps
 * it into place. Readers therefore see either the old or the new valid file.
 */
function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const nextPath = `${filePath}.next`;
  fs.writeFileSync(nextPath, JSON.stringify(value, null, 2), { mode: 0o600 });
  try {
    fs.renameSync(nextPath, filePath);
  } catch (error) {
    // Docker single-file bind mounts cannot be replaced by rename. Preserve
    // compatibility with that deployment shape while keeping ordinary local
    // and directory-mounted storage atomic.
    if (!['EBUSY', 'EXDEV', 'EPERM'].includes(error.code)) throw error;
    fs.copyFileSync(nextPath, filePath);
    fs.unlinkSync(nextPath);
  }
}

module.exports = { writeJsonAtomic };
