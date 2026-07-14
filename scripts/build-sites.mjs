import { cpSync, copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const staticDir = join(root, '.site-static');
const distDir = join(root, 'dist');

rmSync(staticDir, { recursive: true, force: true });
rmSync(distDir, { recursive: true, force: true });

const viteResult = spawnSync(
  process.execPath,
  [join(root, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--outDir', staticDir],
  { cwd: root, stdio: 'inherit' },
);

if (viteResult.status !== 0) {
  process.exit(viteResult.status ?? 1);
}

mkdirSync(join(distDir, 'server'), { recursive: true });
mkdirSync(join(distDir, '.openai'), { recursive: true });
cpSync(staticDir, join(distDir, 'client'), { recursive: true });
copyFileSync(join(root, 'hosting', 'server.mjs'), join(distDir, 'server', 'index.js'));
copyFileSync(join(root, '.openai', 'hosting.json'), join(distDir, '.openai', 'hosting.json'));
rmSync(staticDir, { recursive: true, force: true });

console.log('Sites bundle created in dist/');
