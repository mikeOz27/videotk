// Toda la configuración sale de variables de entorno (o del archivo .env de esta carpeta).
// Así el mismo código sirve en tu PC, en un VPS o en Render/Railway/Fly: solo cambian las variables.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SERVER_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const envFile = join(SERVER_DIR, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const env = process.env;
const list = (value) => String(value || '').split(',').map((part) => part.trim()).filter(Boolean);
const bool = (value, fallback) => (value === undefined || value === '' ? fallback : /^(1|true|yes|si|sí)$/i.test(value));

const dbClient = (env.DB_CLIENT || 'sqlite').toLowerCase();
if (!['sqlite', 'postgres', 'mysql'].includes(dbClient)) {
  throw new Error(`DB_CLIENT="${env.DB_CLIENT}" no es válido. Usa sqlite, postgres o mysql.`);
}
if (dbClient !== 'sqlite' && !env.DATABASE_URL) {
  throw new Error(`Con DB_CLIENT=${dbClient} hace falta DATABASE_URL (la dirección de conexión de la base).`);
}

const dataDir = resolve(SERVER_DIR, env.DATA_DIR || 'data');

// Sin JWT_SECRET se crea uno y se guarda en data/ para que reiniciar no cierre las sesiones.
// En hostings con disco temporal (Render, Railway…) pon JWT_SECRET en las variables de entorno.
function jwtSecret() {
  if (env.JWT_SECRET) {
    if (env.JWT_SECRET.length < 32) throw new Error('JWT_SECRET debe tener al menos 32 caracteres.');
    return env.JWT_SECRET;
  }
  const file = join(dataDir, 'jwt-secret');
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  mkdirSync(dataDir, { recursive: true });
  const secret = randomBytes(48).toString('base64url');
  writeFileSync(file, secret, { mode: 0o600 });
  console.warn('[config] JWT_SECRET no está definido: se generó uno en data/jwt-secret.');
  return secret;
}

const smtpReady = Boolean(env.SMTP_HOST && env.SMTP_FROM);

export const config = {
  port: Number(env.PORT) || 3000,
  // Detrás de un proxy (Render, Railway, Nginx…) pon TRUST_PROXY=1 para leer bien la IP y el https.
  trustProxy: env.TRUST_PROXY ? (/^\d+$/.test(env.TRUST_PROXY) ? Number(env.TRUST_PROXY) : bool(env.TRUST_PROXY, false)) : false,
  publicUrl: (env.PUBLIC_URL || '').replace(/\/+$/, ''),

  db: {
    client: dbClient,
    url: env.DATABASE_URL || '',
    ssl: bool(env.DB_SSL, false),
    poolMax: Number(env.DB_POOL_MAX) || 5,
    sqliteFile: resolve(SERVER_DIR, env.SQLITE_FILE || join(dataDir, 'videotk.db')),
  },

  jwtSecret: jwtSecret(),
  accessTtl: 60 * 60,                 // segundos: 1 hora
  refreshTtl: 60 * 60 * 24 * 60,      // segundos: 60 días sin abrir la app
  otpLength: 6,
  otpTtl: 15 * 60,
  linkTtl: 60 * 60,
  emailCooldown: 60,                  // segundos entre correos al mismo destinatario

  // Páginas a las que pueden volver los enlaces de los correos (la primera es la de por defecto).
  siteUrls: list(env.SITE_URLS || 'https://mikeoz27.github.io/videotk/'),
  // Webs que pueden llamar a la API desde el navegador. La app de Android usa https://localhost y la de iOS capacitor://localhost.
  corsOrigins: list(env.CORS_ORIGINS || 'https://mikeoz27.github.io,https://localhost,capacitor://localhost'),

  // Si este servidor también entrega la web (index.html, app.js…) desde la carpeta de arriba.
  serveWeb: bool(env.SERVE_WEB, true),
  webDir: resolve(SERVER_DIR, env.WEB_DIR || '..'),

  mail: {
    ready: smtpReady,
    host: env.SMTP_HOST,
    port: Number(env.SMTP_PORT) || 587,
    secure: bool(env.SMTP_SECURE, Number(env.SMTP_PORT) === 465),
    user: env.SMTP_USER,
    pass: env.SMTP_PASS,
    from: env.SMTP_FROM,
  },
  // Pedir que confirmen el correo al crear la cuenta (solo tiene sentido si hay SMTP).
  emailConfirm: bool(env.EMAIL_CONFIRM, smtpReady),
  allowSignup: bool(env.ALLOW_SIGNUP, true),
};
