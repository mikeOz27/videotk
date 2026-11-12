// Copia los archivos de la app web (carpeta de arriba) a www/, que es lo que Capacitor mete en la app.
// Las librerías (Supabase y SweetAlert2) se copian desde node_modules para que la app abra sin internet.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const mobile = join(here, '..');
const root = join(mobile, '..');
const www = join(mobile, 'www');
const FILES = ['index.html', 'styles.css', 'app.js', 'config.js', 'manifest.webmanifest', 'icons'];
const LIBS = [
  ['https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js', '@supabase/supabase-js/dist/umd/supabase.js', 'vendor/supabase.js'],
  ['https://cdn.jsdelivr.net/npm/sweetalert2@11.14.5/dist/sweetalert2.all.min.js', 'sweetalert2/dist/sweetalert2.all.min.js', 'vendor/sweetalert2.all.min.js'],
];

rmSync(www, { recursive: true, force: true });
mkdirSync(join(www, 'vendor'), { recursive: true });
for (const name of FILES) cpSync(join(root, name), join(www, name), { recursive: true });

let html = readFileSync(join(www, 'index.html'), 'utf8');
for (const [cdn, pkgPath, local] of LIBS) {
  if (!html.includes(cdn)) throw new Error(`index.html ya no usa ${cdn}: actualiza LIBS en copy-web.mjs (y la versión en package.json).`);
  cpSync(join(mobile, 'node_modules', pkgPath), join(www, local));
  html = html.replace(cdn, local);
}
writeFileSync(join(www, 'index.html'), html);
console.log(`Copiados a www/: ${FILES.join(', ')} + librerías locales`);
