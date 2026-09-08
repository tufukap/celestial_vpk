// Adapters return data, never executable plugins. Installation stays in installer.js.
const crypto = require('crypto');
const { RAW_BASE } = require('../catalog');

function httpsUrl(value, base) {
  const url = new URL(value, base);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Expected an HTTPS URL without credentials');
  return url.href;
}

const idOf = (value) => crypto.createHash('sha256').update(value).digest('hex').slice(0, 24);
const downloadable = (url) => /\.(zip|vpk)$/i.test(new URL(url).pathname);

async function readJson(url) {
  const response = await fetch(httpsUrl(url), { signal: AbortSignal.timeout(15000), headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  httpsUrl(response.url);
  const parts = [];
  let length = 0;
  for await (const part of response.body) {
    length += part.length;
    if (length > 8 * 1024 * 1024) throw new Error('Catalog exceeds 8 MiB');
    parts.push(part);
  }
  return JSON.parse(Buffer.concat(parts).toString('utf8'));
}

function normalizeMod(mod, source, base) {
  if (!mod || typeof mod.name !== 'string' || !mod.name.trim()) throw new Error('Each mod needs a name');
  const categoryId = mod.category || 'other';
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(categoryId) || categoryId === 'tools') throw new Error('Unsupported mod category');
  if (!Array.isArray(mod.files) || mod.files.length > 100) throw new Error('Each mod needs a files array (maximum 100)');
  const files = mod.files.map((file, index) => {
    const url = httpsUrl(file.url, base);
    if (!downloadable(url)) throw new Error('Only ZIP and VPK mod files are supported');
    return { id: String(index), label: String(file.label || new URL(url).pathname.split('/').pop()), url };
  });
  const id = String(mod.id || idOf(`${categoryId}\n${mod.name}`));
  if (!id || id.length > 256) throw new Error('Invalid mod id');
  return { id, sourceId: source.id, sourceName: source.name, categoryId,
    name: mod.name.slice(0, 300), description: String(mod.description || '').slice(0, 4000),
    preview: mod.preview ? httpsUrl(mod.preview, base) : null,
    tags: Array.isArray(mod.tags) ? mod.tags.filter((tag) => typeof tag === 'string').slice(0, 30) : [], files };
}

function manifestMods(data, source) {
  if (data?.version !== 1 || !Array.isArray(data.mods) || data.mods.length > 10000) {
    throw new Error('Expected a version: 1 catalog with a mods array (maximum 10000)');
  }
  const mods = data.mods.map((mod) => normalizeMod(mod, source, source.url));
  if (new Set(mods.map((mod) => mod.id)).size !== mods.length) throw new Error('Duplicate mod ids');
  return mods;
}

function githubRepo(value) {
  const url = new URL(httpsUrl(value));
  const match = url.pathname.match(/^\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/);
  if (url.hostname !== 'github.com' || !match || url.search || url.hash) throw new Error('Use https://github.com/owner/repository');
  return `${match[1]}/${match[2]}`;
}

function builtinMods(data, source) {
  const result = [];
  for (const [category, group] of Object.entries(data.mods?.modsData || {})) {
    if (category === 'tools') continue;
    const groups = Array.isArray(group) ? [{ mods: group }] : group?.groups || [group || {}];
    for (const { mod, groupName, groupId } of groups.flatMap((item) => (item.mods || []).map((mod) => ({ mod, groupName: item.name, groupId: item.id })))) {
      if (!mod?.name) continue;
      const resolveFile = (ref) => /^https?:\/\//i.test(ref) ? ref : `${RAW_BASE}/assets/files/${category}/${encodeURIComponent(ref)}`;
      const files = [];
      if (typeof mod.file === 'string' && /\.(zip|vpk)$/i.test(mod.file)) files.push({ label: mod.name, url: resolveFile(mod.file) });
      for (const style of Array.isArray(mod.styles) ? mod.styles : []) {
        if (typeof style.file === 'string' && /\.(zip|vpk)$/i.test(style.file)) files.push({ label: style.name || style.label, url: resolveFile(style.file) });
      }
      let preview = mod.preview || mod.styles?.[0]?.preview;
      if (preview && !/^https?:\/\//i.test(preview)) preview = preview.startsWith('assets/')
        ? `${RAW_BASE}/${preview.split('/').map(encodeURIComponent).join('/')}`
        : `${RAW_BASE}/assets/previews/${category}/${encodeURIComponent(preview)}`;
      // A legacy HTTP preview must not prevent the rest of the signed catalog loading.
      try {
        const item = normalizeMod({ ...mod, id: mod.id || idOf(`${category}\n${groupId || groupName || ''}\n${mod.name}`),
          tags: [...(Array.isArray(mod.tags) ? mod.tags : []), groupName, groupId].filter(Boolean),
          category, files, preview }, source, RAW_BASE);
        item.files.forEach((file, index) => { file.styleLabel = mod.file ? (index ? file.label : null) : file.label; });
        result.push(item);
      } catch { /* unsupported legacy entry remains available in the original catalog */ }
    }
  }
  return result;
}

function adapters(catalog, json = readJson) {
  return {
    d2pfx: { async load(source, force) {
      const data = await catalog.load({ forceRefresh: force });
      return { mods: builtinMods(data, source), stale: data.stale || null };
    } },
    manifest: { async load(source) { return { mods: manifestMods(await json(source.url), source) }; } },
    github: { async load(source) {
      const repo = githubRepo(source.url);
      const releases = await json(`https://api.github.com/repos/${repo}/releases?per_page=100`);
      if (!Array.isArray(releases)) throw new Error('Expected GitHub releases');
      return { mods: releases.filter((release) => !release.draft).flatMap((release) => {
        const files = (release.assets || []).filter((asset) => /\.(zip|vpk)$/i.test(asset.name || ''))
          .map((asset) => ({ label: asset.name, url: asset.browser_download_url }));
        return files.length ? [normalizeMod({ id: String(release.id), name: release.name || release.tag_name,
          description: release.body, files }, source, source.url)] : [];
      }) };
    } },
  };
}

module.exports = { httpsUrl, idOf, githubRepo, manifestMods, builtinMods, adapters, readJson };
