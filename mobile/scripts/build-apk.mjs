// Compila el APK de prueba (debug) con las variables que necesita este PC:
// - ANDROID_HOME: el SDK de Android Studio.
// - jdk.net.unixdomain.tmpdir: sin esto, Java 25 en Windows falla con "Unable to establish loopback connection".
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const android = join(dirname(fileURLToPath(import.meta.url)), '..', 'android');
const tmp = join(homedir(), '.gradle', 'udstmp');
mkdirSync(tmp, { recursive: true });

const env = { ...process.env };
env.ANDROID_HOME ||= join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk');
env.JAVA_TOOL_OPTIONS = `${env.JAVA_TOOL_OPTIONS || ''} -Djdk.net.unixdomain.tmpdir=${tmp}`.trim();

const isWin = process.platform === 'win32';
const result = spawnSync(isWin ? '.\\gradlew.bat' : './gradlew', ['assembleDebug'], { cwd: android, env, stdio: 'inherit', shell: isWin });
if (result.status === 0) console.log('\nAPK listo: android/app/build/outputs/apk/debug/app-debug.apk');
process.exit(result.status ?? 1);
