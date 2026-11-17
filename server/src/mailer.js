// Envío de correos (código de acceso, recuperar contraseña, confirmar cuenta).
// Sin SMTP configurado, los correos se escriben en la consola: sirve para probar en tu PC.
import { config } from './config.js';

let transport;

async function getTransport() {
  if (transport) return transport;
  const { default: nodemailer } = await import('nodemailer');
  transport = nodemailer.createTransport({
    host: config.mail.host,
    port: config.mail.port,
    secure: config.mail.secure,
    auth: config.mail.user ? { user: config.mail.user, pass: config.mail.pass } : undefined,
  });
  return transport;
}

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

function layout(title, body) {
  return `<!doctype html><html lang="es"><body style="margin:0;background:#14151a;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#e8e8ef">
<div style="max-width:440px;margin:0 auto;padding:32px 24px">
<h1 style="font-size:20px;margin:0 0 16px">${escapeHtml(title)}</h1>${body}
<p style="color:#8a8b99;font-size:12px;margin-top:32px">Si no pediste esto, ignora este correo.</p>
</div></body></html>`;
}

const button = (href, label) => `<p style="margin:24px 0"><a href="${escapeHtml(href)}" style="background:#7c5cff;color:#fff;text-decoration:none;padding:12px 20px;border-radius:10px;display:inline-block;font-weight:600">${escapeHtml(label)}</a></p>`;

async function send(to, subject, html, text) {
  if (!config.mail.ready) {
    console.log(`\n[correo] (sin SMTP: no se envía, se muestra aquí)\n  Para: ${to}\n  Asunto: ${subject}\n  ${text}\n`);
    return;
  }
  const mailer = await getTransport();
  await mailer.sendMail({ from: config.mail.from, to, subject, html, text });
}

export function sendOtpMail(to, code) {
  return send(to, `Tu código de VideoTk: ${code}`,
    layout('Tu código para entrar', `<p>Escríbelo en la app:</p><p style="font-size:32px;letter-spacing:8px;font-weight:700;margin:16px 0">${escapeHtml(code)}</p><p style="color:#8a8b99">Caduca en ${config.otpTtl / 60} minutos.</p>`),
    `Tu código para entrar a VideoTk: ${code} (caduca en ${config.otpTtl / 60} minutos).`);
}

export function sendRecoveryMail(to, link) {
  return send(to, 'Restablece tu contraseña de VideoTk',
    layout('Restablece tu contraseña', `<p>Toca el botón para elegir una contraseña nueva.</p>${button(link, 'Crear contraseña nueva')}<p style="color:#8a8b99">El enlace caduca en ${config.linkTtl / 60} minutos y solo sirve una vez.</p>`),
    `Abre este enlace para elegir una contraseña nueva: ${link}`);
}

export function sendConfirmMail(to, link) {
  return send(to, 'Confirma tu cuenta de VideoTk',
    layout('Confirma tu correo', `<p>Toca el botón para activar tu cuenta.</p>${button(link, 'Confirmar mi cuenta')}`),
    `Abre este enlace para confirmar tu cuenta: ${link}`);
}
