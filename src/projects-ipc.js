const path = require('path');
const { atomicWrite } = require('./projects');
const { t } = require('./i18n');

function registerProjectsIpc({ ipcMain, dialog, window, projects, install }) {
  const handle = (name, fn) => ipcMain.handle(`projects:${name}`, async (_event, ...args) => {
    try { return await fn(...args); } catch (error) { return { error: String(error.message || error) }; }
  });
  handle('list', () => projects.list());
  handle('create', (input) => projects.create(input));
  handle('save', (input) => projects.save(input));
  handle('archive', (id, revision, archived) => projects.archive(id, revision, archived));
  handle('removeAsset', (id, revision, target) => projects.removeAsset(id, revision, target));
  handle('validate', (id) => projects.validate(id));
  handle('duplicate', (id) => projects.importZip(projects.exportZip(id)));
  handle('addFile', async (id, revision, target) => {
    projects.current(id, revision);
    const result = await dialog.showOpenDialog(window(), { title: t('Выбери готовый ресурс'), properties: ['openFile'] });
    if (result.canceled || !result.filePaths.length) return { cancelled: true };
    return projects.addFiles(id, revision, [{ path: target, source: result.filePaths[0] }]);
  });
  handle('addFolder', async (id, revision) => {
    projects.current(id, revision);
    const result = await dialog.showOpenDialog(window(), { title: t('Выбери папку с models, materials или другими ресурсами'), properties: ['openDirectory'] });
    if (result.canceled || !result.filePaths.length) return { cancelled: true };
    return projects.addFolder(id, revision, result.filePaths[0]);
  });
  handle('import', async () => {
    const result = await dialog.showOpenDialog(window(), { title: t('Импорт проекта'), properties: ['openFile'],
      filters: [{ name: 'Workshop project', extensions: ['zip'] }] });
    if (result.canceled || !result.filePaths.length) return { cancelled: true };
    return projects.importZip(result.filePaths[0]);
  });
  const safeName = (name) => name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '') || 'workshop';
  handle('export', async (id) => {
    const project = projects.get(id);
    const result = await dialog.showSaveDialog(window(), { title: t('Экспорт проекта'), defaultPath: `${safeName(project.name)}.workshop.zip`,
      filters: [{ name: 'Workshop project', extensions: ['zip'] }] });
    if (result.canceled || !result.filePath) return { cancelled: true };
    atomicWrite(result.filePath, projects.exportZip(id));
    return { ok: true, path: result.filePath };
  });
  handle('build', async (id) => {
    const project = projects.get(id);
    const check = projects.validate(id);
    if (!check.ok) return { error: check.errors.join('\n') };
    const result = await dialog.showSaveDialog(window(), { title: t('Собрать VPK'), defaultPath: `${safeName(project.name)}_dir.vpk`,
      filters: [{ name: 'VPK', extensions: ['vpk'] }] });
    if (result.canceled || !result.filePath) return { cancelled: true };
    atomicWrite(result.filePath, projects.build(id).data);
    return { ok: true, path: result.filePath };
  });
  handle('install', (id) => install(() => {
    const built = projects.build(id);
    return [{ name: `${path.basename(safeName(built.name))}_dir.vpk`, data: built.data }];
  }));
}

module.exports = { registerProjectsIpc };
