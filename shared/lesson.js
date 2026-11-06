/* Hasna's English Lessons — lesson engine.
 * Every lesson page holds its content as JSON in <script id="lesson-data">.
 * This file turns that JSON into an interactive, sound-supported lesson.
 * Audio: browser text-to-speech (Web Speech API). Speaking check: speech recognition (Chrome/Edge).
 * Section types: warmup, phonics, flashcards, vocab, grammar, reading, choose, fill,
 *                unscramble, word_builder, speaking, writing, wrapup.
 */
(function () {
  'use strict';

  // ---------- helpers ----------
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  function h(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'html') n.innerHTML = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      n.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return n;
  }
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage blocked: ignore */ } }
  };
  const shuffle = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const norm = s => String(s).toLowerCase().replace(/[’']/g, "'").replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const isEmoji = s => /^[\p{Extended_Pictographic}\p{Emoji_Component}‍️\s]+$/u.test(String(s)) && /\p{Extended_Pictographic}/u.test(String(s));

  let L;
  try { L = JSON.parse($('#lesson-data').textContent); }
  catch (e) { document.body.innerHTML = '<p style="padding:30px;font-size:20px">⚠️ This lesson file has a JSON error and cannot open: ' + e.message + '</p>'; return; }
  const G = window.HZ_GROUP || { name: '', students: [], color: '#ff7a59', soft: '#ffe7df' };
  document.documentElement.style.setProperty('--accent', G.color || '#ff7a59');
  document.documentElement.style.setProperty('--accent-soft', G.soft || '#ffe7df');
  document.title = `${L.id} · ${L.title}`;

  let voicesTimedOut = false;

  // ---------- speech (text-to-speech) ----------
  const Speech = {
    ok: 'speechSynthesis' in window,
    voices: [], A: null, B: null,
    slow: store.get('hz.slow', false),
    token: 0,
    load() {
      if (!this.ok) return;
      this.voices = speechSynthesis.getVoices().filter(v => /^en[-_]/i.test(v.lang) || v.lang === 'en');
      const score = v => (/(google|natural|neural|online|samantha|aria|jenny|libby|sonia|ava|emma)/i.test(v.name) ? 10 : 0)
        + (/en[-_](us|gb)/i.test(v.lang) ? 4 : 0) + (/female|woman/i.test(v.name) ? 1 : 0);
      const sorted = this.voices.slice().sort((a, b) => score(b) - score(a));
      const saved = store.get('hz.voice', '');
      this.A = this.voices.find(v => v.name === saved) || sorted[0] || null;
      this.B = sorted.find(v => v !== this.A && /(male|guy|daniel|ryan|david|mark|george|alex|andrew|brian|christopher|eric|uk english male)/i.test(v.name))
        || sorted.find(v => v !== this.A) || this.A;
      renderVoicePicker();
    },
    utter(text, who) {
      const u = new SpeechSynthesisUtterance(text);
      const v = who === 'B' ? this.B : this.A;
      if (v) { u.voice = v; u.lang = v.lang; } else u.lang = 'en-US';
      u.rate = this.slow ? 0.62 : 0.9;
      u.pitch = who === 'B' && this.B === this.A ? 0.75 : 1;
      return u;
    },
    // speak one string; resolves when done (or stopped).
    // With the recorded pack installed (tools/make_audio.py), the Piper MP3 plays first;
    // a phrase without a recording falls back to the browser voice.
    speak(text, who = 'A', btn) {
      const file = packFile(text, who);
      if (file) return playFile(file, btn).then(r => (r === 'error' ? this.tts(text, who, btn) : undefined));
      return this.tts(text, who, btn);
    },
    tts(text, who, btn) {
      return new Promise(res => {
        if (!this.ok || !text) { res(); return; }
        const u = this.utter(text, who);
        if (btn) btn.classList.add('playing');
        const done = () => { if (btn) btn.classList.remove('playing'); res(); };
        u.onend = done; u.onerror = done;
        speechSynthesis.speak(u);
      });
    },
    stop() {
      this.token++; if (this.ok) speechSynthesis.cancel();
      if (current) current.stopNow();
      $$('.playing').forEach(b => b.classList.remove('playing'));
    },
    // say one thing now (interrupting anything else)
    say(text, who, btn) { this.stop(); return this.speak(text, who, btn); },
    // speak a list in order; onEach(i) fires before each line; stops if interrupted
    async seq(lines, onEach) {
      this.stop(); const my = this.token;
      for (let i = 0; i < lines.length; i++) {
        if (my !== this.token) return false;
        const ln = typeof lines[i] === 'string' ? { text: lines[i] } : lines[i];
        onEach && onEach(i);
        await this.speak(ln.text, ln.who);
        if (my !== this.token) return false;
        await new Promise(r => setTimeout(r, 250));
      }
      onEach && onEach(-1);
      return true;
    }
  };
  if (Speech.ok) { Speech.load(); speechSynthesis.onvoiceschanged = () => Speech.load(); }

  // ---------- recorded audio pack (shared/audio, made by tools/make_audio.py) ----------
  let current = null;
  const AUDIO_BASE = '../../shared/audio/';
  const PACK = '__recorded__';  // value of the "Recorded voice" choice in the voice menu
  const usePack = () => !!window.HZ_AUDIO_PACK && store.get('hz.voice', PACK) === PACK;
  // FNV-1a 32-bit of the UTF-8 text; must match fnv1a() in tools/make_audio.py
  function fnv1a(s) {
    let h = 0x811c9dc5;
    for (const b of new TextEncoder().encode(s)) { h ^= b; h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(16).padStart(8, '0');
  }
  function packFile(text, who) {
    if (!usePack() || !text) return null;
    const k = norm(text); if (!k) return null;
    return who === 'B' ? 'b/' + fnv1a('B|' + k) + '.mp3' : 'a/' + fnv1a(k) + '.mp3';
  }
  // resolves 'ended' | 'error' | 'stopped'
  function playFile(src, btn) {
    return new Promise(res => {
      const url = /^(https?:|\.|\/)/.test(src) ? src : AUDIO_BASE + src;
      const a = new Audio();
      current = a;
      if (btn) btn.classList.add('playing');
      const fin = r => { if (a.done) return; a.done = true; if (btn) btn.classList.remove('playing'); if (current === a) current = null; res(r); };
      a.onended = () => fin('ended'); a.onerror = () => fin('error');
      a.stopNow = () => { a.pause(); fin('stopped'); };
      // the published site keeps audio encrypted; HZ_AUDIO_LOAD (shared/lock.js) hands back a playable URL
      (window.HZ_AUDIO_LOAD ? window.HZ_AUDIO_LOAD(url) : Promise.resolve(url)).then(u => {
        if (a.done) return;
        a.src = u;
        a.playbackRate = a.defaultPlaybackRate = Speech.slow ? 0.75 : 1;
        return a.play();
      }).catch(() => fin('error'));
    });
  }
  // plays the item's own recording ("audio": "file.mp3") when it has one, otherwise the pack or the browser voice
  function playItem(text, audio, who, btn) {
    if (audio) { Speech.stop(); playFile(audio, btn); return; }
    Speech.say(text, who, btn);
  }
  function sayBtn(text, opts = {}) {
    const b = h('button', { class: 'say' + (opts.sm ? ' sm' : ''), title: 'Listen', 'aria-label': 'Listen: ' + text, type: 'button' }, '🔊');
    b.addEventListener('click', e => { e.stopPropagation(); playItem(text, opts.audio, opts.who, b); });
    return b;
  }

  // ---------- speech recognition (speaking check) ----------
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  function similarity(heard, target) {
    const t = norm(target).split(' ').filter(Boolean), hw = new Set(norm(heard).split(' '));
    if (!t.length) return 0;
    return t.filter(w => hw.has(w)).length / t.length;
  }
  function micBtn(target, out, starKey) {
    if (!SR) return null;
    const b = h('button', { class: 'say mic', title: 'Say it! (microphone check)', type: 'button' }, '🎤');
    b.addEventListener('click', e => {
      e.stopPropagation(); Speech.stop();
      const r = new SR(); r.lang = 'en-US'; r.interimResults = false; r.maxAlternatives = 4;
      b.classList.add('listening'); if (out) { out.className = 'heard'; out.textContent = 'Listening…'; }
      r.onresult = ev => {
        const alts = Array.from(ev.results[0]).map(a => a.transcript);
        const best = alts.map(a => [a, similarity(a, target)]).sort((x, y) => y[1] - x[1])[0];
        if (!out) return;
        if (best[1] >= 0.7) { out.className = 'heard ok'; out.textContent = '⭐ Great! I heard: “' + best[0] + '”'; star(starKey); }
        else { out.className = 'heard no'; out.textContent = 'Try again 🙂 I heard: “' + best[0] + '”'; }
      };
      r.onerror = ev => { if (out) { out.className = 'heard no'; out.textContent = ev.error === 'not-allowed' ? 'Please allow the microphone.' : 'I could not hear. Try again.'; } };
      r.onend = () => b.classList.remove('listening');
      try { r.start(); } catch (err) { b.classList.remove('listening'); }
    });
    return b;
  }

  // ---------- stars ----------
  const earned = new Set();
  let stars = 0;
  function toast(msg) { const t = h('div', { class: 'toast' }, msg); document.body.append(t); setTimeout(() => t.remove(), 1500); }
  function star(key, n = 1) {
    if (key) { if (earned.has(key)) return; earned.add(key); }
    stars += n; const s = $('#stars'); if (s) s.textContent = '⭐ ' + stars;
    const msgs = ['Great job!', 'Super!', 'Well done!', 'Amazing!', 'Fantastic!', 'You did it!'];
    toast('⭐ ' + msgs[Math.floor(Math.random() * msgs.length)]);
  }

  // ---------- timer per section ----------
  function timerPill(minutes) {
    if (!minutes) return null;
    let left = minutes * 60, t = null;
    const p = h('button', { class: 'pill timer', title: 'Start / pause the timer', type: 'button' });
    const show = () => { const a = Math.abs(left); p.textContent = (left < 0 ? '+' : '⏱ ') + Math.floor(a / 60) + ':' + String(a % 60).padStart(2, '0'); p.classList.toggle('over', left < 0); };
    p.addEventListener('click', () => {
      if (t) { clearInterval(t); t = null; p.classList.remove('running'); return; }
      p.classList.add('running'); t = setInterval(() => { left--; show(); }, 1000);
    });
    show(); return p;
  }

  // ---------- section renderers ----------
  const ICON = { warmup: '👋', phonics: '🔤', flashcards: '❤️', vocab: '🖼️', grammar: '📐', reading: '📖', choose: '👂', fill: '✏️', unscramble: '🧩', word_builder: '🧱', speaking: '🗣️', writing: '✍️', wrapup: '🌟', song: '🎵' };
  const DEFAULT_TITLE = { warmup: 'Warm-up', phonics: 'Sounds', flashcards: 'Sight Words', vocab: 'New Words', grammar: 'Grammar', reading: 'Let’s Read', choose: 'Listen and Choose', fill: 'Fill the Gap', unscramble: 'Make a Sentence', word_builder: 'Build the Word', speaking: 'Let’s Talk', writing: 'Let’s Write', wrapup: 'Goodbye & Homework', song: 'Song & Chant' };

  function lineRow(text, opts = {}) {
    const out = h('div', { class: 'heard' });
    return h('div', { class: opts.cls || 'frame' }, sayBtn(text, { audio: opts.audio }), micBtn(text, out, opts.key), h('span', {}, text), out);
  }

  function wordTile(w, i, sec, opts = {}) {
    const t = h('button', { class: 'tile', type: 'button' },
      w.e ? h('span', { class: 'emo' }, w.e) : null,
      h('span', { class: 'w' }, w.w),
      w.s ? h('span', { class: 's' }, w.s) : null,
      w.ar ? h('span', { class: 'ar' }, w.ar) : null);
    t.addEventListener('click', () => playItem(w.say || w.w, w.audio, 'A', null));
    return t;
  }

  const R = {
    warmup(s) {
      const box = h('div');
      if (s.text) box.append(h('p', { class: 'instr' }, s.text));
      if (s.lines && s.lines.length) {
        const lines = s.lines;
        const ps = lines.map((ln, i) => lineRow(ln, { key: s._k + 'l' + i }));
        const play = h('button', { class: 'btn', type: 'button' }, '▶ Play all');
        play.addEventListener('click', () => Speech.seq(lines, i => ps.forEach((p, j) => p.classList.toggle('reading', j === i))));
        box.append(h('div', { class: 'frames' }, ps), h('p', {}, play));
      }
      if (s.questions) box.append(h('ul', { class: 'prompts' }, s.questions.map(q => h('li', {}, sayBtn(q, { sm: true }), ' ', q))));
      return box;
    },
    song(s) { return R.warmup(s); },

    phonics(s) {
      const box = h('div');
      if (s.focus) {
        const up = s.focus.length === 1 ? s.focus.toUpperCase() : '';
        box.append(h('div', { class: 'letter-hero' },
          h('div', { class: 'letter-big' }, up ? h('span', {}, up, ' ') : null, h('small', {}, s.focus)),
          h('div', {},
            s.sound ? h('div', { class: 'sound' }, 'Sound: ', s.sound) : null,
            s.say_sound ? h('p', {}, sayBtn(s.say_sound), ' ', h('span', { class: 'instr' }, s.say_sound)) : null,
            s.text ? h('p', { class: 'instr' }, s.text) : null)));
      } else if (s.text) box.append(h('p', { class: 'instr' }, s.text));
      if (s.chant) box.append(h('div', { class: 'chant' }, sayBtn(s.chant), h('span', {}, '🎵 ', s.chant)));
      if (s.words) box.append(h('div', { class: 'grid' }, s.words.map((w, i) => wordTile(w, i, s))));
      if (s.blend && s.blend.length) {
        box.append(h('h3', {}, 'Blend it! 👉 sound by sound'));
        box.append(h('div', { class: 'opts' }, s.blend.map(wd => {
          const letters = wd.split('');
          const b = h('button', { class: 'opt', type: 'button' }, letters.join(' · '));
          b.addEventListener('click', async () => { b.textContent = letters.join(' · '); await Speech.seq(letters.map(x => x)); b.textContent = wd; Speech.speak(wd); star(s._k + wd); });
          return b;
        })));
        box.append(h('p', { class: 'instr' }, 'Click a word: hear each letter, then the whole word.'));
      }
      if (s.trace) box.append(h('h3', {}, '✍️ Trace and write: ', s.trace), pad(s.trace));
      return box;
    },

    flashcards(s) {
      const cards = s.cards || [];
      let i = 0;
      const word = h('div', { class: 'word' }), sent = h('div', { class: 'sent' }), fc = h('div', { class: 'fc' }, word, sent);
      const out = h('div', { class: 'heard' });
      const dots = h('div', { class: 'dots' }, cards.map(() => h('i')));
      const speakBtn = h('button', { class: 'say', type: 'button', title: 'Listen' }, '🔊');
      const micHolder = h('span');
      const show = () => {
        const c = cards[i]; word.textContent = c.w; sent.textContent = c.s || ''; fc.classList.remove('show');
        out.textContent = ''; out.className = 'heard';
        $$('i', dots).forEach((d, j) => { d.classList.toggle('on', j === i); });
        micHolder.innerHTML = ''; const m = micBtn(c.w, out, s._k + c.w); if (m) micHolder.append(m);
      };
      speakBtn.addEventListener('click', () => { const c = cards[i]; playItem(c.w, c.audio, 'A', speakBtn); });
      const sentBtn = h('button', { class: 'btn ghost', type: 'button' }, '💬 Sentence');
      sentBtn.addEventListener('click', () => { const c = cards[i]; fc.classList.add('show'); if (c.s) Speech.say(c.s); });
      const prev = h('button', { class: 'btn ghost', type: 'button' }, '◀');
      const next = h('button', { class: 'btn', type: 'button' }, 'Next ▶');
      prev.addEventListener('click', () => { i = (i - 1 + cards.length) % cards.length; show(); });
      next.addEventListener('click', () => { $$('i', dots)[i].classList.add('done'); i = (i + 1) % cards.length; show(); });
      const shuf = h('button', { class: 'btn ghost', type: 'button', title: 'Mix the cards' }, '🔀');
      shuf.addEventListener('click', () => { cards.sort(() => Math.random() - .5); i = 0; show(); });
      if (cards.length) show();
      return h('div', { class: 'flash' },
        s.text ? h('p', { class: 'instr' }, s.text) : null,
        fc, h('div', { class: 'row' }, prev, speakBtn, micHolder, sentBtn, next, shuf), out, dots,
        s.review && s.review.length ? h('p', { class: 'instr' }, '🔁 Review: ', s.review.join(' · ')) : null);
    },

    vocab(s) {
      return h('div', {}, s.text ? h('p', { class: 'instr' }, s.text) : null,
        h('div', { class: 'grid' }, (s.words || []).map((w, i) => wordTile(w, i, s))));
    },

    grammar(s) {
      const box = h('div');
      if (s.rule) box.append(h('div', { class: 'rule' }, s.rule));
      if (s.table) box.append(h('table', { class: 'gt' }, s.table.map(r => h('tr', {}, r.map(c => h('td', {}, c))))));
      if (s.examples) box.append(h('div', {}, s.examples.map((ex, i) => h('div', { class: 'ex' }, sayBtn(ex, { sm: true }), micBtn(ex, null, null), h('span', {}, ex)))));
      if (s.ar) box.append(h('p', { class: 'ar', style: 'display:block' }, s.ar));
      return box;
    },

    reading(s) {
      const sight = new Set((s.highlight || []).map(norm));
      const paras = (s.text || []).map(p => {
        const el = h('p');
        p.split(/(\s+)/).forEach(tok => {
          if (/^\s+$/.test(tok) || !tok) { el.append(tok); return; }
          const clean = tok.replace(/^[^A-Za-z0-9']+|[^A-Za-z0-9']+$/g, '');
          const sp = h('span', { class: 'wd' + (sight.has(norm(clean)) ? ' sight' : '') }, tok);
          sp.addEventListener('click', () => Speech.say(clean));
          el.append(sp);
        });
        return el;
      });
      const story = h('div', { class: 'story' }, paras);
      const lines = (s.text || []).map((t, i) => ({ text: t, who: s.voices ? s.voices[i] : 'A' }));
      const readAll = h('button', { class: 'btn', type: 'button' }, '▶ Read to me');
      readAll.addEventListener('click', () => Speech.seq(lines, i => paras.forEach((p, j) => p.classList.toggle('reading', j === i))));
      const stop = h('button', { class: 'btn ghost', type: 'button' }, '⏹ Stop');
      stop.addEventListener('click', () => { Speech.stop(); paras.forEach(p => p.classList.remove('reading')); });
      const box = h('div', {},
        s.text_intro ? h('p', { class: 'instr' }, s.text_intro) : null,
        h('div', { class: 'story-title' }, s.pic ? h('span', { class: 'story-pic' }, s.pic) : null, h('span', {}, s.story_title || '')),
        story, h('p', {}, readAll, ' ', stop, ' ', h('span', { class: 'instr' }, ' Tip: click any word to hear it.')));
      if (s.questions && s.questions.length) {
        box.append(h('h3', {}, '🤔 Questions'));
        box.append(h('div', { class: 'qs' }, s.questions.map((q, i) => {
          const row = h('div', { class: 'q' }, sayBtn(q.q, { sm: true }), h('span', {}, (i + 1) + '. ' + q.q));
          const show = h('button', { class: 'pill', type: 'button' }, 'Answer');
          show.addEventListener('click', () => { row.classList.toggle('show'); if (row.classList.contains('show')) Speech.say(q.a); });
          row.append(show, h('div', { class: 'ans' }, '✅ ', q.a));
          return row;
        })));
      }
      return box;
    },

    choose(s) {
      let right = 0; const total = (s.items || []).length;
      const score = h('div', { class: 'score' });
      const upd = () => { score.textContent = `Score: ${right} / ${total}`; };
      const items = (s.items || []).map((it, k) => {
        const opts = it.options.map((o, j) => ({ o, j }));
        const shown = it.keep_order ? opts : shuffle(opts);
        let tried = false;
        const prompt = h('div', { class: 'prompt' },
          it.say ? sayBtn(it.say, { audio: it.audio }) : null,
          it.q ? h('span', {}, it.q) : (it.say ? h('span', { class: 'instr' }, 'Listen and choose.') : null));
        const box = h('div', { class: 'opts' }, shown.map(({ o, j }) => {
          const b = h('button', { class: 'opt' + (isEmoji(o) ? ' emoji' : ''), type: 'button' }, o);
          b.addEventListener('click', () => {
            if (j === it.answer) {
              b.classList.add('ok'); if (!tried) { right++; upd(); star(s._k + k); }
              tried = true; $$('.opt', box).forEach(x => x.disabled = true);
              if (it.after) Speech.say(it.after); else if (!isEmoji(o)) Speech.say(String(o));
            } else { b.classList.add('no'); tried = true; setTimeout(() => b.classList.remove('no'), 500); }
          });
          return b;
        }));
        return h('div', { class: 'item' }, prompt, box);
      });
      upd();
      return h('div', {}, s.text ? h('p', { class: 'instr' }, s.text) : null, items, score);
    },

    fill(s) {
      const bank = s.bank ? h('p', { class: 'instr' }, '🏦 Word bank: ', h('b', {}, s.bank.join(' · '))) : null;
      const items = (s.items || []).map((it, k) => {
        const parts = it.text.split('___');
        const blank = h('span', { class: 'blank' }, '?');
        const full = parts.join(it.answer);
        const line = h('div', { class: 'prompt' }, sayBtn(full, { sm: true }), h('span', {}, parts[0], blank, parts.slice(1).join('___')));
        const opts = shuffle(it.options || s.bank || [it.answer]);
        const box = h('div', { class: 'opts' }, opts.map(o => {
          const b = h('button', { class: 'opt', type: 'button' }, o);
          b.addEventListener('click', () => {
            if (norm(o) === norm(it.answer)) { blank.textContent = it.answer; b.classList.add('ok'); star(s._k + k); Speech.say(full); }
            else { b.classList.add('no'); setTimeout(() => b.classList.remove('no'), 500); }
          });
          return b;
        }));
        return h('div', { class: 'item' }, line, box);
      });
      return h('div', {}, s.text ? h('p', { class: 'instr' }, s.text) : null, bank, items);
    },

    unscramble(s) {
      const items = (s.items || []).map((words, k) => {
        const target = words.join(' ');
        const ans = h('div', { class: 'chips answer' });
        const pool = h('div', { class: 'chips' });
        const reset = () => { ans.innerHTML = ''; ans.className = 'chips answer'; $$('.chip', pool).forEach(c => c.classList.remove('used')); };
        shuffle(words.map((w, i) => ({ w, i }))).forEach(({ w }) => {
          const c = h('button', { class: 'chip', type: 'button' }, w);
          c.addEventListener('click', () => {
            if (c.classList.contains('used')) return;
            c.classList.add('used'); Speech.say(w.replace(/[.?!,]/g, ''));
            const placed = h('button', { class: 'chip', type: 'button' }, w);
            placed.addEventListener('click', () => { placed.remove(); c.classList.remove('used'); ans.className = 'chips answer'; });
            ans.append(placed);
            const now = $$('.chip', ans).map(x => x.textContent);
            if (now.length === words.length) {
              const ok = norm(now.join(' ')) === norm(target);
              ans.classList.add(ok ? 'ok' : 'no');
              if (ok) { star(s._k + k); Speech.say(target); } else setTimeout(reset, 900);
            }
          });
          pool.append(c);
        });
        const r = h('button', { class: 'pill', type: 'button' }, '↺');
        r.addEventListener('click', reset);
        return h('div', { class: 'item' }, h('div', { class: 'prompt' }, h('span', { class: 'instr' }, (k + 1) + '.'), r), pool, ans);
      });
      return h('div', {}, h('p', { class: 'instr' }, s.text || 'Click the words in the right order.'), items);
    },

    word_builder(s) {
      const items = (s.items || []).map((it, k) => {
        const target = it.word.toLowerCase();
        const ans = h('div', { class: 'chips answer' });
        const pool = h('div', { class: 'chips' });
        // letters may be a list ["c","a","t","p"] or a string "catp"
        const letters = it.letters && it.letters.length ? Array.from(it.letters) : target.split('');
        shuffle(letters).forEach(l => {
          const c = h('button', { class: 'chip letter', type: 'button' }, l);
          c.addEventListener('click', () => {
            if (c.classList.contains('used')) return;
            c.classList.add('used');
            const p = h('button', { class: 'chip letter', type: 'button' }, l);
            p.addEventListener('click', () => { p.remove(); c.classList.remove('used'); ans.className = 'chips answer'; });
            ans.append(p);
            const now = $$('.chip', ans).map(x => x.textContent).join('');
            if (now.length >= target.length) {
              if (now === target) { ans.classList.add('ok'); star(s._k + k); Speech.say(it.word); }
              else { ans.classList.add('no'); setTimeout(() => { ans.innerHTML = ''; ans.className = 'chips answer'; $$('.chip', pool).forEach(x => x.classList.remove('used')); }, 900); }
            }
          });
          pool.append(c);
        });
        return h('div', { class: 'item' },
          h('div', { class: 'prompt' }, it.e ? h('span', { style: 'font-size:54px' }, it.e) : null, sayBtn(it.word), h('span', { class: 'instr' }, '_ '.repeat(target.length))),
          pool, ans);
      });
      return h('div', {}, h('p', { class: 'instr' }, s.text || 'Listen. Click the letters to build the word.'), items);
    },

    speaking(s) {
      const box = h('div');
      if (s.text) box.append(h('p', { class: 'instr' }, s.text));
      if (s.dialogue && s.dialogue.length) {
        const bubbles = s.dialogue.map((d, i) => {
          const b = h('div', { class: 'bubble ' + (d.who === 'B' ? 'B' : 'A') },
            h('span', { class: 'who' }, d.name || d.who), sayBtn(d.line, { who: d.who, sm: true, audio: d.audio }), h('span', { class: 'txt' }, d.line));
          return b;
        });
        const lines = s.dialogue.map(d => ({ text: d.line, who: d.who === 'B' ? 'B' : 'A' }));
        const play = h('button', { class: 'btn', type: 'button' }, '▶ Play conversation');
        play.addEventListener('click', () => Speech.seq(lines, i => bubbles.forEach((b, j) => b.classList.toggle('speaking', j === i))));
        const roleA = h('button', { class: 'btn ghost', type: 'button' }, '🙈 Hide A'), roleB = h('button', { class: 'btn ghost', type: 'button' }, '🙈 Hide B');
        roleA.addEventListener('click', () => bubbles.forEach(b => b.classList.contains('A') && b.classList.toggle('hidden')));
        roleB.addEventListener('click', () => bubbles.forEach(b => b.classList.contains('B') && b.classList.toggle('hidden')));
        box.append(h('div', { class: 'dialogue' }, bubbles), h('p', {}, play, ' ', roleA, ' ', roleB));
      }
      if (s.frames && s.frames.length) {
        box.append(h('h3', {}, '🧱 Sentence helpers'));
        box.append(h('div', { class: 'frames' }, s.frames.map((f, i) => lineRow(f, { key: s._k + 'f' + i }))));
      }
      if (s.prompts && s.prompts.length) {
        box.append(h('h3', {}, '💬 Your turn'));
        box.append(h('ul', { class: 'prompts' }, s.prompts.map(p => h('li', {}, sayBtn(p, { sm: true }), ' ', p))));
      }
      return box;
    },

    writing(s) {
      const box = h('div');
      if (s.text) box.append(h('p', { class: 'instr' }, s.text));
      if (s.model) box.append(h('div', { class: 'model' }, h('span', { class: 'lbl' }, 'Example'), sayBtn(s.model, { sm: true }), ' ', s.model));
      if (s.frames && s.frames.length) box.append(h('div', { class: 'frames' }, s.frames.map(f => h('div', { class: 'frame' }, '✏️ ', f))));
      if (s.task) box.append(h('p', { style: 'font-size:24px;font-weight:700' }, '📝 ', s.task));
      if (s.checklist) box.append(h('ul', { class: 'checklist' }, s.checklist.map(c => h('li', {}, h('label', {}, h('input', { type: 'checkbox' }), c)))));
      if (s.pad) box.append(pad(typeof s.pad === 'string' ? s.pad : ''));
      if (s.typing !== false) {
        const key = 'hz.write.' + L.id + '.' + s._k;
        const ta = h('textarea', { class: 'write', placeholder: 'Type here…', spellcheck: 'false' });
        ta.value = store.get(key, '');
        ta.addEventListener('input', () => store.set(key, ta.value));
        const read = h('button', { class: 'pill', type: 'button' }, '🔊 Read my writing');
        read.addEventListener('click', () => Speech.say(ta.value || 'Nothing written yet.'));
        box.append(ta, h('p', {}, read));
      }
      return box;
    },

    wrapup(s) {
      const box = h('div', {}, h('div', { class: 'trophy' }, '🏆'));
      const tot = h('p', { style: 'text-align:center;font-size:28px;font-weight:800' });
      const refresh = () => { tot.textContent = 'Today you earned ⭐ ' + stars + ' stars!'; };
      refresh(); box.addEventListener('mouseenter', refresh);
      box.append(tot);
      if (s.exit && s.exit.length) {
        box.append(h('h3', {}, '🚪 Exit ticket — can you…'));
        box.append(h('ul', { class: 'checklist' }, s.exit.map(e => h('li', {}, h('label', {}, h('input', { type: 'checkbox' }), e)))));
      }
      if (s.homework && s.homework.length) {
        box.append(h('h3', {}, '🏠 Homework'));
        box.append(h('div', { class: 'hw' }, h('ul', {}, s.homework.map(x => h('li', {}, x)))));
      }
      if (s.goodbye) box.append(h('div', { class: 'chant' }, sayBtn(s.goodbye), h('span', {}, s.goodbye)));
      return box;
    }
  };

  // ---------- drawing pad (letter tracing / picture writing) ----------
  function pad(guide) {
    const c = h('canvas'); const wrap = h('div', { class: 'pad-wrap' }, c);
    let ctx, drawing = false, color = '#2b2a33';
    const fit = () => {
      const r = c.getBoundingClientRect(); if (!r.width) return;
      c.width = r.width * devicePixelRatio; c.height = r.height * devicePixelRatio;
      ctx = c.getContext('2d'); ctx.scale(devicePixelRatio, devicePixelRatio);
      paintGuide(r);
    };
    const paintGuide = r => {
      ctx.clearRect(0, 0, r.width, r.height);
      ctx.strokeStyle = '#dfe8f5'; ctx.lineWidth = 2;
      [0.25, 0.5, 0.75].forEach((y, i) => { ctx.setLineDash(i === 1 ? [8, 8] : []); ctx.beginPath(); ctx.moveTo(0, r.height * y); ctx.lineTo(r.width, r.height * y); ctx.stroke(); });
      ctx.setLineDash([]);
      if (guide) { ctx.fillStyle = 'rgba(0,0,0,.09)'; ctx.font = `${r.height * 0.5}px Andika, "Comic Neue", sans-serif`; ctx.textBaseline = 'alphabetic'; ctx.fillText(guide, 20, r.height * 0.75); }
    };
    const pos = e => { const r = c.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    c.addEventListener('pointerdown', e => { if (!ctx) fit(); drawing = true; c.setPointerCapture(e.pointerId); const [x, y] = pos(e); ctx.beginPath(); ctx.moveTo(x, y); });
    c.addEventListener('pointermove', e => { if (!drawing) return; const [x, y] = pos(e); ctx.strokeStyle = color; ctx.lineWidth = 6; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.lineTo(x, y); ctx.stroke(); });
    c.addEventListener('pointerup', () => { drawing = false; });
    const clear = h('button', { class: 'pill', type: 'button' }, '🧽 Clear');
    clear.addEventListener('click', () => fit());
    const colors = ['#2b2a33', '#e2463b', '#2f7de1', '#2fa36b'].map(col => {
      const b = h('button', { class: 'pill', type: 'button', style: `background:${col};width:36px;height:36px;padding:0` });
      b.addEventListener('click', () => { color = col; }); return b;
    });
    new ResizeObserver(() => { if (c.getBoundingClientRect().width && (!ctx || c.width === 0)) fit(); }).observe(c);
    return h('div', {}, wrap, h('div', { class: 'pad-tools' }, clear, colors));
  }

  // ---------- page ----------
  const sections = (L.sections || []).map((s, i) => Object.assign({ _k: 's' + i }, s));
  const groupHome = '../index.html';
  const app = $('#app');
  let mode = store.get('hz.mode', 'slides');

  function renderVoicePicker() {
    const sel = $('#voice'); if (!sel) return;
    sel.innerHTML = '';
    if (window.HZ_AUDIO_PACK) sel.append(h('option', { value: PACK, selected: usePack() }, '🎙️ Recorded voice'));
    if (!Speech.voices.length) {
      if (!window.HZ_AUDIO_PACK) sel.append(h('option', {}, !Speech.ok ? 'No speech in this browser' : voicesTimedOut ? 'No voices — use Chrome' : 'Loading voices…'));
      return;
    }
    Speech.voices.forEach(v => sel.append(h('option', { value: v.name, selected: !usePack() && Speech.A && v.name === Speech.A.name }, v.name.replace(/Microsoft |Google /, '') + ' (' + v.lang + ')')));
  }

  const nav = L.nav || {};
  const top = h('div', { class: 'topbar' },
    h('div', { class: 'crumbs' },
      h('a', { href: '../../index.html' }, '🏠 Home'), ' ',
      h('a', { href: groupHome }, G.name || 'Group'), ' ',
      nav.prev ? h('a', { href: nav.prev, title: 'Previous lesson' }, '◀ Prev') : null, ' ',
      nav.next ? h('a', { href: nav.next, title: 'Next lesson' }, 'Next ▶') : null),
    h('span', { class: 'spacer' }),
    h('span', { class: 'pill stars', id: 'stars' }, '⭐ 0'),
    h('select', { class: 'pill', id: 'voice', title: 'Voice' }),
    h('button', { class: 'pill' + (Speech.slow ? ' on' : ''), id: 'slow', type: 'button', title: 'Slow speech' }, '🐢 Slow'),
    h('button', { class: 'pill', id: 'arabic', type: 'button', title: 'Show Arabic hints (A)' }, 'ع Arabic'),
    h('button', { class: 'pill', id: 'mode', type: 'button', title: 'Slides or one long page (S)' }, mode === 'slides' ? '📜 Scroll' : '🖼️ Slides'),
    h('button', { class: 'pill', id: 'teacher', type: 'button', title: 'Teacher notes (T)' }, '👩‍🏫 Teacher'));

  const names = G.students || [];
  const hero = h('section', { class: 'card hero', 'data-icon': '🎒' },
    h('div', { class: 'big-emoji' }, L.emoji || '🎒'),
    h('div', { class: 'sub' }, [G.name, L.unit, 'Lesson ' + L.lesson].filter(Boolean).join(' · ')),
    h('h1', {}, L.title),
    names.length ? h('div', { class: 'names' }, names.map(n => h('span', {}, '👋 ' + n))) : null,
    (L.kid_goals && L.kid_goals.length) ? h('div', { class: 'today' }, h('b', {}, 'Today we will:'), h('ul', {}, L.kid_goals.map(g => h('li', {}, g)))) : null,
    !Speech.ok && !window.HZ_AUDIO_PACK ? h('p', { class: 'notice show' }, 'This browser has no speech. Please open the lesson in Google Chrome or Microsoft Edge to hear the sounds.') : null);

  const cards = [hero].concat(sections.map((s, i) => {
    const fn = R[s.type];
    const head = h('div', { class: 'card-head' },
      h('span', { class: 'icon' }, s.icon || ICON[s.type] || '⭐'),
      h('div', {}, h('div', { class: 'kicker' }, 'Step ' + (i + 1) + ' of ' + sections.length), h('h2', {}, s.title || DEFAULT_TITLE[s.type] || s.type)),
      h('span', { class: 'spacer' }),
      (s.skills || []).map(k => h('span', { class: 'skill' }, k)),
      timerPill(s.minutes));
    let body;
    try { body = fn ? fn(s) : h('p', {}, 'Unknown section type: ' + s.type); }
    catch (err) { body = h('p', { class: 'notice show' }, '⚠️ This step has a content error: ' + err.message); console.error(err, s); }
    return h('section', { class: 'card', 'data-icon': s.icon || ICON[s.type] || '⭐' }, head, s.tip ? h('div', { class: 'tip' }, s.tip) : null, body);
  }));

  const main = h('main', { class: 'wrap ' + (mode === 'slides' ? 'slides' : '') }, cards);
  let cur = 0;
  const steps = h('div', { class: 'steps' }, cards.map((c, i) => {
    const b = h('button', { type: 'button', title: i ? (sections[i - 1].title || DEFAULT_TITLE[sections[i - 1].type]) : 'Start' }, c.dataset.icon);
    b.addEventListener('click', () => go(i)); return b;
  }));
  const prevB = h('button', { class: 'btn ghost', type: 'button' }, '◀ Back');
  const nextB = h('button', { class: 'btn', type: 'button' }, 'Next ▶');
  prevB.addEventListener('click', () => go(cur - 1));
  nextB.addEventListener('click', () => go(cur + 1));
  const bottom = h('nav', { class: 'nav' }, prevB, steps, nextB);

  function go(i) {
    cur = Math.max(0, Math.min(cards.length - 1, i));
    Speech.stop();
    cards.forEach((c, j) => c.classList.toggle('active', j === cur));
    $$('button', steps).forEach((b, j) => { b.classList.toggle('cur', j === cur); if (j < cur) b.classList.add('seen'); });
    nextB.textContent = cur === cards.length - 1 ? '🎉 Done' : 'Next ▶';
    if (mode === 'slides') window.scrollTo({ top: 0 });
    else cards[cur].scrollIntoView({ behavior: 'smooth' });
  }

  // ---------- teacher drawer ----------
  const doneKey = 'hz.done.' + L.id;
  const done = store.get(doneKey, null);
  const doneBox = h('div', { class: 'donebox' });
  const paintDone = () => {
    const d = store.get(doneKey, null);
    doneBox.innerHTML = '';
    doneBox.append(d ? h('div', {}, '✅ Marked as taught on ', h('b', {}, d), ' ') : h('div', {}, 'Not marked as taught yet. '));
    const b = h('button', { class: 'pill', type: 'button' }, d ? 'Undo' : '✅ Mark as taught today');
    b.addEventListener('click', () => { store.set(doneKey, d ? null : new Date().toISOString().slice(0, 10)); paintDone(); });
    doneBox.append(b, h('div', { style: 'font-size:13px;color:var(--muted);margin-top:6px' }, 'Also set Status = Done in the Google Sheet tracker.'));
  };
  paintDone();
  const totalMin = sections.reduce((a, s) => a + (s.minutes || 0), 0);
  const gloss = [];
  sections.forEach(s => (s.words || []).forEach(w => w.ar && gloss.push([w.w, w.ar])));
  (L.arabic || []).forEach(a => gloss.push([a.en, a.ar]));
  const drawer = h('aside', { class: 'drawer', id: 'drawer' },
    h('button', { class: 'pill close', type: 'button', onclick: () => drawer.classList.remove('open') }, '✕'),
    h('h2', { style: 'margin-top:0' }, '👩‍🏫 Teacher notes'),
    h('div', {}, h('b', {}, L.id), ' · ', L.minutes || 45, ' min · planned ', totalMin, ' min'),
    L.week ? h('div', {}, 'Week ', L.week, ' · Month ', L.month || '') : null,
    h('h3', {}, '🎯 Objectives (CEFR / can-do)'), h('ul', {}, (L.objectives || []).map(o => h('li', {}, o))),
    L.focus ? h('div', {}, h('h3', {}, '🔎 Focus'), h('table', {}, Object.entries(L.focus).map(([k, v]) => h('tr', {}, h('td', {}, h('b', {}, k)), h('td', {}, Array.isArray(v) ? v.join(', ') : v))))) : null,
    h('h3', {}, '⏱ Plan'), h('table', {}, sections.map((s, i) => h('tr', {}, h('td', {}, (s.icon || ICON[s.type]) + ' ' + (s.title || DEFAULT_TITLE[s.type])), h('td', {}, (s.minutes || '–') + ' min')))),
    (L.frameworks && L.frameworks.length) ? h('div', {}, h('h3', {}, '🧭 Teaching approach'), h('ul', {}, L.frameworks.map(f => h('li', {}, f)))) : null,
    (L.sources && L.sources.length) ? h('div', {}, h('h3', {}, '📚 Book links'), h('ul', {}, L.sources.map(f => h('li', {}, f)))) : null,
    L.teacher_notes ? h('div', {}, h('h3', {}, '📝 Notes'), h('p', {}, L.teacher_notes)) : null,
    L.differentiation ? h('div', {}, h('h3', {}, '🪜 Differentiation'), h('p', {}, L.differentiation)) : null,
    gloss.length ? h('div', {}, h('h3', {}, 'ع Arabic glossary'), h('table', { class: 'gloss' }, gloss.map(([e, a]) => h('tr', {}, h('td', {}, e), h('td', {}, a))))) : null,
    doneBox,
    h('p', { style: 'font-size:13px;color:var(--muted)' }, 'Keys: ← → move · T teacher · A Arabic · S slides/scroll · Space stop sound'));

  app.append(top, main, bottom, drawer);
  document.body.classList.toggle('scroll', mode !== 'slides');
  renderVoicePicker();
  // no English voice after a few seconds and no recorded pack -> tell the teacher how to get sound
  setTimeout(() => {
    voicesTimedOut = true;
    if (Speech.voices.length || window.HZ_AUDIO_PACK) return;
    renderVoicePicker();
    hero.append(h('p', { class: 'notice show' }, '🔇 No English voice found in this browser. Open the lesson in Google Chrome or Microsoft Edge to hear the sounds (on Linux, Google Chrome works best).'));
  }, 3000);
  go(0);

  $('#voice').addEventListener('change', e => { store.set('hz.voice', e.target.value); Speech.load(); Speech.say('Hello! This is my voice.'); });
  $('#slow').addEventListener('click', e => { Speech.slow = !Speech.slow; store.set('hz.slow', Speech.slow); e.currentTarget.classList.toggle('on', Speech.slow); });
  const toggleArabic = () => { document.body.classList.toggle('arabic'); $('#arabic').classList.toggle('on', document.body.classList.contains('arabic')); };
  const toggleTeacher = () => { drawer.classList.toggle('open'); document.body.classList.toggle('teacher', drawer.classList.contains('open')); $('#teacher').classList.toggle('on', drawer.classList.contains('open')); };
  const toggleMode = () => {
    mode = mode === 'slides' ? 'scroll' : 'slides'; store.set('hz.mode', mode);
    main.classList.toggle('slides', mode === 'slides'); document.body.classList.toggle('scroll', mode !== 'slides');
    $('#mode').textContent = mode === 'slides' ? '📜 Scroll' : '🖼️ Slides'; go(cur);
  };
  $('#arabic').addEventListener('click', toggleArabic);
  $('#teacher').addEventListener('click', toggleTeacher);
  $('#mode').addEventListener('click', toggleMode);
  document.addEventListener('keydown', e => {
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    if (e.key === 'ArrowRight' || e.key === 'PageDown') { e.preventDefault(); go(cur + 1); }
    else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); go(cur - 1); }
    else if (e.key === 't' || e.key === 'T') toggleTeacher();
    else if (e.key === 'a' || e.key === 'A') toggleArabic();
    else if (e.key === 's' || e.key === 'S') toggleMode();
    else if (e.key === ' ' && e.target === document.body) { e.preventDefault(); Speech.stop(); }
  });
})();
