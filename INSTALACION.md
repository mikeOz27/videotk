# Instalación de VideoTk

Guía para correr VideoTk en tu PC, con Docker o en un hosting.

## Con qué está hecho

| Parte | Tecnología |
|---|---|
| **Front** (la web) | HTML, CSS y JavaScript sin frameworks. Es una PWA (se instala en el celular) |
| **Back** (carpeta `server/`) | **Node.js 22 + Express 5**. Sesiones con JWT, contraseñas con scrypt y correos con Nodemailer (SMTP) |
| **Base de datos** | **SQLite**, **PostgreSQL** o **MySQL**: se elige con una variable de entorno, sin cambiar código |
| **App móvil** (carpeta `mobile/`) | Capacitor 8 (Android e iOS) con los mismos archivos de la web |

La web puede trabajar con dos backends y se cambia en [config.js](config.js):

- `backend: 'supabase'`: usa Supabase, como al principio. No necesita servidor propio.
- `backend: 'api'`: usa el backend propio de la carpeta `server/`.

> Cada backend tiene **sus propias cuentas y videos**. Para pasar tus videos de uno a otro, en Ajustes usa
> **Exportar archivo** en el viejo y **Importar archivo** en el nuevo.

---

## 1. En tu PC (local)

### Requisitos

- **Node.js 22.13 o más nuevo** (el backend usa SQLite integrado en Node).
  Con nvm: `nvm install 22` y `nvm use 22`. Para volver a tu versión de siempre después: `nvm use 14.21.3`.
- Git.

### Opción A: web y API juntas (la más simple)

El servidor entrega la web y la API en el mismo puerto.

```bash
cd server
npm install
npm start
```

Abre **http://localhost:3000**. La web servida así usa la API sola, sin tocar `config.js`.

- Los datos quedan en `server/data/videotk.db`. Si borras la carpeta `server/data`, empiezas de cero.
- Sin SMTP configurado, los correos (códigos de 6 dígitos y enlaces) **salen en la terminal** del servidor.
- Con `npm run dev` el servidor se reinicia solo cuando cambias su código.

### Opción B: web y API por separado

Así se parece a tener la web en GitHub Pages y la API en otro lado.

1. En [config.js](config.js):
   ```js
   backend: 'api',
   apiUrl: 'http://localhost:3000',
   ```
2. En `server/.env` (si no existe, cópialo de `server/.env.example`), permite el puerto de la web:
   ```
   CORS_ORIGINS=http://localhost:5173,https://mikeoz27.github.io,https://localhost,capacitor://localhost
   SITE_URLS=http://localhost:5173/
   ```
3. Terminal 1, la API:
   ```bash
   cd server
   npm start
   ```
4. Terminal 2, la web (desde la carpeta raíz):
   ```bash
   npx http-server . -p 5173 -c-1
   ```
5. Abre **http://localhost:5173**.

> Antes de subir a git, vuelve `config.js` a como debe quedar publicado. Si no, la web de GitHub Pages
> intentará usar `localhost:3000`.

### Opción C: solo la web con Supabase

Con `backend: 'supabase'` en `config.js` no hace falta el servidor:

```bash
npx http-server . -p 5173 -c-1
```

### Probar desde el celular en la misma red WiFi

Arranca el servidor (opción A) y abre `http://IP-DE-TU-PC:3000` en el celular. La IP la ves con `ipconfig`.
Si Windows pregunta por el firewall, permite el acceso en redes privadas.

### Pruebas automáticas del backend

```bash
cd server
npm test
```

Para probarlas contra PostgreSQL o MySQL, define antes `DB_CLIENT` y `DATABASE_URL` (ver sección 4).

---

## 2. Correo (SMTP)

El backend envía los códigos, los enlaces para cambiar la contraseña y la confirmación de cuenta.
Usamos **Brevo** (plan gratis). En `server/.env`:

```
SMTP_HOST=smtp-relay.brevo.com
SMTP_PORT=587
SMTP_USER=tu-login-smtp@smtp-brevo.com
SMTP_PASS=tu-clave-smtp-de-brevo
SMTP_FROM=VideoTk <remitente-verificado-en-brevo@gmail.com>
```

