const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { adapters, httpsUrl, githubRepo, idOf } = require('./adapters');

const BUILTIN = Object.freeze({ id: 'd2pfx', name: 'D2PFX', url: 'https://github.com/h6rd/Dota2PornFxWeb', type: 'd2pfx', enabled: true });

class Sources {
  constructor(userData, catalog, options = {}) {
    this.file = path.join(userData, 'sources.json');
    this.cacheDir = path.join(userData, 'source-cache');
    this.adapters = options.adapters || adapters(catalog, options.readJson);
    this.status = new Map();
    this.pending = new Map();
    this.items = [ { ...BUILTIN } ];
    if (fs.existsSync(this.file)) {
      try {
        const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        if (!Array.isArray(data) || data.length > 32) throw new Error('Invalid sources.json');
        const items = data.map((item) => this.validate(item));
        if (!items.some((item) => item.id === BUILTIN.id)) items.unshift({ ...BUILTIN });
        if (items.length > 32 || new Set(items.map((item) => item.id)).size !== items.length) throw new Error('Invalid source ids');
        this.items = items;
      } catch (error) {
        // A damaged optional module config must not stop the original library opening.
        // Keep the file for recovery and refuse to overwrite it with fallback defaults.
        this.configError = `Cannot read sources.json: ${error.message}`;
      }
    }
  }

  validate(input) {
    if (input.id === BUILTIN.id) return { ...BUILTIN, enabled: input.enabled !== false };
    if (!/^[a-f0-9-]{36}$/.test(input.id || '')) throw new Error('Invalid source id');
    if (!['github', 'manifest'].includes(input.type)) throw new Error('Unsupported source type');
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 100) throw new Error('Source name must contain 1–100 characters');
    const url = httpsUrl(input.url);
    if (input.type === 'github') githubRepo(url);
    return { id: input.id, name: input.name.trim(), url, type: input.type, enabled: input.enabled !== false };
  }

  list() {
    return this.items.map((source) => ({ ...source, ...(this.status.get(source.id) || { state: 'unknown' }), warning: this.configError || null }));
  }

  persist(next) {
    if (this.configError) throw new Error(this.configError);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(next, null, 2));
    fs.renameSync(`${this.file}.tmp`, this.file);
    this.items = next;
  }

  save(input) {
    if (!input || typeof input !== 'object') throw new Error('Invalid source');
    if (input.id && !this.items.some((source) => source.id === input.id)) throw new Error('Source no longer exists');
    const source = this.validate({ ...input, id: input.id || crypto.randomUUID() });
    const next = this.items.filter((item) => item.id !== source.id);
    if (next.length >= 32) throw new Error('Maximum 32 sources');
    if (next.some((item) => item.url === source.url && item.type === source.type)) throw new Error('Source already exists');
    next.push(source);
    next.sort((a, b) => Number(b.id === BUILTIN.id) - Number(a.id === BUILTIN.id));
    this.persist(next);
    this.status.delete(source.id);
    return this.list();
  }

  remove(id) {
    if (id === BUILTIN.id) throw new Error('The built-in source can be disabled, not removed');
    this.persist(this.items.filter((source) => source.id !== id));
    this.status.delete(id);
    return this.list();
  }

  async load(source, force = false) {
    const key = `${source.id}-${idOf('v1-groups:' + source.url + source.type)}`;
    if (this.pending.has(key)) return this.pending.get(key);
    const promise = this.loadOne(source, key, force).finally(() => this.pending.delete(key));
    this.pending.set(key, promise);
    return promise;
  }

  async loadOne(source, key, force) {
    const file = path.join(this.cacheDir, `${key}.json`);
    let cached = null;
    try { cached = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first load */ }
    if (!force && cached && Date.now() - cached.at < 30 * 60 * 1000) {
      this.status.set(source.id, { state: 'cached', checkedAt: cached.at, count: cached.mods.length });
      return cached.mods.map((mod) => ({ ...mod, sourceName: source.name }));
    }
    try {
      const data = await this.adapters[source.type].load(source, force);
      const at = Date.now();
      fs.mkdirSync(this.cacheDir, { recursive: true });
      fs.writeFileSync(`${file}.tmp`, JSON.stringify({ at, mods: data.mods }));
      fs.renameSync(`${file}.tmp`, file);
      this.status.set(source.id, { state: data.stale ? 'stale' : 'available', checkedAt: at, count: data.mods.length, error: data.stale });
      return data.mods;
    } catch (err) {
      this.status.set(source.id, { state: cached ? 'stale' : 'unavailable', checkedAt: Date.now(), error: String(err.message || err), count: cached?.mods?.length || 0 });
      return (cached?.mods || []).map((mod) => ({ ...mod, sourceName: source.name }));
    }
  }

  async search(query = '', { force = false } = {}) {
    const sources = this.items.filter((source) => source.enabled);
    const results = await Promise.all(sources.map(async (source) => ({ source, mods: await this.load(source, force) })));
    const current = new Map(this.items.filter((source) => source.enabled).map((source) => [source.id, source.url]));
    const words = String(query).toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
    const mods = results.filter(({ source }) => current.get(source.id) === source.url).flatMap(({ mods }) => mods)
      .filter((mod) => words.every((word) => [mod.name, mod.categoryId, mod.sourceName, ...mod.tags].join(' ').toLocaleLowerCase().includes(word)));
    return { mods, sources: this.list(), categories: [...new Set(mods.map((mod) => mod.categoryId))] };
  }

  async resolve({ sourceId, modId, fileId }) {
    const source = this.items.find((item) => item.id === sourceId && item.enabled);
    if (!source) throw new Error('Source disabled or removed');
    const mods = await this.load(source);
    if (!this.items.some((item) => item.id === sourceId && item.enabled && item.url === source.url)) throw new Error('Source changed during loading');
    const mod = mods.find((item) => item.id === modId);
    const file = mod?.files.find((item) => item.id === fileId);
    if (!file) throw new Error('Mod file no longer exists');
    return { categoryId: mod.categoryId, name: mod.name, styleLabel: Object.hasOwn(file, 'styleLabel') ? file.styleLabel : file.label,
      fileRef: file.url, preview: mod.preview, sourceId, sourceName: source.name, sourceModId: mod.id };
  }
}

module.exports = { Sources, BUILTIN };
