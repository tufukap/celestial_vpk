import { state } from '../core/store.js';
import { registerView, pane, invalidateViews } from '../core/router.js';
import { esc } from '../ui/format.js';
import { toast } from '../ui/toast.js';
import { paint } from '../ui/transitions.js';
import { refreshInstalledIndex } from '../core/installed.js';
import { loadCatalog } from './catalog.js';

const root = pane('sources');
let generation = 0;
let editing = null;
let busy = false;
let category = '';
let page = 0;
const pageSize = 48;

function statusLabel(source) {
  if (!source.enabled) return L`Выключен`;
  const labels = { unknown: L`Не проверен`, available: L`Доступен`, cached: L`Из кэша`, stale: L`Офлайн — сохранённая копия`, unavailable: L`Недоступен` };
  return labels[source.state] || labels.unknown;
}

registerView('sources', () => renderSources());

export async function renderSources(force = false) {
  const ticket = ++generation;
  const sources = await window.api.sources.list();
  if (ticket !== generation) return;
  if (sources.error) { root.textContent = sources.error; return; }
  await paint(() => { root.innerHTML = `
    <div class="view-header"><h1 class="view-title">${L`Источники`}</h1>
      <button class="btn" id="sourcesRefresh">${L`Проверить и обновить`}</button></div>
    <p class="settings-hint">${L`Подключи JSON-каталог или GitHub-репозиторий с ZIP/VPK в релизах. Для другого формата сайта нужен отдельный адаптер.`}</p>
    <div class="source-list">${sources.map((source) => `
      <div class="settings-block source-row">
        <div><b>${esc(source.name)}</b> <span class="source-badge">${esc(source.type)}</span>
          <div class="settings-hint source-url">${esc(source.url)}</div>
          ${source.warning ? `<div role="alert">${esc(source.warning)}</div>` : ''}
          <div class="source-health" data-health="${esc(source.id)}" title="${esc(source.error || '')}">${esc(statusLabel(source))}</div></div>
        <div class="source-actions">
          <button class="btn btn-sm" data-toggle="${esc(source.id)}">${source.enabled ? L`Выключить` : L`Включить`}</button>
          ${source.id === 'd2pfx' ? '' : `<button class="btn btn-sm" data-edit="${esc(source.id)}">${L`Редактировать`}</button>
          <button class="btn btn-sm" data-remove="${esc(source.id)}">${L`Удалить`}</button>`}
        </div>
      </div>`).join('')}</div>
    <details class="source-editor" ${editing ? 'open' : ''}><summary class="btn">${L`Добавить источник`}</summary>
    <form class="settings-block source-form" id="sourceForm">
      <h3>${editing ? L`Редактировать источник` : L`Добавить источник`}</h3>
      <label>${L`Название`}<input class="input" name="name" required maxlength="100" value="${esc(editing?.name || '')}"></label>
      <label>${L`Тип источника`}<select class="input" name="type">
        <option value="manifest" ${editing?.type === 'manifest' ? 'selected' : ''}>JSON catalog v1</option>
        <option value="github" ${editing?.type === 'github' ? 'selected' : ''}>GitHub Releases</option>
      </select></label>
      <label>${L`Адрес HTTPS`}<input class="input" type="url" name="url" required placeholder="https://example.org/catalog.json" value="${esc(editing?.url || '')}"></label>
      <div><button class="btn btn-primary" type="submit">${L`Сохранить`}</button>
        ${editing ? `<button class="btn" id="cancelEdit" type="button">${L`Отмена`}</button>` : ''}</div>
      <div class="settings-hint" id="sourceFormError" role="alert"></div>
    </form></details>
    <div class="source-toolbar">
      <label>${L`Поиск по всем источникам`}<input class="input" id="sourceQuery" value="${esc(state.search)}"></label>
      <label>${L`Категория`}<select class="input" id="sourceCategory"><option value="">${L`Все категории`}</option></select></label>
    </div>
    <div id="sourceResults" aria-live="polite">${L`Загрузка каталогов…`}</div>`; });

  const changed = async (result) => {
    if (result?.error) { toast(result.error, 'error'); return; }
    invalidateViews();
    await loadCatalog(false);
    return renderSources();
  };
  root.querySelector('#sourcesRefresh').addEventListener('click', () => renderSources(true));
  root.querySelectorAll('[data-toggle]').forEach((button) => button.addEventListener('click', async () => {
    button.disabled = true;
    const source = sources.find((item) => item.id === button.dataset.toggle);
    await changed(await window.api.sources.save({ ...source, enabled: !source.enabled }));
  }));
  root.querySelectorAll('[data-remove]').forEach((button) => button.addEventListener('click', async () => {
    button.disabled = true;
    if (editing?.id === button.dataset.remove) editing = null;
    await changed(await window.api.sources.remove(button.dataset.remove));
  }));
  root.querySelectorAll('[data-edit]').forEach((button) => button.addEventListener('click', () => {
    editing = sources.find((item) => item.id === button.dataset.edit);
    renderSources();
  }));
  root.querySelector('#cancelEdit')?.addEventListener('click', () => { editing = null; renderSources(); });
  root.querySelector('#sourceForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    form.querySelector('[type="submit"]').disabled = true;
    const data = new FormData(form);
    const result = await window.api.sources.save({ id: editing?.id, enabled: editing?.enabled ?? true,
      name: data.get('name'), type: data.get('type'), url: data.get('url') });
    if (result.error) {
      form.querySelector('#sourceFormError').textContent = result.error;
      form.querySelector('[type="submit"]').disabled = false;
      return;
    }
    editing = null;
    await changed(result);
  });

  const queryInput = root.querySelector('#sourceQuery');
  const categoryInput = root.querySelector('#sourceCategory');
  let mods = [];
  const draw = () => {
    const words = state.search.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
    const matches = mods.filter((mod) => (!category || category === mod.categoryId)
      && words.every((word) => [mod.name, mod.categoryId, mod.sourceName, ...mod.tags].join(' ').toLocaleLowerCase().includes(word)));
    const pageCount = Math.max(1, Math.ceil(matches.length / pageSize));
    page = Math.min(page, pageCount - 1);
    const shown = matches.slice(page * pageSize, (page + 1) * pageSize);
    const results = root.querySelector('#sourceResults');
    results.innerHTML = `<p>${L`Найдено модов: ${matches.length}`}</p><div class="source-grid">${shown.map((mod, index) => `
      <article class="settings-block source-card">
        ${mod.preview && /\.(png|jpe?g|webp|gif)(\?|$)/i.test(mod.preview) ? `<img loading="lazy" src="${esc(mod.preview)}" alt="">` : ''}
        <span class="source-badge">${esc(mod.sourceName)} · ${esc(mod.categoryId)}</span>
        <h3>${esc(mod.name)}</h3><p>${esc(mod.description.slice(0, 160))}</p>
        <select class="input" aria-label="${L`Файл мода`}" data-file="${index}" ${mod.files.length ? '' : 'disabled'}>${mod.files.map((file) => `<option value="${esc(file.id)}">${esc(file.label)}</option>`).join('')}</select>
        <button class="btn btn-primary" data-install="${index}" ${!mod.files.length || busy ? 'disabled' : ''}>${mod.files.length ? L`Установить` : L`Нет ZIP/VPK`}</button>
      </article>`).join('')}</div>
      <div class="source-actions"><button class="btn" id="sourcePrev" ${page ? '' : 'disabled'}>←</button>
        <span>${page + 1} / ${pageCount}</span><button class="btn" id="sourceNext" ${page + 1 < pageCount ? '' : 'disabled'}>→</button></div>`;
    results.querySelector('#sourcePrev').addEventListener('click', () => { page--; draw(); });
    results.querySelector('#sourceNext').addEventListener('click', () => { page++; draw(); });
    results.querySelectorAll('[data-install]').forEach((button) => button.addEventListener('click', async () => {
      if (busy) return;
      const index = Number(button.dataset.install);
      const mod = shown[index];
      const fileId = results.querySelector(`[data-file="${index}"]`).value;
      busy = true;
      draw();
      try {
        const result = await window.api.sources.install({ sourceId: mod.sourceId, modId: mod.id, fileId });
        if (result.error) toast(result.error, 'error');
        else { toast(L`Мод установлен`); await refreshInstalledIndex(); invalidateViews(); }
      } finally { busy = false; if (ticket === generation) draw(); }
    }));
  };
  queryInput.addEventListener('input', () => {
    state.search = queryInput.value;
    document.querySelector('#globalSearch').value = state.search;
    document.querySelector('#clearSearch').classList.toggle('hidden', !state.search);
    page = 0;
    draw();
  });
  categoryInput.addEventListener('change', () => { category = categoryInput.value; page = 0; draw(); });
  const data = await window.api.sources.search('', force);
  if (ticket !== generation) return;
  if (data.error) { root.querySelector('#sourceResults').textContent = data.error; return; }
  mods = data.mods;
  categoryInput.innerHTML += data.categories.map((value) => `<option value="${esc(value)}">${esc(value)}</option>`).join('');
  if (!data.categories.includes(category)) category = '';
  categoryInput.value = category;
  for (const source of data.sources) {
    const el = root.querySelector(`[data-health="${source.id}"]`);
    if (el) { el.textContent = statusLabel(source); el.title = source.error || ''; }
  }
  draw();
}
