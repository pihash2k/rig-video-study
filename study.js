/* 360-degree video study for the Rig Attention paper.
   Flow: consent -> instructions -> one page per scene (all results of one scene, rated 1-5 on each question)
   -> submit -> thank you. Plain browser JavaScript, no build step. Answers are posted to STUDY_CONFIG.endpoint
   (a Google Apps Script web app) or, when it is empty, to the local test server (serve_local.py).
   Each scene is sent in the background when the participant presses Next, and everything is sent again on
   Submit; the server keeps the first copy of each (participant, scene).
   URL options: ?block=N forces block N for a new participant, ?reset=1 starts over as a new participant,
   ?pilot=1 marks the answers as pilot answers (they do not count towards block balancing). */
(function () {
  'use strict';

  const CONFIG = Object.assign({ endpoint: '' }, window.STUDY_CONFIG || {});
  const STORE = 'rig_study_v4';
  // Must match COLUMNS in apps_script.gs and serve_local.py.
  const COLUMNS = ['received', 'participant', 'block', 'pilot', 'scene', 'page', 'position', 'video', 'question',
    'score', 'scene_seconds', 'total_seconds', 'viewport', 'version', 'started', 'finished'];
  const QUESTIONS = [
    { key: 'quality', label: 'Quality per view', text: 'Look at each of the six views on its own: every view is sharp and realistic, without artefacts or distortions. How the views connect is rated separately.' },
    { key: 'consistency', label: 'Cross-view consistency', text: 'Look at each pair of neighbouring views, including where the two ends of the strip meet: they connect correctly and together show one correct scene, with no jumps, mismatches or duplicated content between them.' },
    { key: 'scene', label: 'Complete scene', text: 'All six views form one coherent place, as if filmed from one spot, and each direction shows something different: various objects, people and movements, not the same view repeated.' },
  ];
  const RATES = [1, 0.5, 0.25];
  const LETTERS = 'ABCDEFGHIJKLMNOP';
  const SECONDS_PER_RATING = 3.5;
  const params = new URLSearchParams(location.search);
  // ?pilot, ?pilot=1 and ?pilot=true all switch an option on; ?pilot=0 does not.
  const flag = name => params.has(name) && !['0', 'false', 'no'].includes(params.get(name).toLowerCase());
  const app = document.getElementById('app');
  let manifest = null;
  let state = null;
  let player = null;
  let modalPlayer = null;

  // ------------------------------------------------------------------ small helpers

  function el(tag, attrs, ...kids) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? '' : String(v));
    }
    for (const kid of kids.flat()) {
      if (kid === null || kid === undefined || kid === false) continue;
      node.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return node;
  }

  function randInt(n) {
    const a = new Uint32Array(1);
    crypto.getRandomValues(a);
    return a[0] % n;
  }

  function shuffled(xs) {
    const a = xs.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = randInt(i + 1);
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function newId() {
    const a = new Uint8Array(6);
    crypto.getRandomValues(a);
    return 'p' + Array.from(a, b => b.toString(16).padStart(2, '0')).join('');
  }

  function save() {
    try { localStorage.setItem(STORE, JSON.stringify(state)); } catch (e) { /* private mode: keep it in memory */ }
  }

  function restore() {
    try { return JSON.parse(localStorage.getItem(STORE)); } catch (e) { return null; }
  }

  async function getJson(url, options, ms) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try {
      const res = await fetch(url, Object.assign({ signal: ctrl.signal }, options));
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  const submitUrl = () => CONFIG.endpoint || 'api/submit';
  const countsUrl = () => (CONFIG.endpoint
    ? CONFIG.endpoint + (CONFIG.endpoint.includes('?') ? '&' : '?') + 'action=counts'
    : 'api/counts');
  const videoUrl = (id, size) => `videos/${id}_${size}.mp4`;
  const sceneId = () => state.scenes[state.index];
  const page = () => state.pages[sceneId()];

  function minutes() {
    const sid = state.scenes[0];
    const perPage = manifest.scenes[sid].results.length * QUESTIONS.length;
    return Math.max(5, Math.round((state.scenes.length * perPage * SECONDS_PER_RATING) / 60 / 5) * 5);
  }

  // ------------------------------------------------------------------ participant state

  async function pickBlock() {
    const n = manifest.blocks.length;
    const forced = parseInt(params.get('block'), 10);
    if (forced >= 1 && forced <= n) return forced;
    let counts = {};
    try {
      counts = (await getJson(countsUrl(), { cache: 'no-store' }, 5000)).counts || {};
    } catch (e) { /* no counts: all blocks equally likely */ }
    const used = Array.from({ length: n }, (_, i) => Number(counts[i + 1] || 0));
    const least = Math.min(...used);
    const options = [];
    used.forEach((u, i) => { if (u === least) options.push(i + 1); });
    return options[randInt(options.length)];
  }

  async function freshState() {
    const block = await pickBlock();
    const scenes = shuffled(manifest.blocks[block - 1]);
    const repeatOn = scenes[randInt(scenes.length)];
    const pages = {};
    for (const sid of scenes) {
      const s = manifest.scenes[sid];
      const ids = sid === repeatOn ? [...s.results, s.repeat] : s.results.slice();
      pages[sid] = { order: shuffled(ids), ratings: {}, shownAt: null, seconds: null };
    }
    return {
      version: manifest.version, participant: newId(), block, pilot: flag('pilot'),
      scenes, pages, step: 'consent', index: 0, rate: 1, started: null, finished: null, payload: null,
    };
  }

  function unrated(p) {
    let n = 0;
    for (const vid of p.order) for (const q of QUESTIONS) if (!(p.ratings[vid] && p.ratings[vid][q.key])) n++;
    return n;
  }

  // ------------------------------------------------------------------ synchronized playback

  // All videos of a view follow the first one. They do not loop on their own: when the first ends,
  // all restart together, so they cannot drift apart from loop to loop.
  class Player {
    constructor(videos, bar) {
      this.videos = videos;
      this.clock = videos[0];
      this.bar = bar;
      this.playing = false;
      this.live = true;
      this.ended = () => this.restart();
      this.clock.addEventListener('ended', this.ended);
      bar.attach(this);
      this.timer = setInterval(() => this.tick(), 200);
      this.whenReady().then(() => { if (this.live) this.restart(); });
    }

    whenReady() {
      const one = v => (v.readyState >= 3 ? Promise.resolve() : new Promise(done => {
        v.addEventListener('canplay', done, { once: true });
        v.addEventListener('error', done, { once: true });
      }));
      return Promise.race([Promise.all(this.videos.map(one)), new Promise(done => setTimeout(done, 12000))]);
    }

    all(f) {
      for (const v of this.videos) {
        try { f(v); } catch (e) { /* not loaded yet */ }
      }
    }

    play() {
      this.playing = true;
      const t = this.clock.currentTime;
      this.all(v => {
        v.playbackRate = state.rate;
        if (Math.abs(v.currentTime - t) > 0.04) v.currentTime = t;
        const p = v.play();
        if (p && p.catch) p.catch(() => {});
      });
      this.bar.show(this);
    }

    pause() {
      this.playing = false;
      this.all(v => v.pause());
      this.bar.show(this);
    }

    restart() {
      this.all(v => { v.currentTime = 0; });
      this.play();
    }

    seek(t) {
      if (this.playing) this.pause();
      this.all(v => { v.currentTime = t; });
    }

    setRate(r) {
      this.all(v => { v.playbackRate = r; });
    }

    tick() {
      const t = this.clock.currentTime;
      if (this.playing) {
        this.all(v => {
          if (v !== this.clock && !v.seeking && !v.ended && Math.abs(v.currentTime - t) > 0.12) v.currentTime = t;
        });
      }
      this.bar.progress(t, this.clock.duration);
    }

    stop() {
      this.live = false;
      clearInterval(this.timer);
      this.clock.removeEventListener('ended', this.ended);
      this.all(v => { v.pause(); v.removeAttribute('src'); v.load(); });
    }
  }

  function controlBar() {
    const playBtn = el('button', { class: 'btn small', type: 'button' }, 'Pause');
    const restartBtn = el('button', { class: 'btn small', type: 'button' }, 'Restart');
    const speed = el('select', { class: 'speed', 'aria-label': 'Playback speed' },
      ...RATES.map(r => el('option', { value: r }, r === 1 ? 'Normal speed' : `${r}× speed`)));
    speed.value = String(state.rate);
    const scrub = el('input', { type: 'range', min: 0, max: 1000, value: 0, class: 'scrub', 'aria-label': 'Position in the video' });
    let player_ = null;
    let dragging = false;
    playBtn.addEventListener('click', () => player_ && (player_.playing ? player_.pause() : player_.play()));
    restartBtn.addEventListener('click', () => player_ && player_.restart());
    speed.addEventListener('change', () => {
      state.rate = Number(speed.value);
      save();
      if (player_) player_.setRate(state.rate);
    });
    scrub.addEventListener('input', () => {
      dragging = true;
      if (player_ && player_.clock.duration) player_.seek((scrub.value / 1000) * player_.clock.duration);
    });
    scrub.addEventListener('change', () => { dragging = false; });
    return {
      node: el('div', { class: 'controls' }, playBtn, restartBtn, speed, scrub),
      attach(p) { player_ = p; },
      show(p) { playBtn.textContent = p.playing ? 'Pause' : 'Play'; },
      progress(t, d) { if (!dragging && d) scrub.value = Math.round((1000 * t) / d); },
    };
  }

  function video(id, size) {
    const v = el('video', { playsinline: true, muted: true, preload: 'auto', disablepictureinpicture: true });
    v.muted = true;
    v.defaultMuted = true;
    v.playsInline = true;
    v.src = videoUrl(id, size);
    return v;
  }

  // Camera names above a strip; widths in camera units (the back camera is split over both ends).
  const RING_CAMS = [['Back', 0.5], ['Back left', 1], ['Front left', 1], ['Front', 1], ['Front right', 1], ['Back right', 1], ['Back', 0.5]];
  function camBar(cams) {
    return el('div', { class: 'cams', style: `grid-template-columns: ${cams.map(c => c[1] + 'fr').join(' ')}` },
      ...cams.map(([name]) => el('span', {}, name)));
  }

  // ------------------------------------------------------------------ ratings

  function ratingRow(vid, where) {
    const p = page();
    const row = el('div', { class: 'ratings' });
    for (const q of QUESTIONS) {
      const current = (p.ratings[vid] || {})[q.key];
      const options = el('span', { class: 'ropts' });
      for (let s = 1; s <= 5; s++) {
        const input = el('input', { type: 'radio', name: `${where}-${vid}-${q.key}`, value: s, 'aria-label': `${q.label} ${s}` });
        input.checked = current === s;
        input.addEventListener('change', () => rate(vid, q.key, s));
        options.append(el('label', { class: 'ropt' }, input, el('span', {}, String(s))));
      }
      row.append(el('div', { class: 'rq', title: q.text, 'data-vid': vid, 'data-q': q.key },
        el('span', { class: 'rlabel' }, q.label), options));
    }
    return row;
  }

  function rate(vid, q, s) {
    const p = page();
    p.ratings[vid] = p.ratings[vid] || {};
    p.ratings[vid][q] = s;
    save();
    document.querySelectorAll(`.rq[data-vid="${vid}"][data-q="${q}"]`).forEach(node => {
      node.classList.remove('missing');
      node.querySelectorAll('input').forEach(i => { i.checked = Number(i.value) === s; });
    });
    const card = document.querySelector(`.card[data-vid="${vid}"]`);
    if (card) card.classList.toggle('complete', QUESTIONS.every(x => p.ratings[vid][x.key]));
    refreshNext();
  }

  function refreshNext() {
    const btns = document.querySelectorAll('.next-btn');
    if (!btns.length) return;
    const left = unrated(page());
    for (const btn of btns) {
      btn.classList.toggle('disabled', left > 0);
      btn.setAttribute('aria-disabled', left > 0 ? 'true' : 'false');
    }
    for (const note of document.querySelectorAll('.left-note'))
      note.textContent = left ? `${left} rating${left === 1 ? '' : 's'} left` : 'All rated';
  }

  function flagMissing() {
    const p = page();
    let first = null;
    document.querySelectorAll('.cards .rq').forEach(node => {
      const r = p.ratings[node.dataset.vid];
      const missing = !(r && r[node.dataset.q]);
      node.classList.toggle('missing', missing);
      if (missing && !first) first = node;
    });
    if (first) first.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  // ------------------------------------------------------------------ pages

  function go(step) {
    state.step = step;
    save();
    render();
  }

  function render() {
    closeModal();
    if (player) { player.stop(); player = null; }
    ({ consent: consentPage, instructions: instructionsPage, scene: scenePage, submit: submitPage, done: donePage })[state.step]();
    window.scrollTo(0, 0);
  }

  function consentPage() {
    app.replaceChildren(el('section', { class: 'text' },
      el('h1', {}, 'Rating generated 360° videos'),
      el('p', {}, `Thank you for helping with this research study. You will watch short videos made by AI video generators and rate them. It takes about ${minutes()} minutes.`),
      el('ul', {},
        el('li', {}, 'Participation is voluntary and anonymous. We do not ask for your name or e-mail address.'),
        el('li', {}, 'We store only your ratings, the time spent on each page and your browser window size.'),
        el('li', {}, 'Your ratings are sent after each scene, so the scenes you finish count even if you stop early. Your progress is kept in this browser, so you can take a break and come back to this page later. You can stop at any time by closing it.'),
        el('li', {}, 'The anonymous ratings may be reported in aggregate in a research publication.')),
      el('p', {}, 'Please use a laptop or desktop computer with a screen of 13 inches or larger.'),
      el('button', {
        class: 'btn primary', type: 'button',
        onclick: () => { state.started = state.started || new Date().toISOString(); go('instructions'); },
      }, 'I agree, continue')));
  }

  function instructionsPage() {
    const n = manifest.scenes[state.scenes[0]].results.length;
    app.replaceChildren(el('section', { class: 'text wide' },
      el('h1', {}, 'Instructions'),
      el('p', {}, `You will see ${state.scenes.length} scenes. For each scene, ${n} different AI methods each made a video of the whole surroundings: six cameras placed at one point, looking in six directions around it.`),
      el('p', {}, 'Each result is shown as a 360° strip. The front camera is in the middle, the cameras to its left and right follow, and the back camera is split over the two ends, so the left and right ends of the strip meet behind the camera.'),
      el('figure', { class: 'example' },
        el('img', { src: 'example.jpg', alt: 'Example of a 360-degree strip with the six camera directions labelled' }),
        el('figcaption', {}, 'Example strip with the six camera directions labelled. The yellow lines mark where neighbouring cameras meet; in the study each strip has the camera names above it.')),
      el('p', {}, `Rate every result on ${['one', 'two', 'three', 'four', 'five'][QUESTIONS.length - 1] || QUESTIONS.length} questions, from 1 (not at all) to 5 (completely):`),
      el('ol', { class: 'qlist' }, ...QUESTIONS.map(q => el('li', {}, el('b', {}, q.label + ': '), q.text))),
      el('p', {}, 'The results appear in a random order with the letters A, B, C, …. Rate each result on its own; there are no right answers.'),
      el('p', {}, 'All videos of a scene play together in a loop. Use Pause, Restart, the speed menu and the slider to look closely, and click a result to enlarge it.'),
      window.innerWidth < 1100 ? el('p', { class: 'warn' }, 'Your browser window is narrow. Please maximize it or use a larger screen.') : null,
      el('button', { class: 'btn primary', type: 'button', onclick: () => { state.index = 0; go('scene'); } }, 'Start')));
  }

  function resultCard(vid, letter) {
    const v = video(vid, 's');
    const p = page();
    const complete = p.ratings[vid] && QUESTIONS.every(q => p.ratings[vid][q.key]);
    const card = el('div', { class: 'card' + (complete ? ' complete' : ''), 'data-vid': vid },
      el('div', { class: 'card-head' },
        el('span', { class: 'badge' }, letter),
        el('button', { class: 'link', type: 'button', onclick: () => openModal(vid, letter) }, 'Enlarge')),
      el('div', {}, camBar(RING_CAMS), el('div', { class: 'strip', title: 'Click to enlarge', onclick: () => openModal(vid, letter) }, v)),
      ratingRow(vid, 'c'));
    return { card, v };
  }

  function scenePage() {
    const sid = sceneId();
    const scene = manifest.scenes[sid];
    const p = page();
    if (!p.shownAt) { p.shownAt = Date.now(); save(); }
    const n = state.scenes.length;
    const bar = controlBar();
    const cards = p.order.map((vid, i) => resultCard(vid, LETTERS[i]));
    // The questions stay in the sticky top bar; collapsing them is remembered across pages.
    const legend = el('details', { class: 'legend', open: state.legendOpen !== false },
      el('summary', {}, 'Questions (1 = not at all, 5 = completely)'),
      el('ul', {}, ...QUESTIONS.map(q => el('li', {}, el('b', {}, q.label + ': '), q.text))));
    legend.addEventListener('toggle', () => { state.legendOpen = legend.open; save(); });
    const top = el('header', { class: 'topbar' },
      el('div', { class: 'top-row' },
        el('div', { class: 'progress' },
          el('b', {}, `Scene ${state.index + 1} of ${n}`),
          el('div', { class: 'steps' }, ...Array.from({ length: n }, (_, i) => el('i', { class: i < state.index ? 'done' : i === state.index ? 'now' : '' })))),
        bar.node,
        nextRow('next')),
      legend);
    app.replaceChildren(el('div', { class: 'scene-page' }, top,
      el('div', { class: 'cards' }, ...cards.map(c => c.card)),
      el('footer', { class: 'bottom-next' }, nextRow('next-bottom'))));
    player = new Player(cards.map(c => c.v), bar);
    refreshNext();
  }

  function nextRow(id) {
    const last = state.index + 1 >= state.scenes.length;
    return el('div', { class: 'next-row' },
      el('span', { class: 'note left-note' }),
      el('button', { class: 'btn primary next-btn', id, type: 'button', onclick: nextScene }, last ? 'Finish' : 'Next scene'));
  }

  function nextScene() {
    const p = page();
    if (unrated(p) > 0) { flagMissing(); return; }
    p.seconds = Math.round((Date.now() - p.shownAt) / 100) / 10;
    state.unsent = (state.unsent || []).concat([sceneId()]);
    state.index += 1;
    sendPending();
    go(state.index < state.scenes.length ? 'scene' : 'submit');
  }

  // The enlarged result: two rows (each half of the ring, the front camera in both, so every seam stays
  // visible), one row fitted to the window, or one row at actual size, scrolling sideways.
  const LAYOUTS = [['rows', 'Two rows'], ['fit', 'One row'], ['actual', 'Actual size']];

  function bigVideos(vid, layout) {
    if (layout !== 'rows') {
      const v = video(vid, 'l');
      return { node: el('div', { class: 'big ' + layout }, el('div', { class: 'big-inner' }, camBar(RING_CAMS), v)), videos: [v] };
    }
    const halves = [['first', RING_CAMS.slice(0, 4)], ['second', RING_CAMS.slice(3, 6).concat([['Back', 0.5]])]];
    const videos = [];
    const node = el('div', { class: 'big rows' }, ...halves.map(([cls, cams]) => {
      const v = video(vid, 'l');
      videos.push(v);
      return el('figure', {}, el('div', { class: 'half-w' }, camBar(cams)), el('div', { class: 'half half-w ' + cls }, v));
    }));
    return { node, videos };
  }

  function openModal(vid, letter) {
    closeModal();
    if (player) player.pause();
    const scene = manifest.scenes[sceneId()];
    const bar = controlBar();
    const layout = el('select', { class: 'speed', 'aria-label': 'Layout' },
      ...LAYOUTS.map(([k, label]) => el('option', { value: k }, label)));
    layout.value = state.layout || 'rows';
    const holder = el('div', {});
    const show = () => {
      if (modalPlayer) modalPlayer.stop();
      const big = bigVideos(vid, layout.value);
      holder.replaceChildren(big.node);
      modalPlayer = new Player(big.videos, bar);
    };
    layout.addEventListener('change', () => { state.layout = layout.value; save(); show(); });
    const modal = el('div', { class: 'modal', onclick: e => { if (e.target === modal) closeModal(); } },
      el('div', { class: 'modal-box' },
        el('div', { class: 'modal-head' },
          el('span', { class: 'badge' }, letter), bar.node, layout,
          el('button', { class: 'btn small', type: 'button', onclick: closeModal }, 'Close (Esc)')),
        holder,
        ratingRow(vid, 'm')));
    document.body.append(modal);
    show();
  }

  function closeModal() {
    const modal = document.querySelector('.modal');
    if (!modal) return;
    if (modalPlayer) { modalPlayer.stop(); modalPlayer = null; }
    modal.remove();
    if (player) player.play();
  }

  function payload(only) {
    const done = Boolean(state.finished);
    const total = done ? Math.round((Date.parse(state.finished) - Date.parse(state.started)) / 1000) : '';
    const viewport = `${window.innerWidth}x${window.innerHeight}`;
    const rows = [];
    state.scenes.forEach((sid, i) => {
      if (only && !only.includes(sid)) return;
      const p = state.pages[sid];
      p.order.forEach((vid, pos) => {
        for (const q of QUESTIONS) {
          const row = {
            received: '', participant: state.participant, block: state.block, pilot: state.pilot, scene: sid,
            page: i + 1, position: LETTERS[pos], video: vid, question: q.key, score: p.ratings[vid][q.key],
            scene_seconds: p.seconds, total_seconds: total, viewport, version: state.version,
            started: state.started, finished: state.finished || '',
          };
          rows.push(Object.fromEntries(COLUMNS.map(c => [c, row[c]])));
        }
      });
    });
    return {
      participant: state.participant, block: state.block, pilot: state.pilot, version: state.version,
      finished: state.finished || '', rows,
    };
  }

  async function send(body) {
    const options = { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body) };
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const reply = await getJson(submitUrl(), options, 20000);
        if (reply && reply.ok) return 'ok';
      } catch (e) {
        if (CONFIG.endpoint && e && e.name === 'TypeError') {
          // The reply could not be read (e.g. CORS): send without reading it. The server ignores repeats.
          try {
            await fetch(submitUrl(), Object.assign({ mode: 'no-cors' }, options));
            return 'unconfirmed';
          } catch (e2) { /* offline: retry */ }
        }
      }
      await new Promise(done => setTimeout(done, 1500 * (attempt + 1)));
    }
    return 'failed';
  }

  // Sends the finished scenes that were not sent yet, in the background; failures are retried on the next
  // page and, at the latest, by Submit.
  let sending = false;
  async function sendPending() {
    if (sending || !(state.unsent || []).length) return;
    sending = true;
    const batch = state.unsent.slice();
    try {
      if ((await send(payload(batch))) !== 'failed') {
        state.unsent = state.unsent.filter(s => !batch.includes(s));
        save();
      }
    } finally {
      sending = false;
    }
  }

  function download() {
    const blob = new Blob([JSON.stringify(state.payload || payload(), null, 1)], { type: 'application/json' });
    const a = el('a', { href: URL.createObjectURL(blob), download: `answers_${state.participant}.json` });
    document.body.append(a);
    a.click();
    a.remove();
  }

  function submitPage() {
    const status = el('p', { class: 'status' });
    const saveBtn = el('button', { class: 'btn', type: 'button', hidden: true, onclick: download }, 'Download my answers');
    const submit = el('button', { class: 'btn primary', type: 'button', id: 'submit' }, 'Submit');
    submit.addEventListener('click', async () => {
      submit.disabled = true;
      status.textContent = 'Sending…';
      state.finished = state.finished || new Date().toISOString();
      state.payload = payload();
      save();
      if ((await send(state.payload)) === 'failed') {
        submit.disabled = false;
        submit.textContent = 'Try again';
        status.textContent = 'Your answers could not be sent. Please check your connection and try again. If it keeps failing, download your answers and send the file to the person who shared this link.';
        saveBtn.hidden = false;
        return;
      }
      go('done');
    });
    app.replaceChildren(el('section', { class: 'text' },
      el('h1', {}, 'Almost done'),
      el('p', {}, 'Press Submit to send your ratings.'),
      el('div', { class: 'next-row' }, submit, saveBtn),
      status));
  }

  function donePage() {
    app.replaceChildren(el('section', { class: 'text' },
      el('h1', {}, 'Thank you!'),
      el('p', {}, 'Your answers have been recorded. You can close this page now.')));
  }

  // ------------------------------------------------------------------ start

  async function main() {
    try {
      const res = await fetch('manifest.json', { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      manifest = await res.json();
    } catch (e) {
      app.replaceChildren(el('p', { class: 'loading' }, 'The study could not be loaded. Please reload the page.'));
      return;
    }
    if (flag('reset')) {
      try { localStorage.removeItem(STORE); } catch (e) { /* no storage */ }
      params.delete('reset');
      const qs = params.toString();
      history.replaceState(null, '', location.pathname + (qs ? '?' + qs : ''));
    }
    state = restore();
    if (!state || state.version !== manifest.version) {
      state = await freshState();
      save();
    }
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });
    render();
  }

  main();
})();
