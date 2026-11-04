// CI-only: disposable container, synthetic configuration, no household services.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'homesense-smoke-'));
const name = 'homesense-smoke-' + process.pid;
const docker = args => execFileSync('docker', args, { encoding: 'utf8', timeout: 120000 });
async function main() {
  for (const dir of ['config', 'runtime', 'snapshots', 'audio']) {
    fs.mkdirSync(path.join(root, dir)); fs.chmodSync(path.join(root, dir), 0o777);
  }
  const config = JSON.parse(fs.readFileSync(path.resolve('config.json.example')));
  config.homeAssistant = { url: 'http://127.0.0.1:9', token: 'synthetic' };
  config.camera.rtspUrl = '';
  config.audio.enabled = false;
  if (config.voiceControl) config.voiceControl.enabled = false;
  config.ai.baseUrl = 'http://127.0.0.1:9/v1/chat/completions';
  fs.writeFileSync(path.join(root, 'config/config.json'), JSON.stringify(config));
  const mountArgs = ['config', 'runtime', 'snapshots', 'audio'].flatMap(dir => ['-v', path.join(root, dir) + ':/app/' + dir]);
  const start = () => docker(['run', '-d', '--name', name, '--network', 'none', ...mountArgs,
    '-e', 'HOMESENSE_DATA_DIR=/app/runtime', '-e', 'HOMESENSE_CONFIG_PATH=/app/config/config.json', 'homesense:test']);
  async function ready() {
    for (let attempt = 0; attempt < 30; attempt++) {
      try { const result = JSON.parse(docker(['exec', name, 'curl', '-fsS', 'http://127.0.0.1:8090/healthz'])); if (result.status === 'ok') return; } catch {}
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    throw new Error('Container did not become ready');
  }
  try {
    start(); await ready();
    docker(['exec', name, 'node', '-e', "require('./lib/atomic-json').writeJsonAtomic(process.env.HOMESENSE_CONFIG_PATH, JSON.parse(require('fs').readFileSync(process.env.HOMESENSE_CONFIG_PATH)))"]);
    docker(['exec', name, 'node', '-e', "require('fs').writeFileSync('/app/runtime/smoke-marker','retained')"]);
    docker(['stop', name]); docker(['rm', name]);
    start(); await ready();
    if (docker(['exec', name, 'cat', '/app/runtime/smoke-marker']) !== 'retained') throw new Error('Data did not persist');
    if (!fs.existsSync(path.join(root, 'runtime/nova-runtime.sqlite'))) throw new Error('Ledger not persisted');
    console.log('Container startup, atomic config save and recreation persistence passed');
  } finally {
    try { docker(['rm', '-f', name]); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
