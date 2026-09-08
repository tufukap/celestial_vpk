import { pane, registerView, invalidateViews } from '../core/router.js';
import { esc, fmtMB } from '../ui/format.js';
import { toast } from '../ui/toast.js';
import { confirmDialog } from '../ui/dialog.js';
import { paint } from '../ui/transitions.js';
import { refreshInstalledIndex } from '../core/installed.js';

const root = pane('projects');
const api = window.api.projects;
let selected = null;
let draft = null;
let dirty = false;
let busy = false;
let archived = false;
let filter = '';
let report = '';
let targetPath = '';
let generation = 0;

registerView('projects', renderProjects);
window.addEventListener('beforeunload', (event) => {
  if (dirty) { event.preventDefault(); event.returnValue = ''; }
});

function unwrap(result) {
  if (result?.error) throw new Error(result.error);
  return result;
}

async function saveDraft() {
  if (!dirty || !draft) return;
  draft = unwrap(await api.save(draft));
  dirty = false;
}

async function action(work, save = true) {
  if (busy) return;
  busy = true;
  root.setAttribute('aria-busy', 'true');
  root.querySelectorAll('button, input, textarea').forEach((el) => { el.disabled = true; });
  try {
    if (save) await saveDraft();
    const result = unwrap(await work());
    if (result?.id) { selected = result.id; draft = result; dirty = false; report = ''; }
    if (result?.path) report = L`Файл сохранён: ${result.path}`;
  } catch (error) { report = error.message; toast(error.message, 'error'); }
  finally { busy = false; root.removeAttribute('aria-busy'); await renderProjects(); }
}

