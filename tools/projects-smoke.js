// Exercise the real Electron UI against tools/workshop-preview.js, never a real game.
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Projects } = require('../src/projects');

(async () => {
  const pages = await (await fetch('http://127.0.0.1:9338/json/list')).json();
  const page = pages.find((item) => item.type === 'page' && item.url.endsWith('/renderer/index.html'));
  assert.ok(page, 'Preview window exists on port 9338');
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  const pending = new Map();
  let serial = 0;
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (!pending.has(message.id)) return;
    const task = pending.get(message.id);
    pending.delete(message.id); clearTimeout(task.timer);
    message.error ? task.reject(new Error(JSON.stringify(message.error))) : task.resolve(message.result);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++serial;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timeout: ${method}`)); }, 20000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const run = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const waitFor = async (expression) => {
    const started = Date.now();
    while (Date.now() - started < 15000) {
      if (await run(expression)) return;
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
    throw new Error(`UI condition timed out: ${expression}`);
  };
  const click = async (selector) => { await run(`document.querySelector(${JSON.stringify(selector)}).click()`); };
  const idle = () => waitFor(`!document.querySelector('[data-pane="projects"]').hasAttribute('aria-busy') && !document.querySelector('#projectNew').disabled`);
  try {
    const settings = await run('window.api.settings.get()');
    const root = path.resolve(__dirname, '..');
    const game = path.join(root, 'sandbox/workshop/steamapps/common/dota 2 beta/game');
    assert.equal(settings.dotaGamePath, game, 'Only the disposable test game is in scope');
    assert.equal(settings.previewProfile, true);
    if (process.argv.includes('--close')) {
      await run('window.api.win.close()');
      return;
    }
    await run(`(async () => { const { switchView } = await import('./core/router.js'); await switchView('projects'); })()`);
    await click('#projectNew'); await idle();
    const name = `Celestial UI ${Date.now()}`;
    await run(`(() => { const input = document.querySelector('#projectForm [name="name"]'); input.value = ${JSON.stringify(name)}; input.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#projectForm').requestSubmit(); })()`);
    await idle();
    const listing = await run('window.api.projects.list()');
    let project = listing.projects.find((p) => p.name === name);
    assert.ok(project, 'Metadata saved through the UI');
    // Seed a valid tiny PNG without a native file dialog. Dialog and archive behavior are
    // covered with an injected Electron adapter in test/projects.test.js.
    const fixture = path.join(root, 'sandbox', 'celestial-fixture.png');
    fs.writeFileSync(fixture, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'));
    const service = new Projects(path.join(root, 'sandbox/workshop/userdata'));
    project = service.addFiles(project.id, project.revision, [{ source: fixture, path: 'panorama/images/celestial_beta_fixture.png' }]);
    await run(`(async () => { const { renderProjects } = await import('./views/projects.js'); await renderProjects(); })()`);
    await click('#projectValidate'); await idle();
    assert.match(await run(`document.querySelector('#projectReport').textContent`), /1/);
    assert.equal(await run(`document.querySelectorAll('.project-asset').length`), 1);
    for (const lang of ['ru', 'en']) {
      await run(`(async () => { const { applyLanguage } = await import('./ui/language.js'); await applyLanguage('${lang}'); const { renderProjects } = await import('./views/projects.js'); await renderProjects(); })()`);
      assert.match(await run(`document.querySelector('[data-pane="projects"] h1').textContent`), lang === 'ru' ? /Проекты/ : /Projects/);
      const screenshot = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(root, 'sandbox', `celestial-projects-${lang}.png`), Buffer.from(screenshot.data, 'base64'));
    }
    await click('#projectArchive'); await idle();
    assert.equal(service.get(project.id).archived, true);
    await click('#projectArchive'); await idle();
    assert.equal(service.get(project.id).archived, false);
    // A revision conflict leaves the edited text visible and has an explicit recovery path.
    await run(`(() => { const input = document.querySelector('#projectForm [name="description"]'); input.value = 'unsaved'; input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    service.save({ ...service.get(project.id), description: 'external edit' });
    await run(`document.querySelector('#projectForm').requestSubmit()`); await idle();
    assert.equal(await run(`document.querySelector('#projectForm [name="description"]').value`), 'unsaved');
    await click('#projectReload'); await waitFor(`!!document.querySelector('.confirm-overlay')`);
    await click('.confirm-overlay [data-c="yes"]'); await idle();
    assert.equal(await run(`document.querySelector('#projectForm [name="description"]').value`), 'external edit');
    await click('#projectInstall'); await waitFor(`!!document.querySelector('.confirm-overlay')`);
    await click('.confirm-overlay [data-c="yes"]'); await idle();
    assert.match(await run(`document.querySelector('#projectReport').textContent`), /installed|установлен/);
    const mods = await run('window.api.mods.list()');
    const installed = mods.installed.find((m) => m.name.includes(name));
    assert.ok(installed, 'Built project is registered in the existing mod library');
    assert.ok(!(await run(`window.api.mods.setEnabled(${JSON.stringify(installed.id)}, false)`)).error);
    assert.ok(!(await run(`window.api.mods.setEnabled(${JSON.stringify(installed.id)}, true)`)).error);
    assert.ok(!(await run(`window.api.mods.remove(${JSON.stringify(installed.id)})`)).error);
    assert.ok(!(await run('window.api.mods.list()')).installed.some((m) => m.id === installed.id));
    await click('#projectDuplicate'); await idle();
    const copies = (await run('window.api.projects.list()')).projects.filter((p) => p.name === name);
    assert.equal(copies.length, 2);
    assert.deepEqual(copies[0].assets, copies[1].assets);
    await run(`(async () => { const { applyLanguage } = await import('./ui/language.js'); await applyLanguage('ru'); })()`);
    assert.equal(await run(`document.querySelector('.tb-title').textContent`), 'Celestial VPK');
    console.log(JSON.stringify({ ok: true, name, languages: ['ru', 'en'], checks: ['create', 'save', 'validate', 'archive', 'restore', 'revision-conflict', 'reload', 'install', 'disable', 'enable', 'remove', 'duplicate'] }, null, 2));
  } finally {
    for (const task of pending.values()) clearTimeout(task.timer);
    socket.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
