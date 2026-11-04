#!/usr/bin/env node
// Run only while HomeSense is stopped. Backups contain private household data.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const files = ['.env', 'config.json', 'memory.json', 'activity-history.json', 'decision-quality.json', 'home-state.json', 'home-events.json', 'nova-runtime.sqlite', 'nova-runtime.sqlite-wal', 'nova-runtime.sqlite-shm'];
const dirs = ['config', 'runtime', 'face-data'];
function copy(source, target) {
  if (!fs.existsSync(source)) return;
  if (fs.lstatSync(source).isSymbolicLink()) throw new Error('Symbolic links are not supported: ' + source);
  if (fs.statSync(source).isDirectory()) {
    fs.mkdirSync(target, { recursive: true, mode: 0o700 });
    for (const name of fs.readdirSync(source)) copy(path.join(source, name), path.join(target, name));
  } else {
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(target, 0o600);
  }
}
function inventory(root, relative = '') {
  return fs.readdirSync(path.join(root, relative)).sort().flatMap(name => {
    const rel = path.join(relative, name), full = path.join(root, rel);
    if (fs.lstatSync(full).isSymbolicLink()) throw new Error('Symbolic links are not supported');
    return fs.statSync(full).isDirectory() ? inventory(root, rel) : [{ path: rel, sha256: crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex') }];
  });
}
function main([command, sourceArg, destinationArg, confirmation]) {
  if (!['backup', 'restore', 'migrate'].includes(command) || !sourceArg || !destinationArg || confirmation !== '--service-stopped') {
    throw new Error('Usage: node scripts/data-admin.js backup|restore|migrate SOURCE NEW_DESTINATION --service-stopped');
  }
  const source = fs.realpathSync(sourceArg);
  const destination = path.join(fs.realpathSync(path.dirname(path.resolve(destinationArg))), path.basename(destinationArg));
  if (destination === source || destination.startsWith(source + path.sep)) throw new Error('Destination must be outside source');
  if (fs.existsSync(destination)) throw new Error('Destination must not exist; existing data is never overwritten');
  if (command === 'restore') {
    const manifest = JSON.parse(fs.readFileSync(path.join(source, 'manifest.json')));
    if (manifest.format !== 'homesense-backup-v1' || !Array.isArray(manifest.files)) throw new Error('Invalid backup');
    const actual = inventory(source).filter(item => item.path !== 'manifest.json');
    if (JSON.stringify(actual) !== JSON.stringify(manifest.files)) throw new Error('Backup checksum verification failed');
    for (const item of actual) copy(path.join(source, item.path), path.join(destination, item.path));
  } else if (command === 'backup') {
    if (!fs.existsSync(path.join(source, 'config.json')) && !fs.existsSync(path.join(source, 'config/config.json'))) throw new Error('No configuration found');
    fs.mkdirSync(destination, { mode: 0o700 });
    for (const name of [...files, ...dirs]) copy(path.join(source, name), path.join(destination, name));
    fs.writeFileSync(path.join(destination, 'manifest.json'), JSON.stringify({ format: 'homesense-backup-v1', createdAt: new Date().toISOString(), files: inventory(destination) }, null, 2), { mode: 0o600 });
  } else {
    // Stage into a fresh directory. Preserve original files for rollback.
    const configSource = fs.existsSync(path.join(source, 'config/config.json')) ? 'config/config.json' : 'config.json';
    copy(path.join(source, configSource), path.join(destination, 'config/config.json'));
    if (!fs.existsSync(path.join(destination, 'config/config.json'))) throw new Error('No configuration found');
    copy(path.join(source, '.env'), path.join(destination, '.env'));
    for (const name of [...files.filter(name => !['config.json', '.env'].includes(name)), 'face-data']) {
      const modern = path.join(source, 'runtime', name);
      copy(fs.existsSync(modern) ? modern : path.join(source, name), path.join(destination, 'runtime', name));
    }
    fs.mkdirSync(path.join(destination, 'runtime'), { recursive: true, mode: 0o700 });
    for (const name of ['snapshots', 'audio']) fs.mkdirSync(path.join(destination, name), { mode: 0o700 });
  }
  console.log(command + ' complete: ' + destination);
}
try { main(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 1; }
