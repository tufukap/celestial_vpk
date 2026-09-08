// Local authoring workspace. Projects are separate from installed mods and game files.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const AdmZip = require('adm-zip');
const { openZip } = require('./safe-zip');
const { buildVpk, crc32 } = require('./vpk');
const { t } = require('./i18n');

const LIMITS = { files: 512, fileBytes: 64 * 1024 * 1024, totalBytes: 128 * 1024 * 1024 };
const ID = /^[a-f0-9-]{36}$/;
const HASH = /^[a-f0-9]{64}$/;
const ROOTS = new Set(['models', 'materials', 'particles', 'panorama', 'sounds', 'soundevents', 'resource']);
const TYPES = new Set(['.vmdl_c', '.vmesh_c', '.vphys_c', '.vskel_c', '.vanim_c', '.vagrp_c', '.vseq_c',
  '.vtex_c', '.vmat_c', '.vpcf_c', '.vsnd_c', '.vsndevts_c', '.png', '.jpg', '.jpeg', '.webp']);
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

function assetPath(value) {
  if (typeof value !== 'string' || value.length > 240 || !/^[a-zA-Z0-9_./-]+$/.test(value)) {
    throw new Error(t('Недопустимый путь ресурса: {0}', String(value).slice(0, 240)));
  }
  const parts = value.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part))
    || !ROOTS.has(parts[0]) || !TYPES.has(path.posix.extname(value).toLowerCase())) {
    throw new Error(t('Неподдерживаемый ресурс: {0}', value));
  }
  return value.toLowerCase();
}

function metadata(input) {
  const result = {};
  for (const [key, max] of Object.entries({ name: 100, description: 2000, hero: 100, slot: 100 })) {
    if (input[key] !== undefined && typeof input[key] !== 'string') throw new Error(t('Неверный формат проекта'));
    const value = (input[key] || '').trim();
    if (value.length > max) throw new Error(t('Неверный формат проекта'));
    result[key] = value;
  }
  if (!result.name) throw new Error(t('Укажи название проекта'));
  return result;
}

// Never traverse links inside our managed workspace, including a substituted root.
function noLinks(target) {
  for (let cur = path.resolve(target); ; cur = path.dirname(cur)) {
    try {
      if (fs.lstatSync(cur).isSymbolicLink()) throw new Error(t('Символические ссылки в проекте запрещены'));
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (cur === path.dirname(cur)) break;
  }
  return target;
}

function atomicWrite(target, bytes) {
  noLinks(target);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, bytes, { flag: 'wx' });
    fs.renameSync(temp, target);
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}

function readLimited(file, limit) {
  noLinks(file);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > limit) throw new Error(t('Превышен размер проекта или ресурса'));
    // Bounded even if another process grows the file during this read.
    const data = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < data.length) {
      const count = fs.readSync(fd, data, offset, data.length - offset, offset);
      if (!count) throw new Error(t('Ресурс изменён или повреждён'));
      offset += count;
    }
    return data;
  } finally { fs.closeSync(fd); }
}

class Projects {
  constructor(userData) { this.root = path.join(userData, 'workshop-projects'); }

  directory(id) {
    if (typeof id !== 'string' || !ID.test(id)) throw new Error(t('Неверный формат проекта'));
    return noLinks(path.join(this.root, id));
  }

  parse(input) {
    if (!input || input.version !== 1 || !Array.isArray(input.assets) || input.assets.length > LIMITS.files) {
      throw new Error(t('Неверный формат проекта'));
    }
    const info = metadata(input);
    const seen = new Set();
    let bytes = 0;
    const assets = input.assets.map((asset) => {
      const target = assetPath(asset.path);
      if (seen.has(target)) throw new Error(t('Путь уже есть в проекте: {0}', target));
      seen.add(target);
      if (!HASH.test(asset.hash) || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > LIMITS.fileBytes) {
        throw new Error(t('Неверный формат проекта'));
      }
      bytes += asset.size;
      return { path: target, hash: asset.hash, size: asset.size };
    });
    if (bytes > LIMITS.totalBytes) throw new Error(t('Превышен размер проекта или ресурса'));
    return { version: 1, ...info, assets };
  }

  get(id) {
    const input = JSON.parse(readLimited(path.join(this.directory(id), 'project.json'), 1024 * 1024));
    const clean = this.parse(input);
    if (input.id !== id || !Number.isSafeInteger(input.revision) || input.revision < 1) throw new Error(t('Неверный формат проекта'));
    return { ...clean, id, revision: input.revision, archived: input.archived === true,
      createdAt: input.createdAt, updatedAt: input.updatedAt };
  }

  list() {
    noLinks(this.root);
    if (!fs.existsSync(this.root)) return { projects: [], errors: [] };
    const projects = [], errors = [];
    for (const dir of fs.readdirSync(this.root, { withFileTypes: true })) {
      if (!ID.test(dir.name)) continue;
      try { projects.push(this.get(dir.name)); }
      catch (error) { errors.push({ id: dir.name, error: error.message }); }
    }
    projects.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    return { projects, errors };
  }

  persist(project) {
    atomicWrite(path.join(this.directory(project.id), 'project.json'), JSON.stringify(project, null, 2));
    return project;
  }

  create(input) {
    const now = new Date().toISOString();
    return this.persist({ ...metadata(input), version: 1, id: crypto.randomUUID(), revision: 1,
      assets: [], archived: false, createdAt: now, updatedAt: now });
  }

  current(id, revision) {
    const project = this.get(id);
    if (project.revision !== revision) throw new Error(t('Проект изменился. Открой его заново'));
    return project;
  }

  save(input) {
    const project = this.current(input.id, input.revision);
    return this.persist({ ...project, ...metadata(input), revision: project.revision + 1, updatedAt: new Date().toISOString() });
  }

