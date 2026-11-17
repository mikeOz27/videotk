// Arranca el servidor: npm start (lee la configuración de .env o de las variables de entorno).
import { config } from './config.js';
import { openDatabase } from './db.js';
import { createApp } from './app.js';

const db = await openDatabase();
const app = await createApp(db);
if (!config.publicUrl) console.warn('[config] PUBLIC_URL no está definido: los enlaces de los correos solo funcionarán en tu PC o red local.');
const server = app.listen(config.port, () => {
  console.log(`VideoTk API en http://localhost:${config.port}  (base de datos: ${db.client}, correo: ${config.mail.ready ? 'SMTP' : 'consola'})`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => db.close().finally(() => process.exit(0))));
}
