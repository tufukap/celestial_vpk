// Launch the UI against a disposable game tree, not the installed game.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { buildVpk } = require('../src/vpk');
const root = path.resolve(__dirname, '..');
const profile = path.join(root, 'sandbox', 'workshop', 'userdata');
const game = path.join(root, 'sandbox', 'workshop', 'steamapps', 'common', 'dota 2 beta', 'game');
fs.mkdirSync(path.join(game, 'dota', 'cfg'), { recursive: true });
fs.mkdirSync(profile, { recursive: true });
const marker = path.join(game, 'dota', 'pak01_dir.vpk');
if (!fs.existsSync(marker)) fs.writeFileSync(marker, buildVpk([]));
const config = path.join(profile, 'settings.json');
if (!fs.existsSync(config)) fs.writeFileSync(config, JSON.stringify({
  dotaGamePath: game, uiLang: 'ru', langPromptSeen: true, toolsPromptSeen: true,
  discordPresence: false, schemaPatch: false,
}, null, 2));
if (process.argv.includes('--prepare-only')) {
  console.log(profile);
} else {
  const child = spawn(require('electron'), [root, `--user-data-dir=${profile}`, '--workshop-preview', ...process.argv.slice(2)], {
    cwd: root, stdio: 'inherit', env: { ...process.env, MANGOHUD: '0' },
  });
  child.on('error', (error) => { console.error(error); process.exitCode = 1; });
  child.on('exit', (code) => { process.exitCode = code ?? 1; });
}