  archive(id, revision, archived) {
    const project = this.current(id, revision);
    return this.persist({ ...project, archived: !!archived, revision: project.revision + 1, updatedAt: new Date().toISOString() });
  }

  addFiles(id, revision, files) {
    const project = this.current(id, revision);
    if (!Array.isArray(files) || !files.length || files.length + project.assets.length > LIMITS.files) {
      throw new Error(t('Превышен размер проекта или ресурса'));
    }
    const additions = [];
    let total = project.assets.reduce((sum, a) => sum + a.size, 0);
    const names = new Set(project.assets.map((a) => a.path));
    for (const file of files) {
      const target = assetPath(file.path);
      if (names.has(target)) throw new Error(t('Путь уже есть в проекте: {0}', target));
      names.add(target);
      const data = readLimited(file.source, Math.min(LIMITS.fileBytes, LIMITS.totalBytes - total));
      if (!data.length) throw new Error(t('Ресурс изменён или повреждён'));
      total += data.length;
      additions.push({ path: target, size: data.length, hash: hash(data), data });
    }
    for (const asset of additions) atomicWrite(path.join(this.directory(id), 'assets', asset.hash), asset.data);
    // Blobs are immutable; only this atomic manifest replacement publishes the change.
    project.assets.push(...additions.map(({ data, ...asset }) => asset));
    return this.persist({ ...project, revision: project.revision + 1, updatedAt: new Date().toISOString() });
  }

  addFolder(id, revision, folder) {
    const files = [];
    const walk = (dir, prefix = '') => {
      noLinks(dir);
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue;
        const rel = prefix + entry.name;
        if (rel.length > 240 || entry.isSymbolicLink()) throw new Error(t('Символические ссылки в проекте запрещены'));
        if (entry.isDirectory()) walk(path.join(dir, entry.name), rel + '/');
        else {
          assetPath(rel);
          files.push({ path: rel, source: path.join(dir, entry.name) });
          if (files.length > LIMITS.files) throw new Error(t('Превышен размер проекта или ресурса'));
        }
      }
    };
    walk(folder);
    return this.addFiles(id, revision, files);
  }

  removeAsset(id, revision, target) {
    const project = this.current(id, revision);
    target = assetPath(target);
    project.assets = project.assets.filter((asset) => asset.path !== target);
    return this.persist({ ...project, revision: project.revision + 1, updatedAt: new Date().toISOString() });
  }

  readAssets(project) {
    return project.assets.map((asset) => {
      const data = readLimited(path.join(this.directory(project.id), 'assets', asset.hash), LIMITS.fileBytes);
      if (data.length !== asset.size || hash(data) !== asset.hash) throw new Error(t('Ресурс изменён или повреждён'));
      return { ...asset, data };
    });
  }

  validate(id) {
    const project = this.get(id);
    const errors = [];
    if (!project.assets.length) errors.push(t('Добавь хотя бы один ресурс'));
    try { this.readAssets(project); } catch (error) { errors.push(error.message); }
    return { ok: !errors.length, errors, files: project.assets.length,
      bytes: project.assets.reduce((sum, a) => sum + a.size, 0) };
  }

  build(id) {
    const project = this.get(id);
    if (!project.assets.length) throw new Error(t('Добавь хотя бы один ресурс'));
    const entries = this.readAssets(project).sort((a, b) => a.path.localeCompare(b.path)).map((asset) => {
      const ext = path.posix.extname(asset.path);
      return { folder: path.posix.dirname(asset.path), name: path.posix.basename(asset.path, ext), ext: ext.slice(1),
        crc: crc32(asset.data), preload: Buffer.alloc(0), data: asset.data };
    });
    return { name: project.name, data: buildVpk(entries) };
  }

  exportZip(id) {
    const project = this.get(id);
    const zip = new AdmZip();
    zip.addFile('project.json', Buffer.from(JSON.stringify(this.parse(project), null, 2)));
    const added = new Set();
    for (const asset of this.readAssets(project)) {
      if (!added.has(asset.hash)) zip.addFile(`assets/${asset.hash}`, asset.data);
      added.add(asset.hash);
    }
    return zip.toBuffer();
  }

  importZip(source) {
    const zip = openZip(source, { limits: { archiveBytes: LIMITS.totalBytes + 1024 * 1024,
      entries: LIMITS.files + 1, entryBytes: LIMITS.fileBytes, totalBytes: LIMITS.totalBytes + 1024 * 1024 } });
    const manifest = zip.get('project.json');
    if (!manifest || manifest.size > 1024 * 1024) throw new Error(t('Неверный формат проекта'));
    const project = this.parse(JSON.parse(manifest.read()));
    const expected = new Set(['project.json', ...project.assets.map((a) => `assets/${a.hash}`)]);
    const seen = new Set();
    for (const entry of zip.files) {
      if (!expected.has(entry.path) || seen.has(entry.path)) throw new Error(t('Неверный формат проекта'));
      seen.add(entry.path);
    }
    const assets = project.assets.map((asset) => {
      const entry = zip.get(`assets/${asset.hash}`);
      if (!entry || entry.size !== asset.size) throw new Error(t('Ресурс изменён или повреждён'));
      const data = entry.read();
      if (data.length !== asset.size || hash(data) !== asset.hash) throw new Error(t('Ресурс изменён или повреждён'));
      return { ...asset, data };
    });
    const id = crypto.randomUUID();
    for (const asset of assets) atomicWrite(path.join(this.directory(id), 'assets', asset.hash), asset.data);
    const now = new Date().toISOString();
    return this.persist({ ...project, id, revision: 1, archived: false, createdAt: now, updatedAt: now });
  }
}

module.exports = { Projects, assetPath, LIMITS, atomicWrite };
