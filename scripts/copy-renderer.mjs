// Copia os assets do renderer (html/css/js) para dist/renderer.
// O TS do renderer é checado pelo typecheck, mas servido como módulo ES nativo.
import { cpSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const src = join(root, '..', 'src', 'renderer');
const out = join(root, '..', 'dist', 'renderer');

if (!existsSync(src)) {
  console.error(`Pasta do renderer não encontrada: ${src}`);
  process.exit(1);
}

mkdirSync(out, { recursive: true });
cpSync(src, out, { recursive: true });
console.log('Renderer copiado para dist/renderer');
