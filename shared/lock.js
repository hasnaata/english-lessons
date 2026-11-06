// Password lock for the published lesson site. Template: tools/publish.py fills in SALT/ITER and copies it to
// site/shared/lock.js. Every page and every recorded clip on the site is AES-GCM encrypted with a key made from
// the password (PBKDF2-SHA-256); the key is remembered in this browser so the password is asked only once.
(function () {
  const SALT = '71882652e5babdf6d4c82cfd3ae7fb5f', ITER = 300000, STORE = 'hz.lock';
  const b64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const hex = s => new Uint8Array(s.match(/../g).map(x => parseInt(x, 16)));
  const savedKey = () => {
    try { const v = JSON.parse(localStorage.getItem(STORE)); if (v && v.s === SALT) return v.k; } catch (e) { /* no storage */ }
    return null;
  };
  const importKey = raw => crypto.subtle.importKey('raw', b64(raw), 'AES-GCM', false, ['decrypt']);
  const decrypt = (key, buf) => { const u = new Uint8Array(buf); return crypto.subtle.decrypt({ name: 'AES-GCM', iv: u.slice(0, 12) }, key, u.slice(12)); };
  async function derive(pw) {
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: hex(SALT), iterations: ITER }, base, 256);
    return btoa(String.fromCharCode(...new Uint8Array(bits)));
  }

  // recorded audio: the lesson engine asks for a playable URL (see playFile in lesson.js)
  let keyP = null;
  const key = () => keyP || (keyP = savedKey() ? importKey(savedKey()) : Promise.reject(new Error('locked')));
  const clips = new Map();
  window.HZ_AUDIO_LOAD = src => {
    if (!clips.has(src)) {
      const p = key().then(k => fetch(src).then(r => { if (!r.ok) throw new Error(r.status); return r.arrayBuffer(); })
        .then(b => decrypt(k, b)))
        .then(plain => URL.createObjectURL(new Blob([plain], { type: 'audio/mpeg' })));
      p.catch(() => clips.delete(src));
      clips.set(src, p);
    }
    return clips.get(src);
  };

  // locked page: decrypt and show it
  const payload = document.getElementById('hz-payload');
  if (!payload) return;
  const form = document.getElementById('hz-form'), input = document.getElementById('hz-pw'), msg = document.getElementById('hz-msg');
  if (!window.crypto || !crypto.subtle) { msg.textContent = 'Please open this page from its https:// web address.'; form.hidden = false; return; }
  const open = async k => new TextDecoder().decode(await decrypt(k, b64(payload.textContent.trim())));
  // swap in the decrypted page; parsed scripts don't run, so re-create them one by one, in order
  const show = async html => {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    document.title = doc.title;
    document.head.replaceWith(document.adoptNode(doc.head));
    document.body.replaceWith(document.adoptNode(doc.body));
    for (const old of [...document.querySelectorAll('script')]) {
      if (old.type && old.type !== 'text/javascript') continue; // JSON lesson data stays as it is
      const s = document.createElement('script');
      const loaded = old.src ? new Promise(r => { s.onload = s.onerror = r; }) : null;
      if (old.src) s.src = old.getAttribute('src'); else s.textContent = old.textContent;
      old.replaceWith(s);
      if (loaded) await loaded;
    }
  };
  const saved = savedKey();
  if (saved) importKey(saved).then(open).then(show).catch(() => { try { localStorage.removeItem(STORE); } catch (e) { /* ignore */ } form.hidden = false; input.focus(); });
  else { form.hidden = false; input.focus(); }
  form.addEventListener('submit', async e => {
    e.preventDefault();
    msg.textContent = '⏳';
    try {
      const raw = await derive(input.value.trim());
      const html = await open(await importKey(raw));
      try { localStorage.setItem(STORE, JSON.stringify({ s: SALT, k: raw })); } catch (err) { /* private window */ }
      show(html);
    } catch (err) {
      msg.textContent = '❌ Wrong password. Try again.';
      input.select();
    }
  });
})();
