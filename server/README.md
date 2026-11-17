# Backend de VideoTk

Servidor propio con las APIs de la app (cuentas, videos, categorías y foto de perfil), para no depender de Supabase.
Es Node.js 22 + Express, y la base de datos puede ser **SQLite, PostgreSQL o MySQL** según dónde lo subas.

## Cómo elige la app entre Supabase y este servidor

En `config.js` (carpeta de arriba):

```js
backend: 'supabase',   // como hasta ahora
backend: 'api',        // este servidor
apiUrl: 'https://videotk-api.onrender.com',  // dónde está el servidor (vacío = mismo sitio que la web)
```

Si este servidor también entrega la web (`SERVE_WEB=true`, por defecto), genera él mismo un `config.js` con
`backend: 'api'`: abre `http://tu-servidor/` y ya usa la API, sin tocar nada.

La app de Android/iOS lleva `config.js` dentro: cambia `backend` y `apiUrl` **antes** de compilar el APK o el .ipa.

## Probarlo en tu PC

```bash
cd server
npm install
npm start
```

Abre http://localhost:3000. Sin SMTP, los correos (códigos y enlaces) salen en la consola del servidor.
Los datos quedan en `server/data/videotk.db` (SQLite).

Pruebas automáticas: `npm test` (con `DB_CLIENT` y `DATABASE_URL` también prueba PostgreSQL o MySQL).

## Configuración

Copia `.env.example` como `.env` (en un hosting, pon las variables en su panel). Lo importante:

| Variable | Para qué |
|---|---|
| `DB_CLIENT` | `sqlite` (por defecto), `postgres` o `mysql` |
| `DATABASE_URL` | Conexión a PostgreSQL/MySQL, p. ej. `postgres://usuario:clave@host/base` |
| `DB_SSL` | `true` para bases en la nube (Neon, Railway, Aiven…) |
| `JWT_SECRET` | Clave de las sesiones, mínimo 32 caracteres. **Obligatoria en hostings con disco temporal** |
| `PUBLIC_URL` | Dirección pública del servidor. **Obligatoria en internet** (los enlaces de los correos la usan) |
| `TRUST_PROXY` | `1` en Render, Railway, Fly, Nginx… |
| `SITE_URLS` | Webs a las que vuelven los enlaces de los correos (la primera es la de por defecto) |
| `CORS_ORIGINS` | Webs y apps que pueden usar la API (ya incluye GitHub Pages y las apps de Android/iOS) |
| `SMTP_*` | Correo saliente (Brevo, Gmail con contraseña de aplicación, etc.) |

Las tablas se crean solas al arrancar.

## Dónde subirlo

- **Tu PC o un VPS**: `npm start` con SQLite. Para que no se apague, usa `pm2` o un servicio de Windows/systemd.
- **Render / Railway** (Node): directorio raíz `server`, comando `npm install` y `npm start`.
  Su disco se borra al reiniciar, así que usa PostgreSQL (`DB_CLIENT=postgres`); **Neon** tiene una base gratis permanente.
- **Fly.io u otro con Docker**: `docker build -f server/Dockerfile -t videotk .` desde la carpeta raíz. Monta un volumen en `/data` si usas SQLite.
- **Laragon / hosting con MySQL**: `DB_CLIENT=mysql` y `DATABASE_URL=mysql://root@127.0.0.1:3306/videotk` (crea antes la base vacía).

## Pasar tus videos de Supabase a este servidor

1. Con la app en modo Supabase: Ajustes → **Exportar archivo**.
2. Cambia a `backend: 'api'`, crea tu cuenta en el servidor nuevo y entra.
3. Ajustes → **Importar archivo**. Las categorías se crean solas.

La foto de perfil se vuelve a poner a mano.

## API

Todas las rutas van bajo `/api` y, salvo las de entrar, piden `Authorization: Bearer <access_token>`.

| Método y ruta | Qué hace |
|---|---|
| `POST /auth/signup` | Crear cuenta `{ email, password, redirect_to }` |
| `POST /auth/token` | Entrar con contraseña → sesión |
| `POST /auth/token/refresh` | Renovar la sesión `{ refresh_token }` |
| `POST /auth/otp` · `POST /auth/verify` | Pedir y comprobar el código de 6 dígitos |
| `POST /auth/recover` | Enviar el enlace para cambiar la contraseña |
| `GET /auth/verify` | Destino del enlace del correo: vuelve a la web con la sesión |
| `GET /auth/user` · `PUT /auth/user` | Ver y cambiar contraseña o foto (`data.avatar_url`) |
| `POST /auth/logout` | Cerrar sesión |
| `GET/POST /videos`, `PATCH/DELETE /videos/:id` | Videos |
| `POST /videos/bulk` | Importar varios (salta los repetidos) |
| `GET/POST /categories`, `PATCH/DELETE /categories/:id` | Categorías |
| `PUT/DELETE /avatar`, `GET /avatars/:userId/avatar.jpg` | Foto de perfil (se guarda en la base) |
| `GET /health` | Comprobar que el servidor y la base responden |
