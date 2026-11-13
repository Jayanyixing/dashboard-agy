import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const PLUGIN_DIR = path.join(os.homedir(), '.gemini', 'config', 'plugins', 'dashboard-agy');

function install() {
  fs.mkdirSync(path.dirname(PLUGIN_DIR), { recursive: true });

  const mode = process.argv.includes('--copy') ? 'copy' : 'symlink';

  try {
    const stat = fs.lstatSync(PLUGIN_DIR);
    if (stat.isSymbolicLink() || stat.isFile()) {
      fs.unlinkSync(PLUGIN_DIR);
    } else if (stat.isDirectory()) {
      fs.rmSync(PLUGIN_DIR, { recursive: true, force: true });
    }
  } catch {
    // Target does not exist yet.
  }

  if (mode === 'symlink') {
    fs.symlinkSync(REPO_ROOT, PLUGIN_DIR, 'dir');
    console.log(`Linked ${PLUGIN_DIR} -> ${REPO_ROOT}`);
  } else {
    fs.cpSync(REPO_ROOT, PLUGIN_DIR, {
      recursive: true,
      filter: (src) => !src.includes(`${path.sep}node_modules`) && !src.includes(`${path.sep}.git`),
    });
    console.log(`Copied ${REPO_ROOT} -> ${PLUGIN_DIR}`);
  }
}

install();
