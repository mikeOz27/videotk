// ¿Dónde guarda la app las cuentas y los videos?
//   backend: 'supabase' → en tu proyecto de Supabase (datos de abajo).
//   backend: 'api'      → en tu propio servidor (carpeta server/). Pon su dirección en apiUrl,
//                         p. ej. 'https://videotk-api.onrender.com'. Vacío = el mismo sitio que la web
//                         (cuando el servidor también entrega la web, este archivo lo genera él).
// siteUrl (opcional): página a la que vuelven los enlaces de los correos. Por defecto, esta misma web.
//
// La clave "publishable" (o "anon") de Supabase es pública por diseño: lo que protege tus
// datos son las reglas de supabase.sql, no esta clave. NUNCA pongas aquí la
// clave "secret" ni la "service_role".
window.VIDEOTECA_CONFIG = {
  backend: 'supabase',
  apiUrl: '',
  supabaseUrl: 'https://wynvxfdluhwfrrkvaohe.supabase.co',
  supabaseKey: 'sb_publishable_Cd0ySHR6dExiGT6G_x2UMw_etx9ZtDg',
};
