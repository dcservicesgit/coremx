'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { promisify } = require('node:util');
const exec = promisify(require('node:child_process').execFile);
async function fixture(t) {
    const root = await fs.mkdtemp(path.resolve('.cache/composition-')); const central = path.join(root, 'central'); const overlay = path.join(root, 'coremx');
    const write = async (name, value) => { const file = path.join(root, name); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, value); };
    for (const dir of [central, overlay]) { await fs.mkdir(dir, { recursive: true }); await exec('git', ['init', dir]); await exec('git', ['-C', dir, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '--allow-empty', '-m', 'fixture']); }
    await fs.cp('build_compositeserver.sh', path.join(overlay, 'build_compositeserver.sh')); await fs.cp('scripts', path.join(overlay, 'scripts'), { recursive: true });
    await write('central/portal/package.json', '{"name":"fixture","version":"1.0.0"}');
    await write('central/portal/package-lock.json', '{"name":"fixture","lockfileVersion":3,"packages":{"":{}}}');
    await write('central/portal/plugins/dcsajaxv3.js', 'export default () => {\n  const WEBSOCKET_ENDPOINTS = [\n    "wss://central.test",\n  ];\n};');
    await write('central/server/modules/applicationProfile.js', 'inherited profile'); await write('central/server/modules/httpWorker.js', 'inherited http');
    await write('central/server/core.js', 'underlay'); await write('coremx/server/core.js', 'overlay'); await write('coremx/portal/coremx.txt', 'mail portal');
    await write('central/server/config.json', 'secret'); await write('central/server/.env', 'secret'); await write('central/server/sample.key', 'secret');
    await write('central/releases/centralfw-test', '#!/bin/sh\nprintf \'%s\\n\' \'{"httpWorkerVersion":1,"unixWorkers":true}\'\n'); await fs.chmod(path.join(central, 'releases/centralfw-test'), 0o700);
    await write('central/releases/centralfw-test.capabilities.json', JSON.stringify({ httpWorkerVersion: 1, unixWorkers: true, sha256: require('node:crypto').createHash('sha256').update(await fs.readFile(path.join(central, 'releases/centralfw-test'))).digest('hex') }));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const run = () => exec('bash', [path.join(overlay, 'build_compositeserver.sh'), '--no-install'], { env: { ...process.env, CENTRAL_DIR: central, CENTRALFW_BINARY: 'centralfw-test' } });
    return { root, central, overlay, write, run };
}
test('composition preserves underlay, overlay precedence, endpoint and provenance; removes stale files and secrets', async t => {
    const f = await fixture(t); await f.run();
    const output = path.join(f.overlay, 'composite_server');
    assert.equal(await fs.readFile(path.join(output, 'core.js'), 'utf8'), 'overlay');
    assert.equal(await fs.readFile(path.join(output, 'modules/httpWorker.js'), 'utf8'), 'inherited http');
    for (const file of ['config.json', '.env', 'sample.key']) await assert.rejects(fs.access(path.join(output, file)));
    const plugin = await fs.readFile(path.join(f.overlay, 'composite_portal/plugins/dcsajaxv3.js'), 'utf8'); assert.match(plugin, /window.location.host/);
    assert.equal(JSON.parse(await fs.readFile(path.join(output, 'composition.json'))).centralfw.sha256.length, 64);
    await fs.writeFile(path.join(output, 'stale.js'), 'old'); await f.run(); await assert.rejects(fs.access(path.join(output, 'stale.js')));
});
test('composition rejects symlinks and missing overlays before replacing outputs', async t => {
    const f = await fixture(t); await f.run(); const marker = path.join(f.overlay, 'composite_server/marker'); await fs.writeFile(marker, 'keep');
    await fs.symlink('/etc/passwd', path.join(f.overlay, 'server/unsafe')); await assert.rejects(f.run()); assert.equal(await fs.readFile(marker, 'utf8'), 'keep');
    await fs.unlink(path.join(f.overlay, 'server/unsafe')); await fs.rm(path.join(f.overlay, 'portal'), { recursive: true }); await assert.rejects(f.run()); assert.equal(await fs.readFile(marker, 'utf8'), 'keep');
});
test('composition rejects a stale capability checksum before changing outputs', async t => {
    const f = await fixture(t); await f.run(); const marker = path.join(f.overlay, 'composite_server/marker'); await fs.writeFile(marker, 'keep');
    await fs.appendFile(path.join(f.central, 'releases/centralfw-test'), '# changed\n');
    await assert.rejects(f.run()); assert.equal(await fs.readFile(marker, 'utf8'), 'keep');
});
