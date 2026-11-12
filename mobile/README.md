# VideoTk para Android (Capacitor)

La app nativa usa los mismos archivos de la web (`../index.html`, `../app.js`, …).
`scripts/copy-web.mjs` los copia a `www/` y cambia las librerías del CDN por copias locales,
para que la app abra sin internet.

## Generar el APK

Se necesita Node 22 o más nuevo (con nvm: `C:\Users\mmartinez4\AppData\Local\nvm\v22.23.4`)
y el SDK de Android (`ANDROID_HOME`, normalmente `%LOCALAPPDATA%\Android\Sdk`).

```powershell
cd mobile
npm install
npm run apk
```

El APK queda en `android/app/build/outputs/apk/debug/app-debug.apk`.

Cada vez que cambies la web, vuelve a correr `npm run apk` para que la app tenga los cambios.

## Notas

- `scripts/build-apk.mjs` pone `ANDROID_HOME` y `-Djdk.net.unixdomain.tmpdir` (sin eso, Java 25 en
  Windows falla con "Unable to establish loopback connection").
- Gradle está en 9.1.0 (en `android/gradle/wrapper/gradle-wrapper.properties`) porque el JDK de
  Android Studio es el 25 y Gradle 8.14 no funciona con él.
- Los enlaces de los correos (confirmar cuenta, cambiar contraseña) abren la web publicada,
  no la app.
- Íconos: `assets/` + `npx @capacitor/assets generate --android`.
