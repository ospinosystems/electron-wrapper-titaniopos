// node --test tests/view-updater-async.test.js
// Verifica que view-updater.js y mega-pos-manager.js no bloquean el hilo principal
// con llamadas síncronas (tar/powershell/rmSync/cpSync/execFileSync/execSync).
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const roots = [];
after(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });

function loadViewUpdaterWithMockElectron(userDataDir, appPathDir) {
  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') {
      return {
        app: {
          getPath: () => userDataDir,
          getAppPath: () => appPathDir,
        },
      };
    }
    return origLoad.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve('../view-updater')];
    return require('../view-updater');
  } finally {
    Module._load = origLoad;
  }
}

test('extractZip usa execFile asíncrono (windowsHide + timeout 120 s) sin bloquear el event loop', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vu-async-'));
  roots.push(root);
  const vu = loadViewUpdaterWithMockElectron(root, root);
  const target = path.join(root, 'stage');
  const calls = [];
  let timerFired = false;

  const p = vu._internals.extractZip(path.join(root, 'bundle.zip'), target, {
    execFileFn: (cmd, args, opts) =>
      new Promise((resolve) => {
        calls.push({ cmd, args, opts });
        setTimeout(() => resolve({ stdout: '', stderr: '' }), 25);
      }),
  });
  setTimeout(() => { timerFired = true; }, 5);
  await p;

  assert.equal(timerFired, true, 'el event loop no debe bloquearse durante extractZip');
  assert.equal(fs.existsSync(target), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'tar');
  assert.equal(calls[0].opts.windowsHide, true);
  assert.equal(calls[0].opts.timeout, 120000);
});

test('extractZip cae a powershell/unzip asíncrono con windowsHide cuando tar falla', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vu-fallback-'));
  roots.push(root);
  const vu = loadViewUpdaterWithMockElectron(root, root);
  const target = path.join(root, 'stage');
  const calls = [];

  await vu._internals.extractZip(path.join(root, 'bundle.zip'), target, {
    execFileFn: async (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      if (cmd === 'tar') throw new Error('tar not found');
      return { stdout: '', stderr: '' };
    },
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].cmd, 'tar');
  assert.equal(calls[1].cmd, process.platform === 'win32' ? 'powershell' : 'unzip');
  assert.equal(calls[1].opts.windowsHide, true);
  assert.equal(calls[1].opts.timeout, 120000);
});

test('pruneOldBuilds borra builds viejas y .tmp de forma asíncrona conservando KEEP_BUILDS + activa + pendiente', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vu-prune-'));
  roots.push(root);
  const vu = loadViewUpdaterWithMockElectron(root, root);
  const views = path.join(root, 'views');
  fs.mkdirSync(views, { recursive: true });
  for (const n of [100, 101, 102, 103, 104, 105]) {
    const d = path.join(views, String(n));
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'index.html'), '<html></html>');
  }
  fs.mkdirSync(path.join(views, '106.tmp'), { recursive: true });
  fs.writeFileSync(path.join(views, '106.tmp', 'partial.txt'), 'x');
  fs.writeFileSync(path.join(views, 'state.json'), JSON.stringify({ active: 100, next: 105, skip: null }));

  await vu.pruneOldBuilds();

  // Conserva las 3 más nuevas (105, 104, 103) + active (100); borra 101, 102 y 106.tmp.
  assert.deepEqual(vu.listBuilds(), [105, 104, 103, 100]);
  assert.equal(fs.existsSync(path.join(views, '101')), false);
  assert.equal(fs.existsSync(path.join(views, '102')), false);
  assert.equal(fs.existsSync(path.join(views, '106.tmp')), false);
});

test('guardia anti-freeze: view-updater.js y mega-pos-manager.js no usan execSync ni execFileSync', () => {
  for (const file of ['view-updater.js', 'mega-pos-manager.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    assert.doesNotMatch(src, /\bexecFileSync\b/, `${file} no debe usar execFileSync`);
    assert.doesNotMatch(src, /\bexecSync\b/, `${file} no debe usar execSync`);
  }
  const vuSrc = fs.readFileSync(path.join(__dirname, '..', 'view-updater.js'), 'utf8');
  assert.doesNotMatch(vuSrc, /\brmSync\b/, 'view-updater.js no debe usar rmSync');
  assert.doesNotMatch(vuSrc, /\bcpSync\b/, 'view-updater.js no debe usar cpSync');
});
