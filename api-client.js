'use strict';

// Cliente para el backend propio (carpeta server/). Imita la parte de supabase-js que usa app.js
// (from(...).select/insert/update/delete/upsert, auth.* y storage.from('avatars')),
// así app.js funciona igual con Supabase o con la API: solo cambia config.js.
(function () {
  const SESSION_KEY = 'videotk.api.session';
  const REFRESH_MARGIN = 60; // segundos antes de que caduque se renueva

  function apiError(status, code, message) {
    const error = new Error(message || code || 'Error');
    error.status = status;
    error.code = code || '';
    return error;
  }

  function createClient(baseUrl) {
    const base = String(baseUrl || '').replace(/\/+$/, '');
    const listeners = new Set();
    let session = readSession();
    let refreshing = null;

    function readSession() {
      try {
        const saved = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
        return saved && saved.access_token && saved.refresh_token && saved.user ? saved : null;
      } catch {
        return null;
      }
    }

    function saveSession(next, event) {
      session = next;
      try {
        if (next) localStorage.setItem(SESSION_KEY, JSON.stringify(next));
        else localStorage.removeItem(SESSION_KEY);
      } catch { /* sin almacenamiento: la sesión dura mientras la página esté abierta */ }
      if (event) emit(event);
    }

    function emit(event) {
      for (const callback of listeners) {
        try { callback(event, session); } catch (error) { console.error(error); }
      }
    }

    // Otra pestaña entró o salió.
    window.addEventListener('storage', (event) => {
      if (event.key !== SESSION_KEY) return;
      const had = session && session.user.id;
      session = readSession();
      emit(session ? (had ? 'TOKEN_REFRESHED' : 'SIGNED_IN') : 'SIGNED_OUT');
    });

    async function request(method, path, { body, auth = true, raw = false, contentType } = {}) {
      const headers = {};
      if (auth) {
        const token = await accessToken();
        if (!token) throw apiError(401, 'no_session', 'No hay sesión.');
        headers.Authorization = `Bearer ${token}`;
      }
      let payload;
      if (raw) { payload = body; headers['Content-Type'] = contentType || 'application/octet-stream'; }
      else if (body !== undefined) { payload = JSON.stringify(body); headers['Content-Type'] = 'application/json'; }
      // Un fallo de red sale como TypeError: app.js lo trata como "revisa tu conexión".
      const response = await fetch(`${base}/api${path}`, { method, headers, body: payload });
      if (response.status === 204) return null;
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        if (response.status === 401 && auth) saveSession(null, 'SIGNED_OUT');
        throw apiError(response.status, data && data.code, data && data.message);
      }
      return data;
    }

    // Token vigente, renovándolo si está por caducar. Sin conexión se usa el que haya.
    async function accessToken() {
      if (!session) return null;
      if (session.expires_at - REFRESH_MARGIN > Date.now() / 1000) return session.access_token;
      await refreshSession().catch(() => {});
      return session && session.access_token;
    }

    function refreshSession() {
      if (!session) return Promise.resolve(null);
      refreshing ||= (async () => {
        try {
          const next = await request('POST', '/auth/token/refresh', { body: { refresh_token: session.refresh_token }, auth: false });
          saveSession(next, 'TOKEN_REFRESHED');
          return next;
        } catch (error) {
          // 4xx: la sesión ya no vale (cerrada en otro lado o caducada). Sin red se conserva.
          if (error.status >= 400 && error.status < 500) saveSession(null, 'SIGNED_OUT');
          throw error;
        } finally {
          refreshing = null;
        }
      })();
      return refreshing;
    }

    const wrap = (promise) => promise.then((data) => ({ data, error: null }), (error) => ({ data: null, error }));

    // Lee la sesión que trae el enlace del correo (#access_token=...&type=recovery|signup).
    const hashParams = new URLSearchParams(location.hash.slice(1));
    let linkType = '';
    let linkLoaded = null;
    if (hashParams.get('access_token') && hashParams.get('refresh_token')) {
      linkType = hashParams.get('type') || '';
      history.replaceState(null, '', location.pathname + location.search);
      const linkSession = {
        access_token: hashParams.get('access_token'),
        refresh_token: hashParams.get('refresh_token'),
        expires_at: Number(hashParams.get('expires_at')) || 0,
        expires_in: Number(hashParams.get('expires_in')) || 0,
        token_type: 'bearer',
      };
      linkLoaded = fetch(`${base}/api/auth/user`, { headers: { Authorization: `Bearer ${linkSession.access_token}` } })
        .then((response) => (response.ok ? response.json() : null))
        .then((user) => { if (user) saveSession({ ...linkSession, user }); })
        .catch(() => {});
    }

    const auth = {
      async getSession() {
        if (linkLoaded) { await linkLoaded; linkLoaded = null; }
        if (session && session.expires_at - REFRESH_MARGIN <= Date.now() / 1000) await refreshSession().catch(() => {});
        return { data: { session }, error: null };
      },

      onAuthStateChange(callback) {
        listeners.add(callback);
        // Como Supabase: avisa enseguida del estado inicial (y si se entró con el enlace de recuperar contraseña).
        setTimeout(async () => {
          await auth.getSession();
          callback('INITIAL_SESSION', session);
          if (session && linkType === 'recovery') { linkType = ''; callback('PASSWORD_RECOVERY', session); }
        }, 0);
        return { data: { subscription: { unsubscribe: () => listeners.delete(callback) } } };
      },

      signUp({ email, password, options = {} }) {
        return wrap(request('POST', '/auth/signup', { body: { email, password, redirect_to: options.emailRedirectTo }, auth: false })
          .then((data) => { if (data.session) saveSession(data.session, 'SIGNED_IN'); return data; }));
      },

      signInWithPassword({ email, password }) {
        return wrap(request('POST', '/auth/token', { body: { email, password }, auth: false })
          .then((next) => { saveSession(next, 'SIGNED_IN'); return { session: next, user: next.user }; }));
      },

      signInWithOtp({ email }) {
        return wrap(request('POST', '/auth/otp', { body: { email }, auth: false }));
      },

      verifyOtp({ email, token }) {
        return wrap(request('POST', '/auth/verify', { body: { email, token }, auth: false })
          .then((data) => { saveSession(data.session, 'SIGNED_IN'); return data; }));
      },

      resetPasswordForEmail(email, options = {}) {
        return wrap(request('POST', '/auth/recover', { body: { email, redirect_to: options.redirectTo }, auth: false }));
      },

      updateUser(changes) {
        return wrap(request('PUT', '/auth/user', { body: changes }).then((user) => {
          if (session) saveSession({ ...session, user }, 'USER_UPDATED');
          return { user };
        }));
      },

      async signOut() {
        const token = session && session.refresh_token;
        saveSession(null, 'SIGNED_OUT');
        if (token) await request('POST', '/auth/logout', { body: { refresh_token: token }, auth: false }).catch(() => {});
        return { error: null };
      },
    };

    // from('videos' | 'categories'): construye la consulta y la ejecuta al hacer await.
    function from(table) {
      const query = { action: 'select', filters: {}, values: null, options: {} };
      const builder = {
        select() { if (query.action === 'select') query.action = 'list'; query.returning = true; return builder; },
        order() { return builder; }, // el servidor ya devuelve el orden que usa la app
        single() { query.single = true; return builder; },
        eq(column, value) { query.filters[column] = value; return builder; },
        insert(values) { query.action = 'insert'; query.values = values; return builder; },
        upsert(values, options = {}) { query.action = 'upsert'; query.values = values; query.options = options; return builder; },
        update(values) { query.action = 'update'; query.values = values; return builder; },
        delete() { query.action = 'delete'; return builder; },
        then(resolve, reject) { return wrap(execute()).then(resolve, reject); },
      };

      function idPath() {
        const id = query.filters.id;
        if (!id) throw apiError(400, 'missing_id', 'Falta el id.');
        return `/${table}/${encodeURIComponent(id)}`;
      }

      async function execute() {
        switch (query.action) {
          case 'list':
          case 'select':
            return request('GET', `/${table}`);
          case 'insert': {
            const rows = Array.isArray(query.values) ? query.values : [query.values];
            if (rows.length === 1) {
              const { user_id: _ignored, ...row } = rows[0];
              const saved = await request('POST', `/${table}`, { body: row });
              return query.single ? saved : [saved];
            }
            return request('POST', `/${table}/bulk`, { body: { rows } });
          }
          case 'upsert': {
            if (table !== 'videos' || !query.options.ignoreDuplicates) throw apiError(400, 'unsupported', 'Solo se pueden importar videos.');
            const rows = (Array.isArray(query.values) ? query.values : [query.values]).map(({ user_id: _ignored, ...row }) => row);
            return request('POST', '/videos/bulk', { body: { rows } });
          }
          case 'update':
            return request('PATCH', idPath(), { body: query.values });
          case 'delete':
            return request('DELETE', idPath());
          default:
            throw apiError(400, 'unsupported', 'Operación no soportada.');
        }
      }

      return builder;
    }

    // storage.from('avatars'): una foto por usuario, guardada en la base del servidor.
    const storage = {
      from() {
        return {
          upload: (_path, blob, options = {}) => wrap(request('PUT', '/avatar', { body: blob, raw: true, contentType: options.contentType || blob.type })),
          getPublicUrl: (path) => ({ data: { publicUrl: `${base || location.origin}/api/avatars/${String(path).split('/').map(encodeURIComponent).join('/')}` } }),
          remove: () => wrap(request('DELETE', '/avatar')),
        };
      },
    };

    return { auth, from, storage };
  }

  window.VideoTkApi = { createClient };
}());
