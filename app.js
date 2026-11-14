/* app.js — приложение-ученик: задания по темам офлайн, очередь ответов, синхронизация с Apps Script. */
(function () {
  'use strict';
  var L = window.Logic;
  var view = document.getElementById('view');
  var statusEl = document.getElementById('status');
  var titleEl = document.getElementById('title');

  var state = { config: null, pack: null, done: {}, queued: 0, lastSync: '', syncing: false, syncError: '', session: null };

  // ------------------------------------------------------------------ хранилище (IndexedDB)
  var dbPromise = new Promise(function (resolve, reject) {
    var req = indexedDB.open('tasks-app', 1);
    req.onupgradeneeded = function () {
      var db = req.result;
      db.createObjectStore('kv');
      db.createObjectStore('queue', { keyPath: 'attempt_id' });
      db.createObjectStore('done', { keyPath: 'task_id' });
    };
    req.onsuccess = function () { resolve(req.result); };
    req.onerror = function () { reject(req.error); };
  });

  function tx(store, mode, fn) {
    return dbPromise.then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(store, mode), out = fn(t.objectStore(store));
        t.oncomplete = function () { resolve(out && out.result !== undefined ? out.result : undefined); };
        t.onerror = function () { reject(t.error); };
        t.onabort = function () { reject(t.error); };
      });
    });
  }
  var kvGet = function (k) { return tx('kv', 'readonly', function (s) { return s.get(k); }); };
  var kvSet = function (k, v) { return tx('kv', 'readwrite', function (s) { return s.put(v, k); }); };
  var queueAll = function () { return tx('queue', 'readonly', function (s) { return s.getAll(); }); };
  var queuePut = function (a) { return tx('queue', 'readwrite', function (s) { return s.put(a); }); };
  var queueDelete = function (ids) { return tx('queue', 'readwrite', function (s) { ids.forEach(function (id) { s.delete(id); }); }); };
  var doneAll = function () { return tx('done', 'readonly', function (s) { return s.getAll(); }); };
  var donePut = function (d) { return tx('done', 'readwrite', function (s) { return s.put(d); }); };

  // ------------------------------------------------------------------ утилиты
  function esc(v) {
    return String(v === null || v === undefined ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function plural(n, a, b, c) {
    var x = Math.abs(n) % 100, y = x % 10;
    return (x > 10 && x < 20) ? c : y === 1 ? a : (y >= 2 && y <= 4) ? b : c;
  }
  function deviceName() {
    var ua = navigator.userAgent || '';
    return /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) ? 'iPad'
      : /iPhone/.test(ua) ? 'iPhone' : /Android/.test(ua) ? 'Android' : /Macintosh/.test(ua) ? 'Mac' : 'Browser';
  }
  function clock(iso) {
    var d = new Date(iso);
    return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
  }

  // ------------------------------------------------------------------ настройка
  function applyManifest(code) {
    // Адрес запуска с кодом настройки: иконка на экране «Домой» откроет приложение уже настроенным.
    try {
      var start = location.origin + location.pathname + '?setup=' + code;
      var manifest = {
        name: 'Задания', short_name: 'Задания', start_url: start, scope: location.origin + location.pathname.replace(/[^/]*$/, ''),
        display: 'standalone', background_color: '#f6f5f1', theme_color: '#2f5d9e',
        icons: [{ src: new URL('icon-192.png', location.href).href, sizes: '192x192', type: 'image/png' },
                { src: new URL('icon-512.png', location.href).href, sizes: '512x512', type: 'image/png' }]
      };
      var link = document.querySelector('link[rel=manifest]') || document.head.appendChild(document.createElement('link'));
      link.rel = 'manifest';
      link.href = URL.createObjectURL(new Blob([JSON.stringify(manifest)], { type: 'application/manifest+json' }));
    } catch (e) { /* не критично */ }
  }

  function currentSetupCode() {
    return kvGet('setupCode');
  }

  function saveSetup(code) {
    var cfg = L.decodeSetupCode(code);
    if (!cfg) return Promise.resolve(false);
    return Promise.all([kvSet('config', cfg), kvSet('setupCode', String(code).trim())]).then(function () {
      state.config = cfg;
      applyManifest(String(code).trim());
      return true;
    });
  }

  function renderSetup(message) {
    titleEl.textContent = 'Настройка';
    view.innerHTML = '<div class="card"><h2>Подключение</h2>' +
      '<p class="muted">Вставьте код настройки (его показывает родитель). Нужно один раз, при подключении к интернету.</p>' +
      (message ? '<p class="err" role="alert">' + esc(message) + '</p>' : '') +
      '<input type="text" id="code" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="Код настройки">' +
      '<div class="row"><button class="primary" id="saveCode">Подключить</button></div></div>';
    document.getElementById('saveCode').onclick = function () {
      var value = document.getElementById('code').value;
      saveSetup(value).then(function (ok) { ok ? start() : renderSetup('Код не подошёл. Скопируйте его целиком.'); });
    };
  }

  // ------------------------------------------------------------------ синхронизация
  function refreshCounters() {
    return Promise.all([queueAll(), doneAll()]).then(function (r) {
      state.queued = r[0].length;
      state.done = {};
      r[1].forEach(function (d) { state.done[d.task_id] = d; });
    });
  }

  function renderStatus() {
    var online = navigator.onLine;
    var html = '<span class="pill ' + (online ? 'ok' : 'warn') + '">' + (online ? 'Есть сеть' : 'Нет сети') + '</span>';
    html += '<span class="pill ' + (state.queued ? 'warn' : '') + '">Не отправлено: ' + state.queued + '</span>';
    if (state.syncError) html += '<span class="pill warn" role="alert">' + esc(state.syncError) + '</span>';
    else if (state.lastSync) html += '<span class="pill">Синхронизировано в ' + esc(clock(state.lastSync)) + '</span>';
    html += '<button id="syncBtn"' + (state.syncing ? ' disabled' : '') + '>' + (state.syncing ? 'Синхронизация…' : 'Синхронизировать') + '</button>';
    statusEl.innerHTML = html;
    document.getElementById('syncBtn').onclick = function () { syncNow(true); };
  }

  function fetchJson(url, options) {
    return fetch(url, options).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  function syncNow(manual) {
    if (!state.config || state.syncing) return Promise.resolve();
    state.syncing = true; state.syncError = ''; renderStatus();

    var cfg = state.config;
    return queueAll().then(function (queue) {
      if (!queue.length) return null;
      return fetchJson(cfg.api + '?action=sync', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },     // без предварительного запроса (CORS preflight)
        body: JSON.stringify({ token: cfg.token, device: deviceName(), attempts: queue })
      }).then(function (res) {
        if (res.ok !== true) throw new Error(res.error === 'forbidden' ? 'forbidden' : 'Сервер отклонил запрос');
        return queueDelete(L.idsToRemove(res));
      });
    }).then(function () {
      return fetchJson(cfg.api + '?action=pack&token=' + encodeURIComponent(cfg.token));
    }).then(function (res) {
      if (res.ok !== true) throw new Error(res.error === 'forbidden' ? 'forbidden' : 'Сервер не отдал задания');
      state.pack = res.pack;
      return kvSet('pack', res.pack);
    }).then(function () {
      state.lastSync = new Date().toISOString();
      return kvSet('lastSync', state.lastSync);
    }).catch(function (e) {
      state.syncError = e.message === 'forbidden' ? 'Неверный код настройки'
        : (navigator.onLine ? 'Не удалось синхронизировать' : 'Нет сети: ответы сохранены на устройстве');
    }).then(function () {
      state.syncing = false;
      return refreshCounters();
    }).then(function () {
      renderStatus();
      if (!state.session) renderHome();
    });
  }

  // ------------------------------------------------------------------ экраны
  function topicById(id) {
    return (state.pack ? state.pack.topics : []).filter(function (t) { return t.id === id; })[0];
  }

  function renderHome() {
    state.session = null;
    titleEl.textContent = 'Задания';
    var topics = state.pack ? state.pack.topics : [];

    if (!topics.length) {
      view.innerHTML = '<div class="card"><h2>Заданий пока нет</h2><p class="muted">' +
        (navigator.onLine ? 'Нажмите «Синхронизировать» — приложение скачает задания.' : 'Подключитесь к интернету и нажмите «Синхронизировать»: нужно скачать задания.') + '</p></div>';
      return;
    }

    view.innerHTML = topics.map(function (t) {
      var s = L.topicStats(t, state.done);
      var pct = s.total ? Math.round(s.answered * 100 / s.total) : 0;
      var rest = s.total - s.answered;
      return '<section class="card"><h2>' + esc(t.name) + '</h2>' +
        (t.subject ? '<div class="muted">' + esc(t.subject) + (t.current ? ' · текущая тема' : '') + '</div>' : (t.current ? '<div class="muted">Текущая тема</div>' : '')) +
        '<div class="bar-p" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + pct + '" aria-label="Решено"><i style="width:' + pct + '%"></i></div>' +
        '<div class="muted">Решено ' + s.answered + ' из ' + s.total + (s.answered ? ' · верно ' + s.correct : '') + '</div>' +
        '<div class="row">' +
        (rest ? '<button class="primary" data-start="' + esc(t.id) + '" data-mode="new">' + (s.answered ? 'Продолжить' : 'Начать') + ' (' + rest + ' ' + plural(rest, 'задание', 'задания', 'заданий') + ')</button>' : '') +
        (s.wrong ? '<button data-start="' + esc(t.id) + '" data-mode="wrong">Повторить ошибки (' + s.wrong + ')</button>' : '') +
        (!rest ? '<button data-start="' + esc(t.id) + '" data-mode="all">Пройти заново</button>' : '') +
        '</div></section>';
    }).join('');

    Array.prototype.forEach.call(view.querySelectorAll('[data-start]'), function (b) {
      b.onclick = function () { startPractice(b.getAttribute('data-start'), b.getAttribute('data-mode')); };
    });
  }

  function startPractice(topicId, mode) {
    var topic = topicById(topicId);
    if (!topic) return renderHome();
    var tasks = L.pickTasks(topic, state.done, mode);
    if (!tasks.length) return renderHome();
    state.session = { topicId: topicId, tasks: tasks, index: 0, correct: 0, answered: false };
    renderTask();
  }

  function renderTask() {
    var s = state.session, topic = topicById(s.topicId);
    if (!topic || s.index >= s.tasks.length) return renderFinish();

    var task = s.tasks[s.index];
    s.answered = false;
    titleEl.textContent = topic.name;

    var head = '<div class="muted">Задание ' + (s.index + 1) + ' из ' + s.tasks.length + '</div>' +
      '<div class="bar-p"><i style="width:' + Math.round(s.index * 100 / s.tasks.length) + '%"></i></div>' +
      '<div class="q">' + esc(task.q) + '</div>';

    if (task.type === 'choice') {
      view.innerHTML = '<div class="card">' + head + '<div class="opts" id="opts">' +
        task.options.map(function (o, i) { return '<button data-i="' + i + '">' + esc(o) + '</button>'; }).join('') +
        '</div><div id="fb"></div></div><div class="row"><button id="quit">К темам</button></div>';
      Array.prototype.forEach.call(view.querySelectorAll('#opts button'), function (b) {
        b.onclick = function () { answer(task, task.options[Number(b.getAttribute('data-i'))], b); };
      });
    } else {
      view.innerHTML = '<div class="card">' + head +
        '<input type="text" id="ans" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" aria-label="Ответ">' +
        '<div class="row"><button class="primary" id="check">Проверить</button></div><div id="fb"></div></div>' +
        '<div class="row"><button id="quit">К темам</button></div>';
      var input = document.getElementById('ans');
      var go = function () { if (input.value.trim()) answer(task, input.value, null); };
      document.getElementById('check').onclick = go;
      input.onkeydown = function (e) { if (e.key === 'Enter') go(); };
      input.focus();
    }
    document.getElementById('quit').onclick = function () { renderHome(); };
  }

  function answer(task, given, button) {
    var s = state.session;
    if (s.answered) return;
    s.answered = true;

    var ok = L.isCorrect(task.answer, given);
    if (ok) s.correct++;

    var attempt = { attempt_id: L.makeAttemptId(), task_id: task.id, topic_id: s.topicId, answer: String(given), answered_at: new Date().toISOString() };
    var rec = { task_id: task.id, correct: ok, at: attempt.answered_at };

    // Сначала сохраняем на устройстве; показываем результат — и только потом пробуем отправить.
    Promise.all([queuePut(attempt), donePut(rec)]).then(refreshCounters).then(function () {
      state.done[task.id] = rec;
      renderStatus();
      if (navigator.onLine) syncSoon();
    });

    if (task.type === 'choice') {
      Array.prototype.forEach.call(view.querySelectorAll('#opts button'), function (b) {
        var text = task.options[Number(b.getAttribute('data-i'))];
        b.disabled = true;
        if (L.isCorrect(task.answer, text)) b.classList.add('right');
        else if (b === button) b.classList.add('wrong');
      });
    } else {
      document.getElementById('ans').disabled = true;
      document.getElementById('check').disabled = true;
    }

    var fb = document.getElementById('fb');
    fb.innerHTML = '<div class="fb ' + (ok ? 'ok' : 'bad') + '" role="status"><b>' + (ok ? 'Верно!' : 'Не совсем.') + '</b>' +
      (ok ? '' : '<div>Правильный ответ: <strong>' + esc(task.answer[0]) + '</strong></div>') +
      (task.explanation ? '<div class="muted" style="margin-top:6px">' + esc(task.explanation) + '</div>' : '') + '</div>' +
      '<div class="row"><button class="primary" id="next">' + (s.index + 1 >= s.tasks.length ? 'Закончить' : 'Дальше') + '</button></div>';
    var next = document.getElementById('next');
    next.onclick = function () { s.index++; renderTask(); };
    next.focus();
  }

  function renderFinish() {
    var s = state.session, topic = topicById(s.topicId);
    titleEl.textContent = 'Готово';
    view.innerHTML = '<div class="card"><h2>Молодец!</h2><p>Верно ' + s.correct + ' из ' + s.tasks.length + '.</p>' +
      (state.queued ? '<p class="muted">Ответы сохранены на устройстве и отправятся, когда появится интернет.</p>' : '') +
      '<div class="row"><button class="primary" id="home">К темам</button></div></div>';
    document.getElementById('home').onclick = renderHome;
    state.session = null;
    void topic;
  }

  var syncTimer = null;
  function syncSoon() {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(function () { syncNow(false); }, 1500);
  }

  // ------------------------------------------------------------------ запуск
  function start() {
    kvGet('pack').then(function (p) { state.pack = p || null; })
      .then(function () { return kvGet('lastSync'); }).then(function (t) { state.lastSync = t || ''; })
      .then(refreshCounters)
      .then(function () {
        renderStatus();
        renderHome();
        return syncNow(false);
      });
  }

  function init() {
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(function () {});
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () {});

    window.addEventListener('online', function () { syncNow(false); });
    window.addEventListener('offline', renderStatus);
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') syncNow(false); });

    var fromUrl = new URLSearchParams(location.search).get('setup');

    Promise.resolve(fromUrl ? saveSetup(fromUrl) : false).then(function (saved) {
      if (fromUrl && saved) history.replaceState(null, '', location.pathname);   // убираем код из адресной строки
      return kvGet('config');
    }).then(function (cfg) {
      if (!cfg) { renderStatus(); return renderSetup(fromUrl ? 'Код не подошёл. Скопируйте его целиком.' : ''); }
      state.config = cfg;
      return currentSetupCode().then(function (code) { if (code) applyManifest(code); start(); });
    });
  }

  init();
})();