export async function renderProjects() {
  if (busy) return;
  const ticket = ++generation;
  let data;
  try { data = unwrap(await api.list()); }
  catch (error) { root.textContent = error.message; return; }
  if (ticket !== generation) return;
  if (selected && !dirty) draft = data.projects.find((project) => project.id === selected) || null;
  const project = draft;
  await paint(() => {
    root.innerHTML = `
      <div class="view-header"><h1 class="view-title">${L`Проекты`} <span class="source-badge">Beta 1</span></h1>
        <div class="source-actions"><button class="btn btn-primary" id="projectNew">${L`Новый проект`}</button>
        <button class="btn" id="projectImport">${L`Импорт проекта`}</button></div></div>
      <p class="settings-hint">${L`Собери мод из готовых ресурсов Source 2. Проекты хранятся отдельно от игры; установка выполняется отдельной кнопкой.`}</p>
      <div class="project-layout">
        <aside class="project-sidebar">
          <label>${L`Поиск проектов`}<input class="input" id="projectSearch" value="${esc(filter)}"></label>
          <label class="project-archive-filter"><input type="checkbox" id="projectArchived" ${archived ? 'checked' : ''}>${L`Архив проектов`}</label>
          <div id="projectList"></div>
          ${data.errors.map((error) => `<p role="alert">${esc(error.id)}: ${esc(error.error)}</p>`).join('')}
        </aside>
        <section class="settings-block project-editor">${project ? `
          <form id="projectForm">
            <label>${L`Название`}<input class="input" name="name" required maxlength="100" value="${esc(project.name)}"></label>
            <label>${L`Описание проекта`}<textarea class="input" name="description" maxlength="2000" rows="3">${esc(project.description)}</textarea></label>
            <div class="project-meta"><label>${L`Герой (заметка)`}<input class="input" name="hero" maxlength="100" value="${esc(project.hero)}"></label>
              <label>${L`Слот (заметка)`}<input class="input" name="slot" maxlength="100" value="${esc(project.slot)}"></label></div>
            <div class="source-actions"><button class="btn btn-primary" type="submit">${L`Сохранить`}</button>
              <button class="btn" type="button" id="projectReload">${L`Перечитать с диска`}</button>
              <span id="projectSaveState" role="status">${dirty ? L`Есть несохранённые изменения` : L`Сохранено`}</span>
              <span class="source-badge">${L`Ревизия: ${project.revision}`}</span></div>
          </form>
          <h2>${L`Ресурсы проекта`}</h2>
          <p class="settings-hint">${L`Путь внутри VPK, например materials/models/heroes/axe/axe_color.vtex_c. Модели, материалы и эффекты должны быть скомпилированы заранее.`}</p>
          <form id="projectAssetForm" class="source-actions"><input class="input" id="projectTarget" aria-label="${L`Путь ресурса`}" placeholder="materials/models/heroes/axe/axe_color.vtex_c" required value="${esc(targetPath)}">
            <button class="btn" type="submit">${L`Добавить файл`}</button><button class="btn" type="button" id="projectFolder">${L`Добавить папку ресурсов`}</button></form>
          <p class="settings-hint">${L`До 512 файлов, 64 МиБ на файл и 128 МиБ на проект. Совпадающие пути нужно сначала удалить из списка.`}</p>
          <div class="project-assets">${project.assets.length ? project.assets.map((asset, index) => `
            <div class="project-asset"><code>${esc(asset.path)}</code><span>${fmtMB(asset.size)}</span>
              <button class="btn btn-sm" data-remove-asset="${index}">${L`Убрать из проекта`}</button></div>`).join('') : `<p>${L`Добавь хотя бы один ресурс`}</p>`}</div>
          <div class="source-actions project-build-actions">
            <button class="btn" id="projectValidate">${L`Проверить проект`}</button>
            <button class="btn btn-primary" id="projectBuild" ${project.assets.length ? '' : 'disabled'}>${L`Собрать VPK`}</button>
            <button class="btn" id="projectInstall" ${project.assets.length ? '' : 'disabled'}>${L`Установить в Мои моды`}</button>
            <button class="btn" id="projectExport">${L`Экспорт проекта`}</button>
            <button class="btn" id="projectDuplicate">${L`Создать копию`}</button>
            <button class="btn" id="projectArchive">${project.archived ? L`Вернуть из архива` : L`В архив`}</button>
          </div>
          <p class="settings-hint">${L`Проверка сверяет пути, размеры и целостность. Совместимость с героем, зависимости и отображение в игре проверяются отдельно.`}</p>
        ` : `<h2>${L`Создай свой первый проект`}</h2><p>${L`Добавь название, затем готовые ресурсы. Сохрани ZIP для редактирования или собери VPK для установки.`}</p>`}
        <p id="projectReport" role="status" class="project-report">${esc(report)}</p></section>
      </div>`;
  });
  const drawList = () => {
    const visible = data.projects.filter((p) => p.archived === archived && `${p.name} ${p.hero} ${p.slot}`.toLocaleLowerCase().includes(filter.toLocaleLowerCase()));
    root.querySelector('#projectList').innerHTML = visible.map((p) => `<button class="btn project-list-item ${p.id === selected ? 'active' : ''}" data-project="${esc(p.id)}" aria-pressed="${p.id === selected}">
      <strong>${esc(p.name)}</strong><span>${p.assets.length} · ${esc(p.hero || '—')}</span></button>`).join('') || `<p>${L`Проекты не найдены`}</p>`;
    root.querySelectorAll('[data-project]').forEach((button) => button.addEventListener('click', () => action(async () => {
      selected = button.dataset.project; draft = null; report = ''; targetPath = '';
    })));
  };
  drawList();
  root.querySelector('#projectSearch').addEventListener('input', (event) => { filter = event.target.value; drawList(); });
  root.querySelector('#projectArchived').addEventListener('change', (event) => { archived = event.target.checked; drawList(); });
  root.querySelector('#projectNew').addEventListener('click', () => action(() => { archived = false; return api.create({ name: L`Новый проект` }); }));
  root.querySelector('#projectImport').addEventListener('click', () => action(() => { archived = false; return api.import(); }));
  if (!project) return;
  root.querySelector('#projectForm').addEventListener('input', (event) => {
    if (!['name', 'description', 'hero', 'slot'].includes(event.target.name)) return;
    draft[event.target.name] = event.target.value; dirty = true;
    root.querySelector('#projectSaveState').textContent = L`Есть несохранённые изменения`;
  });
  root.querySelector('#projectForm').addEventListener('submit', (event) => { event.preventDefault(); action(() => { report = L`Сохранено`; }); });
  root.querySelector('#projectReload').addEventListener('click', () => action(async () => {
    if (dirty && !await confirmDialog(L`Отбросить несохранённые изменения проекта?`)) return;
    dirty = false; draft = null; report = '';
  }, false));
  root.querySelector('#projectTarget').addEventListener('input', (event) => { targetPath = event.target.value; });
  root.querySelector('#projectAssetForm').addEventListener('submit', (event) => {
    event.preventDefault(); action(() => api.addFile(draft.id, draft.revision, targetPath.trim()));
  });
  root.querySelector('#projectFolder').addEventListener('click', () => action(() => api.addFolder(draft.id, draft.revision)));
  root.querySelectorAll('[data-remove-asset]').forEach((button) => button.addEventListener('click', () => action(async () => {
    const target = draft.assets[Number(button.dataset.removeAsset)].path;
    if (!await confirmDialog(L`Убрать ресурс ${target} из проекта?`)) return;
    return api.removeAsset(draft.id, draft.revision, target);
  })));
  root.querySelector('#projectValidate').addEventListener('click', () => action(async () => {
    const result = unwrap(await api.validate(draft.id));
    report = result.ok ? L`Проверка пройдена: ${result.files} файлов` : result.errors.join('\n');
  }));
  root.querySelector('#projectBuild').addEventListener('click', () => action(() => api.build(draft.id)));
  root.querySelector('#projectExport').addEventListener('click', () => action(() => api.export(draft.id)));
  root.querySelector('#projectDuplicate').addEventListener('click', () => action(() => { archived = false; return api.duplicate(draft.id); }));
  root.querySelector('#projectArchive').addEventListener('click', () => action(async () => {
    const result = unwrap(await api.archive(draft.id, draft.revision, !draft.archived));
    archived = result.archived;
    return result;
  }));
  root.querySelector('#projectInstall').addEventListener('click', () => action(async () => {
    if (!await confirmDialog(L`Собрать проект и установить его в выбранную папку Dota 2?`, { okLabel: L`Установить`, danger: false })) return;
    const result = unwrap(await api.install(draft.id));
    if (result.errors?.length) throw new Error(result.errors.map((item) => item.error).join('\n'));
    if (!result.imported?.length) throw new Error(L`Не удалось установить проект`);
    report = L`Мод установлен`;
    await refreshInstalledIndex(); invalidateViews();
  }));
}