- La clave se saca en Brevo, en **SMTP & API → SMTP → Generate a new SMTP key**.
- Reinicia el servidor después de cambiar el `.env`. Al arrancar debe decir `correo: SMTP`.
- Con SMTP activo, crear una cuenta pide confirmar el correo. Para no pedirlo: `EMAIL_CONFIRM=false`.
- Si pides un código con un correo que **no tiene cuenta en ese servidor**, no se envía nada (por seguridad, la
  app responde igual). En la terminal del servidor sale un aviso.
- En internet hace falta `PUBLIC_URL` (ver sección 4); sin ella no se envían enlaces.

---

## 3. Con Docker

Necesitas Docker Desktop (Windows o Mac) o Docker Engine (Linux). Los comandos van **desde la carpeta raíz**
del proyecto.

### Con SQLite (lo más simple)

```bash
docker compose up -d --build
```

Abre **http://localhost:3000**. Los datos quedan en el volumen `videotk-data`, así que sobreviven a reinicios y
actualizaciones. El contenedor también lee `server/.env` si existe (SMTP, etc.).

| Para | Comando |
|---|---|
| Ver lo que escribe el servidor (correos de prueba, errores) | `docker compose logs -f app` |
| Detenerlo | `docker compose down` |
| Actualizar después de cambiar el código | `docker compose up -d --build` |

### Con PostgreSQL

1. En [docker-compose.yml](docker-compose.yml), descomenta las dos líneas `DB_CLIENT` y `DATABASE_URL` del servicio `app`.
2. Arranca con el perfil `postgres`:
   ```bash
   docker compose --profile postgres up -d --build
   ```

### Sin compose (solo la imagen)

```bash
docker build -f server/Dockerfile -t videotk .
docker run -d --name videotk -p 3000:3000 -v videotk-data:/data --env-file server/.env videotk
```

Esta imagen sirve para cualquier hosting que acepte Docker (Fly.io, Railway, un VPS…).

---

## 4. En un hosting (internet)

### Variables importantes

Se ponen en el panel del hosting (sección "Environment") o en `server/.env` si es tu propio servidor.
Todas están explicadas en [server/.env.example](server/.env.example).

| Variable | Valor | ¿Obligatoria? |
|---|---|---|
| `PUBLIC_URL` | Dirección pública de la API, p. ej. `https://videotk-api.onrender.com` | **Sí**, para los enlaces de los correos |
| `JWT_SECRET` | Texto aleatorio de 32 caracteres o más, secreto | **Sí**, si el disco del hosting es temporal |
| `TRUST_PROXY` | `1` | Sí, en Render, Railway, Fly o detrás de Nginx |
| `DB_CLIENT` | `sqlite`, `postgres` o `mysql` | No (por defecto `sqlite`) |
| `DATABASE_URL` | `postgres://usuario:clave@host:5432/base` o `mysql://...` | Con postgres o mysql |
| `DB_SSL` | `true` | Casi siempre con bases en la nube |
| `SITE_URLS` | Webs a las que vuelven los enlaces de los correos | Si la web no está en GitHub Pages |
| `CORS_ORIGINS` | Webs y apps que pueden usar la API | Si la web está en otro dominio |
| `SMTP_*` | Datos de Brevo (sección 2) | Para enviar correos |

Para generar un `JWT_SECRET`:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

> **SQLite solo en hostings con disco permanente** (tu PC, un VPS, Docker con volumen). En Render o Railway el disco
> se borra al reiniciar: ahí usa PostgreSQL.

### Opción 1: Render (Node) + Neon (PostgreSQL), gratis

1. **Base de datos:** crea una cuenta en https://neon.tech y un proyecto, y copia la *connection string*
   (`postgres://...`).
2. **Servidor:** en https://render.com, crea un **New → Web Service** y conecta el repositorio de GitHub.
   - **Root Directory:** `server`
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Environment:** `DB_CLIENT=postgres`, `DATABASE_URL=...`, `DB_SSL=true`, `JWT_SECRET=...`, `TRUST_PROXY=1`,
     `PUBLIC_URL=https://<tu-servicio>.onrender.com`, `NODE_VERSION=22` y los `SMTP_*`.
3. Abre `https://<tu-servicio>.onrender.com/api/health`. Debe responder `{"ok":true,"db":"postgres"}`.
4. La web también queda en `https://<tu-servicio>.onrender.com`.

> El plan gratis de Render "se duerme" tras 15 minutos sin uso. La primera visita después tarda unos 30-50 segundos.

