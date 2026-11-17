// La aplicación Express del backend de VideoTk (index.js la arranca).
//   /api/auth/...   cuentas y sesiones
//   /api/...        videos, categorías y foto de perfil
//   /               la web (opcional, SERVE_WEB): así un solo servidor sirve todo
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import express from 'express';
import { config } from './config.js';
import { openDatabase } from './db.js';
import { ApiError } from './http.js';
import { authRoutes } from './routes/auth.js';
import { dataRoutes } from './routes/data.js';

const WEB_FILES = ['index.html', 'styles.css', 'app.js', 'api-client.js', 'sw.js', 'manifest.webmanifest'];

export async function createApp(db) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);

  app.use((req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin' });
    next();
  });

  // CORS: la web publicada en otro dominio (GitHub Pages) y las apps de Android/iOS llaman a la API.
  app.use('/api', (req, res, next) => {
    const origin = req.get('origin');
    if (origin && (config.corsOrigins.includes('*') || config.corsOrigins.includes(origin))) {
      res.set({
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Headers': 'authorization, content-type',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
        'Access-Control-Max-Age': '86400',
        Vary: 'Origin',
      });
    }
    if (req.method === 'OPTIONS') return res.status(204).end();
    res.set('Cache-Control', 'no-store');
    next();
  });

  app.use('/api', express.json({ limit: '5mb' }));
  app.get('/api/health', async (_req, res) => {
    await db.get('SELECT 1 AS ok');
    res.json({ ok: true, db: db.client });
  });
  app.use('/api/auth', authRoutes(db));
  app.use('/api', dataRoutes(db));
  app.use('/api', (_req, _res, next) => next(new ApiError(404, 'not_found', 'Esa ruta no existe.')));

  if (config.serveWeb && existsSync(join(config.webDir, 'index.html'))) {
    // La web servida desde aquí usa siempre esta API (no Supabase).
    app.get('/config.js', (_req, res) => {
      res.type('application/javascript').set('Cache-Control', 'no-cache')
        .send("window.VIDEOTECA_CONFIG = { backend: 'api', apiUrl: '' };\n");
    });
    // Solo los archivos de la app: nunca el resto de la carpeta (.env, base de datos, etc.).
    app.get('/', (_req, res) => res.sendFile(join(config.webDir, 'index.html')));
    for (const file of WEB_FILES) {
      app.get(`/${file}`, (_req, res) => res.set('Cache-Control', 'no-cache').sendFile(join(config.webDir, file)));
    }
    app.use('/icons', express.static(join(config.webDir, 'icons'), { dotfiles: 'deny', index: false, maxAge: '7d' }));
  }

  // Errores: los conocidos salen con su código; el resto como 500 sin detalles internos.
  app.use((error, _req, res, _next) => {
    if (error instanceof ApiError) return res.status(error.status).json({ code: error.code, message: error.message });
    if (error && error.type === 'entity.too.large') return res.status(413).json({ code: 'payload_too_large', message: 'El archivo es demasiado grande.' });
    if (error && error.type === 'entity.parse.failed') return res.status(400).json({ code: 'bad_json', message: 'Datos no válidos.' });
    console.error(error);
    res.status(500).json({ code: 'unexpected_failure', message: 'Error del servidor.' });
  });

  return app;
}