### Opción 2: Railway

1. Crea un proyecto desde el repositorio y agrega un servicio **PostgreSQL**.
2. En el servicio de la app: **Root Directory** `server`, y las variables de la tabla.
   `DATABASE_URL` se puede enlazar con la de la base de Railway.
3. Railway también acepta el `Dockerfile` (`server/Dockerfile`, con la raíz del repo como contexto).

### Opción 3: VPS propio (Ubuntu, DigitalOcean, Oracle Cloud gratis…)

```bash
# Node 22
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs git nginx

# Código
git clone https://github.com/mikeOz27/videotk.git
cd videotk/server
npm install --omit=dev
cp .env.example .env      # edítalo: PUBLIC_URL, JWT_SECRET, TRUST_PROXY=1, SMTP_*...

# Que quede corriendo siempre (y arranque solo al reiniciar)
sudo npm install -g pm2
pm2 start src/index.js --name videotk
pm2 save && pm2 startup
```

Con Nginx como proxy y HTTPS gratis:

```nginx
server {
    server_name api.tudominio.com;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d api.tudominio.com
```

Para actualizar: `git pull` y `pm2 restart videotk`. También puedes usar Docker (sección 3) en el VPS.

### Opción 4: hosting con cPanel que tenga "Setup Node.js App"

1. Sube el proyecto y en **Setup Node.js App** crea la app con Node 22, **Application root** `server` y
   **Startup file** `src/index.js`.
2. Usa MySQL del hosting: crea la base y el usuario en **MySQL Databases** y pon `DB_CLIENT=mysql` y
   `DATABASE_URL=mysql://usuario:clave@localhost:3306/base`.
3. Agrega las demás variables y pulsa **Run NPM Install** y luego **Restart**.

> Los hostings que solo tienen PHP (sin Node) no pueden correr este backend.

### La web en GitHub Pages usando tu API

Si quieres seguir publicando la web en GitHub Pages pero con tu servidor:

1. En [config.js](config.js): `backend: 'api'` y `apiUrl: 'https://<tu-api>'`.
2. En el servidor, `CORS_ORIGINS` debe incluir `https://mikeoz27.github.io` (ya viene por defecto) y
   `SITE_URLS=https://mikeoz27.github.io/videotk/`.
3. Sube los cambios a git. GitHub Pages se actualiza solo.

---

## 5. App de Android / iOS

La app lleva los archivos de la web dentro, incluido `config.js`. Para que use tu API:

1. En `config.js`: `backend: 'api'` y `apiUrl: 'https://<tu-api>'` (debe ser **https** y pública; `localhost` no
   sirve en el celular).
2. Vuelve a compilar e instalar:
   ```bash
   cd mobile
   npm run apk
   ```
   Luego instala `android/app/build/outputs/apk/debug/app-debug.apk`. Para iOS, el flujo de GitHub Actions
   "App iOS (.ipa)".
3. En el servidor, `CORS_ORIGINS` ya incluye `https://localhost` (Android) y `capacitor://localhost` (iOS).

Más detalles en [mobile/README.md](mobile/README.md).

---

## 6. Problemas comunes

| Síntoma | Causa y solución |
|---|---|
| `No such built-in module: node:sqlite` o errores raros al arrancar | Node viejo. Usa Node 22.13+ (`nvm use 22`) |
| No llegan los correos | ¿El servidor dice `correo: SMTP` al arrancar? ¿El correo tiene cuenta **en ese servidor**? Revisa spam y las líneas `[correo]` de la terminal |
| La app dice "No pudimos enviar el correo" | SMTP mal configurado (usuario, clave o remitente no verificado en Brevo) o falta `PUBLIC_URL` en internet |
| La web en otro dominio no conecta (error CORS en la consola) | Agrega ese dominio exacto a `CORS_ORIGINS` y reinicia |
| Todos pierden la sesión al reiniciar el servidor | Falta `JWT_SECRET` y el disco del hosting es temporal |
| Los videos desaparecen al reiniciar en Render o Railway | Estás usando SQLite en un disco temporal: cambia a PostgreSQL |
| `EADDRINUSE: 3000` | Ya hay algo en el puerto 3000 (otro servidor o Docker). Ciérralo o usa `PORT=3001` |

Referencia completa de la API y de las variables: [server/README.md](server/README.md).
