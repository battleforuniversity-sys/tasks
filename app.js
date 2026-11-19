/* app.js — приложение-ученик: задания по темам офлайн, очередь ответов, синхронизация с Apps Script. */
(function () {
  'use strict';
  var L = window.Logic, P = window.Plan;
  var view = document.getElementById('view');
  var statusEl = document.getElementById('status');
  var titleEl = document.getElementById('title');
  document.getElementById('dyncss').textContent = P.dynCss();

  var state = { config: null, pack: null, done: {}, queued: 0, lastSync: '', syncing: false, syncError: '', session: null, tab: 'home', weekIdx: null, dynSubject: '', dynMetric: 'all', queueItems: [] };

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
  // Текст задания: «\n» — перенос строки, «__слово__» — подчёркнутое слово (в вопросах «altı çizili sözcük»).
  function rich(v) {
    return esc(v).replace(/\\n/g, '<br>').replace(/__(.+?)__/g, '<u>$1</u>');
  }
  // Рисунок к заданию: файл лежит в папке img/ рядом с приложением (GitHub Pages) и кэшируется для офлайна.
  function figure(task) {
    if (!task.img || !/^[A-Za-z0-9_.-]+$/.test(task.img)) return '';
    return '<div class="fig"><img src="img/' + esc(task.img) + '" alt="Рисунок к заданию" onerror="this.parentNode.className=\'fig miss\';this.parentNode.textContent=\'Рисунок не загрузился. Откройте приложение с интернетом.\'"></div>';
  }
  // Скачивает рисунки заранее, пока есть интернет: service worker кладёт их в кэш.
  function prefetchImages(pack) {
    try {
      var seen = {};
      ((pack && pack.topics) || []).forEach(function (t) {
        (t.tasks || []).forEach(function (k) {
          if (k.img && !seen[k.img] && /^[A-Za-z0-9_.-]+$/.test(k.img)) { seen[k.img] = 1; fetch('img/' + k.img).catch(function () {}); }
        });
      });
    } catch (e) { /* без рисунков приложение работает */ }
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
      state.queueItems = r[0];
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
      prefetchImages(res.pack);
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
      if (!state.session) route(state.tab);
    });
  }

  // ------------------------------------------------------------------ экраны
  function topicById(id) {
    return (state.pack ? state.pack.topics : []).filter(function (t) { return t.id === id; })[0];
  }

  // ------------------------------------------------------------------ данные для экранов
  function pct(a, b) { return b > 0 ? Math.round(a * 100 / b) : 0; }
  function today() { return P.todayInIstanbul(); }

  /** {taskId: задание + topicId} из скачанного пакета. */
  function taskPool() {
    var pool = {};
    (state.pack ? state.pack.topics : []).forEach(function (t) {
      t.tasks.forEach(function (task) { pool[task.id] = Object.assign({ topicId: t.id }, task); });
    });
    return pool;
  }

  /** {taskId: верно?} — ответы с сервера, поверх них то, что решено на этом устройстве (оно свежее). */
  function liveAnswered() {
    var map = {};
    var fromServer = (state.pack && state.pack.answered) || {};
    Object.keys(fromServer).forEach(function (id) { map[id] = fromServer[id]; });
    Object.keys(state.done).forEach(function (id) { map[id] = state.done[id].correct; });
    return map;
  }

  function liveStats() {
    var tasks = [], topicSubject = {};
    (state.pack ? state.pack.topics : []).forEach(function (t) {
      if (t.subjectId) topicSubject[t.id] = t.subjectId;
      t.tasks.forEach(function (x) { tasks.push({ id: x.id, topicId: t.id }); });
    });
    return P.planStats({ today: today(), tasks: tasks, topicSubject: topicSubject,
      plan: (state.pack && state.pack.plan) || [], answered: liveAnswered() });
  }

  function examCountdown(exam) {
    if (!exam || !exam.date) return null;
    var a = today().split('-').map(Number), b = String(exam.date).split('-').map(Number);
    var days = Math.round((Date.UTC(b[0], b[1] - 1, b[2]) - Date.UTC(a[0], a[1] - 1, a[2])) / 86400000);
    if (days < 0) return { headline: 'Экзамен прошёл', sub: '' };
    if (days === 0) return { headline: 'Сегодня', sub: 'Первый день экзамена' };
    var w = Math.floor(days / 7), r = days % 7, parts = [];
    if (w) parts.push(w + ' ' + plural(w, 'неделя', 'недели', 'недель'));
    if (r) parts.push(r + ' ' + plural(r, 'день', 'дня', 'дней'));
    return { headline: parts.join(' '), sub: 'Всего ' + days + ' ' + plural(days, 'день', 'дня', 'дней') };
  }

  function duration(min) {
    var h = Math.floor(min / 60), m = min % 60;
    return (h ? h + ' ч' : '') + (h && m ? ' ' : '') + (m || !h ? m + ' мин' : '');
  }

  function tbar(green, red, label) {
    return '<div class="tbar" role="img" aria-label="' + esc(label) + '"><i class="g" style="width:' + green + '%"></i><i class="r" style="width:' + red + '%"></i></div>';
  }

  // ------------------------------------------------------------------ навигация
  var TABS = [['home', 'Дашборд'], ['today', 'Сегодня'], ['upcoming', 'Ближайшие'], ['debt', 'Нужно выполнить'], ['schedule', 'Расписание'], ['dynamics', 'Динамика'], ['practice', 'Тренировка']];

  function renderNav() {
    document.getElementById('nav').style.display = '';
    var st = state.pack && state.pack.plan ? liveStats() : null;
    document.getElementById('nav').innerHTML = TABS.map(function (t) {
      var n = '';
      if (st && t[0] === 'today' && st.all.today) n = '<span class="n">' + st.all.todayDone + '/' + st.all.today + '</span>';
      if (st && t[0] === 'debt' && st.all.debt) n = '<span class="n red">' + st.all.debt + '</span>';
      return '<button data-tab="' + t[0] + '"' + (state.tab === t[0] ? ' aria-current="page"' : '') + '>' + t[1] + n + '</button>';
    }).join('');
    Array.prototype.forEach.call(document.querySelectorAll('#nav [data-tab]'), function (b) {
      b.onclick = function () { route(b.getAttribute('data-tab')); };
    });
  }

  function route(tab) {
    state.session = null;
    state.tab = tab;
    renderNav();
    if (tab === 'today') return renderAssigned('today');
    if (tab === 'debt') return renderAssigned('debt');
    if (tab === 'upcoming') return renderUpcoming();
    if (tab === 'schedule') return renderSchedule();
    if (tab === 'dynamics') return renderDynamics();
    if (tab === 'practice') return renderPractice();
    return renderDashboard();
  }

  // ------------------------------------------------------------------ дашборд
  function renderDashboard() {
    titleEl.textContent = 'Дашборд';
    var home = state.pack && state.pack.home;
    var st = state.pack && state.pack.plan ? liveStats() : null;

    if (!state.pack) {
      view.innerHTML = '<div class="card"><h2>Данных пока нет</h2><p class="muted">' +
        (navigator.onLine ? 'Нажмите «Синхронизировать» — приложение скачает задания и расписание.' : 'Подключитесь к интернету и нажмите «Синхронизировать».') + '</p></div>';
      return;
    }

    var html = '';
    if (st) {
      var up = st.upcoming.reduce(function (n, d) { return n + d.ids.length; }, 0);
      html += '<div class="links">' +
        '<button data-go="schedule">🗓 Расписание</button>' +
        '<button data-go="today" class="primary">📱 Задания на сегодня<br><small>' + st.all.todayDone + ' из ' + st.all.today + '</small></button>' +
        '<button data-go="debt"' + (st.all.debt ? ' class="red"' : '') + '>⏳ Нужно выполнить<br><small>' +
        (st.all.debt ? st.all.debt + ' ' + plural(st.all.debt, 'задание', 'задания', 'заданий') : 'долга нет') + '</small></button>' +
        '<button data-go="upcoming">📅 Ближайшие<br><small>' + up + ' ' + plural(up, 'задание', 'задания', 'заданий') + '</small></button></div>';
    } else {
      html += '<div class="links"><button data-go="schedule">🗓 Расписание</button><button data-go="practice">📱 Тренировка</button></div>';
    }

    if (home) {
      var ex = examCountdown(home.exam);
      var tk = st ? st.all : home.tasks;
      var accuracy = pct(tk.correct, tk.answered);
      html += '<div class="grid">';
      if (ex) html += '<section class="card"><h2>' + esc(home.exam.name || 'Экзамен') + '</h2><div class="big">' + esc(ex.headline) + '</div><div class="muted">' + esc(ex.sub) + '</div></section>';
      html += '<section class="card"><h2>Темы</h2><div class="big"><span class="good">' + home.topics.done + '</span> <small>из ' + home.topics.total + '</small></div>' +
        tbar(home.topics.percent, 0, 'Пройдено тем') + '</section>';
      html += '<section class="card"><h2>Задания</h2><div class="big"><span class="good">' + tk.answered + '</span> <small>из ' + tk.total + '</small></div>' +
        tbar(pct(tk.answered, tk.total), pct(tk.debt, tk.total), 'Решено заданий и долг') +
        '<div class="muted">Верно ' + accuracy + '% · ' + (tk.debt ? '<span class="debt">долг ' + tk.debt + '</span>' : 'долга нет') + '</div></section>';
      html += '</div>';

      home.subjects.forEach(function (s) {
        var sub = st && st.bySubject[s.id] ? st.bySubject[s.id] : s.tasks;
        html += '<section class="card"><h2>' + esc(s.name) + '</h2>' +
          '<div class="muted">' + (s.current ? 'Тема: ' + esc(s.current.name) : s.state === 'empty' ? 'Программа не загружена' : s.state === 'finished' ? 'Программа пройдена' : 'Тема не назначена') + '</div>';
        if (s.state !== 'empty') html += tbar(s.percent, 0, 'Пройдено тем: ' + s.name) + '<div class="muted">Темы: ' + s.done + ' из ' + s.total + '</div>';
        if (s.tasks.mode === 'app') {
          html += '<div class="muted" style="margin-top:8px">📱 Задания в приложении</div>';
          if (sub.total) html += tbar(pct(sub.answered, sub.total), pct(sub.debt, sub.total), 'Задания: решено и долг: ' + s.name) +
            '<div class="muted">Решено ' + sub.answered + ' из ' + sub.total + ' · верно ' + pct(sub.correct, sub.answered) + '%' +
            (sub.debt ? ' · <span class="debt">долг ' + sub.debt + '</span>' : '') + '</div>';
        } else if (s.tasks.mode === 'book') {
          html += '<div class="muted" style="margin-top:8px">📖 Задания в книжке</div>';
        }
        html += '</section>';
      });
    } else {
      html += '<div class="card"><p class="muted">Прогресс по темам появится после следующей синхронизации.</p></div>';
    }

    if (state.pack.generatedAt) html += '<p class="muted">Данные от ' + esc(clock(state.pack.generatedAt)) + '. Задания и долг считаются на этом устройстве сразу.</p>';
    view.innerHTML = html;
    Array.prototype.forEach.call(view.querySelectorAll('[data-go]'), function (b) { b.onclick = function () { route(b.getAttribute('data-go')); }; });
  }

  // ------------------------------------------------------------------ динамика по неделям
  /** Журнал всех ответов: с сервера + ответы с этого устройства, которые ещё не отправлены. */
  function dynamicsLog() {
    var dyn = (state.pack && state.pack.dyn) || { log: [], subjects: [] };
    var log = dyn.log.slice();
    var topicSubject = {};
    (state.pack ? state.pack.topics : []).forEach(function (t) { if (t.subjectId) topicSubject[t.id] = t.subjectId; });
    var pool = taskPool();
    (state.queueItems || []).forEach(function (a) {
      var task = pool[a.task_id];
      if (!task) return;
      var sid = topicSubject[task.topicId || a.topic_id], when = new Date(a.answered_at);
      if (!sid || isNaN(when.getTime())) return;
      log.push({ t: a.task_id, s: sid, d: P.todayInIstanbul(when), at: when.toISOString(), ok: L.isCorrect(task.answer, a.answer) });
    });
    return { log: log, subjects: dyn.subjects || [] };
  }

  function renderDynamics() {
    titleEl.textContent = 'Динамика по неделям';
    if (!state.pack) {
      view.innerHTML = '<div class="card"><h2>Данных пока нет</h2><p class="muted">Нажмите «Синхронизировать» при подключении к интернету.</p></div>';
      return;
    }
    var d = dynamicsLog();
    var model = P.weeklyDynamics({ today: today(), weeks: 12, log: d.log, subjects: d.subjects });
    if (!model.weeks.length) {
      view.innerHTML = '<div class="card"><h2>Ответов пока нет</h2><p class="muted">Диаграмма появится после первых ответов.</p></div>';
      return;
    }
    var known = {};
    model.subjects.forEach(function (s) { known[s.id] = true; });
    var sel = state.dynSubject && known[state.dynSubject] ? state.dynSubject : '';
    var met = P.dynMetrics[state.dynMetric] ? state.dynMetric : 'all';
    var sum = function (s) { return model.weeks.reduce(function (n, w) { return n + (w[met][s.id] || 0); }, 0); };
    var all = model.subjects.reduce(function (n, s) { return n + sum(s); }, 0);

    var html = '<div class="chips" role="group" aria-label="Что показывать">' + Object.keys(P.dynMetrics).map(function (k) {
      return '<button data-met="' + k + '"' + (k === met ? ' aria-pressed="true"' : '') + '>' + esc(P.dynMetrics[k]) + '</button>';
    }).join('') + '</div>';
    html += '<div class="chips" role="group" aria-label="Предмет"><button data-sub=""' + (!sel ? ' aria-pressed="true"' : '') + '>Все предметы <span class="n">' + all + '</span></button>' +
      model.subjects.map(function (s) {
        return '<button data-sub="' + esc(s.id) + '"' + (sel === s.id ? ' aria-pressed="true"' : '') + '><i class="dsw dc' + s.color + '"></i> ' + esc(s.name) + ' <span class="n">' + sum(s) + '</span></button>';
      }).join('') + '</div>';

    var t = P.dynWeekTotals(model, model.weeks[model.weeks.length - 1], sel);
    html += '<p class="dynsum"><strong>Эта неделя:</strong> ' + t.all + ' ответов · ' + t.wrong + ' неверных' + (t.all ? ' (' + t.pct + '%)' : '') + ' · ' + t.rep + ' повторов</p>';
    html += '<section class="card"><h2>' + esc(P.dynMetrics[met]) + ' по неделям</h2>' + P.dynamicsSvg(model, sel, met) +
      '<p class="muted">Неделя — с понедельника. Считается каждый ответ; повтор — ответ на задание, на которое уже отвечали.</p></section>';

    var rows = model.weeks.slice().reverse().map(function (w) {
      var x = P.dynWeekTotals(model, w, sel), p = w.start.split('-');
      return '<tr' + (w.current ? ' class="now"' : '') + '><td>' + p[2] + '.' + p[1] + (w.current ? ' · эта' : '') + '</td><td>' + x.all + '</td><td>' + x.wrong +
        (x.all ? ' <span class="n">(' + x.pct + '%)</span>' : '') + '</td><td>' + x.rep + '</td></tr>';
    }).join('');
    html += '<section class="card"><h2>В цифрах</h2><div class="tablewrap"><table class="dtable"><thead><tr><th>Неделя</th><th>Всего</th><th>Неверно</th><th>Повторы</th></tr></thead><tbody>' + rows + '</tbody></table></div></section>';

    view.innerHTML = html;
    Array.prototype.forEach.call(view.querySelectorAll('[data-sub]'), function (b) {
      b.onclick = function () { state.dynSubject = b.getAttribute('data-sub'); renderDynamics(); };
    });
    Array.prototype.forEach.call(view.querySelectorAll('[data-met]'), function (b) {
      b.onclick = function () { state.dynMetric = b.getAttribute('data-met'); renderDynamics(); };
    });
  }

  // ------------------------------------------------------------------ задания на сегодня / нужно выполнить
  function renderAssigned(kind) {
    titleEl.textContent = kind === 'today' ? 'Задания на сегодня' : 'Нужно выполнить';
    if (!state.pack || !state.pack.plan) {
      view.innerHTML = '<div class="card"><h2>Заданий по расписанию пока нет</h2><p class="muted">Нажмите «Синхронизировать» при подключении к интернету. Задания по темам можно решать на вкладке «Тренировка».</p></div>';
      return;
    }
    var st = liveStats(), pool = taskPool(), ans = liveAnswered();
    var ids = kind === 'today' ? st.todayList : st.debtList;

    if (!ids.length) {
      view.innerHTML = '<div class="card"><h2>' + (kind === 'today' ? 'На сегодня заданий нет' : 'Долга нет 🎉') + '</h2><p class="muted">' +
        (kind === 'today' ? 'Задания приходят по расписанию. Можно потренироваться на вкладке «Тренировка».' : 'Все выданные задания выполнены.') + '</p></div>';
      return;
    }

    var groups = [], byTopic = {};
    ids.forEach(function (id) {
      var t = pool[id]; if (!t) return;
      if (!byTopic[t.topicId]) { byTopic[t.topicId] = { topicId: t.topicId, ids: [], left: [] }; groups.push(byTopic[t.topicId]); }
      byTopic[t.topicId].ids.push(id);
      if (ans[id] === undefined) byTopic[t.topicId].left.push(id);
    });

    var summary = kind === 'today'
      ? '<div class="card"><div class="big"><span class="good">' + st.all.todayDone + '</span> <small>из ' + st.all.today + ' сделано</small></div>' + tbar(pct(st.all.todayDone, st.all.today), 0, 'Сделано сегодня') + '</div>'
      : '<div class="card"><div class="big debt">' + st.all.debt + ' <small>' + plural(st.all.debt, 'задание', 'задания', 'заданий') + ' ждёт</small></div><p class="muted">Это задания прошлых дней. Они переносятся сюда, пока не будут решены.</p></div>';

    view.innerHTML = summary + groups.map(function (g, i) {
      var topic = topicById(g.topicId), done = g.ids.length - g.left.length;
      return '<section class="card"><h2>' + esc(topic ? topic.name : g.topicId) + '</h2>' +
        (topic && topic.subject ? '<div class="muted">' + esc(topic.subject) + '</div>' : '') +
        (kind === 'today' ? tbar(pct(done, g.ids.length), 0, 'Сделано') + '<div class="muted">Сделано ' + done + ' из ' + g.ids.length + '</div>' : '<div class="muted">Осталось ' + g.left.length + '</div>') +
        '<div class="row">' + (g.left.length
          ? '<button class="primary" data-g="' + i + '">' + (done ? 'Продолжить' : 'Начать') + ' (' + g.left.length + ')</button>'
          : '<span class="good">✓ Всё выполнено</span>') + '</div></section>';
    }).join('') + (groups.length > 1 ? '<div class="row"><button data-g="all">Решать всё подряд (' + ids.filter(function (id) { return ans[id] === undefined; }).length + ')</button></div>' : '');

    Array.prototype.forEach.call(view.querySelectorAll('[data-g]'), function (b) {
      b.onclick = function () {
        var k = b.getAttribute('data-g');
        startAssigned(k === 'all' ? ids : groups[Number(k)].left, kind);
      };
    });
  }

  // ------------------------------------------------------------------ ближайшие задания
  function dayLabel(date) {
    var p = date.split('-').map(Number), d = new Date(Date.UTC(p[0], p[1] - 1, p[2], 12));
    var t = today().split('-').map(Number), diff = Math.round((d - Date.UTC(t[0], t[1] - 1, t[2], 12)) / 86400000);
    var name = 'Завтра';
    if (diff !== 1) {
      try { name = d.toLocaleDateString('ru-RU', { weekday: 'long', timeZone: 'UTC' }); name = name.charAt(0).toUpperCase() + name.slice(1); } catch (e) { name = date; }
    }
    return name + ', ' + ('0' + p[2]).slice(-2) + '.' + ('0' + p[1]).slice(-2);
  }

  function renderUpcoming() {
    titleEl.textContent = 'Ближайшие задания';
    if (!state.pack || !state.pack.plan) {
      view.innerHTML = '<div class="card"><h2>Заданий по расписанию пока нет</h2><p class="muted">Нажмите «Синхронизировать» при подключении к интернету.</p></div>';
      return;
    }
    var st = liveStats(), pool = taskPool(), ans = liveAnswered();
    var days = st.upcoming.filter(function (d) { return d.ids.some(function (id) { return pool[id]; }); });

    // «В свободное время»: нерешённые задания, которые никому не выданы
    var planned = {};
    state.pack.plan.forEach(function (r) { planned[r.taskId] = true; });
    var free = [], freeBy = {};
    Object.keys(pool).forEach(function (id) {
      if (planned[id] || ans[id] !== undefined) return;
      var t = pool[id];
      if (!freeBy[t.topicId]) { freeBy[t.topicId] = { topicId: t.topicId, ids: [] }; free.push(freeBy[t.topicId]); }
      freeBy[t.topicId].ids.push(id);
    });

    if (!days.length && !free.length) {
      view.innerHTML = '<div class="card"><h2>Ближайших заданий нет</h2><p class="muted">Они выдаются по расписанию заранее, когда в занятиях указана тема с заданиями.</p></div>';
      return;
    }

    var starts = [];
    var freeHtml = free.length
      ? '<h2 style="margin:16px 0 4px">В свободное время</h2><p class="muted" style="margin:0 0 8px">Эти задания пока никому не выданы — можно решить заранее.</p>' +
        free.map(function (g) {
          var topic = topicById(g.topicId), n = Math.min(10, g.ids.length), idx = starts.push(g.ids.slice(0, n)) - 1;
          return '<section class="card"><h2>' + esc(topic ? topic.name : g.topicId) + '</h2>' +
            (topic && topic.subject ? '<div class="muted">' + esc(topic.subject) + '</div>' : '') +
            '<div class="muted">Осталось ' + g.ids.length + ' ' + plural(g.ids.length, 'задание', 'задания', 'заданий') + '</div>' +
            '<div class="row"><button data-u="' + idx + '">Решить ' + n + '</button></div></section>';
        }).join('')
      : '';

    view.innerHTML = (days.length ? '' : '<p class="muted">Выданных на ближайшие дни заданий пока нет — они появятся после утренней выдачи или следующей синхронизации.</p>') + days.map(function (d) {
      var byTopic = {}, groups = [];
      d.ids.forEach(function (id) {
        var t = pool[id]; if (!t) return;
        if (!byTopic[t.topicId]) { byTopic[t.topicId] = { topicId: t.topicId, total: 0, left: [] }; groups.push(byTopic[t.topicId]); }
        byTopic[t.topicId].total++;
        if (ans[id] === undefined) byTopic[t.topicId].left.push(id);
      });
      var total = groups.reduce(function (n, g) { return n + g.total; }, 0);
      return '<h2 style="margin:16px 0 8px">' + esc(dayLabel(d.date)) + ' · ' + total + ' ' + plural(total, 'задание', 'задания', 'заданий') + '</h2>' +
        groups.map(function (g) {
          var topic = topicById(g.topicId), idx = starts.push(g.left) - 1;
          return '<section class="card"><h2>' + esc(topic ? topic.name : g.topicId) + '</h2>' +
            (topic && topic.subject ? '<div class="muted">' + esc(topic.subject) + '</div>' : '') +
            '<div class="muted">' + g.total + ' ' + plural(g.total, 'задание', 'задания', 'заданий') + (g.total - g.left.length ? ' · уже решено ' + (g.total - g.left.length) : '') + '</div>' +
            (g.left.length ? '<div class="row"><button data-u="' + idx + '">Решить заранее (' + g.left.length + ')</button></div>' : '') + '</section>';
        }).join('');
    }).join('') + freeHtml;
    Array.prototype.forEach.call(view.querySelectorAll('[data-u]'), function (b) {
      b.onclick = function () { startAssigned(starts[Number(b.getAttribute('data-u'))], 'upcoming'); };
    });
  }

  // ------------------------------------------------------------------ расписание
  function renderSchedule() {
    titleEl.textContent = 'Расписание';
    var weeks = (state.pack && state.pack.weeks) || [];
    if (!weeks.length) {
      view.innerHTML = '<div class="card"><h2>Расписания пока нет</h2><p class="muted">Нажмите «Синхронизировать» при подключении к интернету.</p></div>';
      return;
    }
    var now = today();
    if (state.weekIdx === null || state.weekIdx >= weeks.length) {
      state.weekIdx = 0;
      weeks.forEach(function (w, i) { if (w.days.some(function (d) { return d.date === now; })) state.weekIdx = i; });
    }
    var w = weeks[state.weekIdx];

    var html = '<div class="weeknav"><button id="wp"' + (state.weekIdx === 0 ? ' disabled' : '') + '>‹</button>' +
      '<div class="range">' + esc(w.range) + '</div><button id="wn"' + (state.weekIdx >= weeks.length - 1 ? ' disabled' : '') + '>›</button></div>';

    w.days.forEach(function (d) {
      var isToday = d.date === now;
      html += '<section class="day' + (isToday ? ' today' : '') + '"><h3>' + esc(d.short) + ' ' + esc(d.dayMonth) + (isToday ? ' · сегодня' : '') +
        (d.totalMinutes ? ' <span class="muted">' + esc(duration(d.totalMinutes)) + '</span>' : '') + '</h3>';
      if (!d.items.length) html += '<p class="muted">Занятий нет</p>';
      d.items.forEach(function (it) {
        var loc = it.kind === 'school' ? '🏫 Школа' : it.kind === 'home' ? '🏠 Дома' : it.location;
        html += '<div class="item ' + esc(it.kind) + '"><div class="t">' + esc(it.start + (it.end ? '–' + it.end : '')) + ' · ' + esc(it.label) + '</div>' +
          '<div class="m">' + esc([loc, it.duration ? duration(it.duration) : ''].filter(Boolean).join(' · ')) + '</div>' +
          (it.activity ? '<div class="m">' + esc(it.activity) + '</div>' : '') +
          (it.topic ? '<div class="m">📖 ' + esc(it.topic.name) + '</div>' : '') +
          (it.tasksMode === 'app' ? '<div class="m">📱 Задания в приложении' + (it.autoTopic ? ' · ' + esc(it.autoTopic) : '') + '</div>' : it.tasksMode === 'book' ? '<div class="m">📖 Задания в книжке</div>' : '') +
          '</div>';
      });
      html += '</section>';
    });
    view.innerHTML = html;
    document.getElementById('wp').onclick = function () { state.weekIdx--; renderSchedule(); };
    document.getElementById('wn').onclick = function () { state.weekIdx++; renderSchedule(); };
  }

  function renderPractice() {
    state.session = null;
    titleEl.textContent = 'Тренировка';
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
    if (!topic) return route('practice');
    var tasks = L.pickTasks(topic, state.done, mode);
    if (!tasks.length) return route('practice');
    state.session = { topicId: topicId, tasks: tasks, index: 0, correct: 0, answered: false, back: 'practice' };
    renderTask();
  }

  function startAssigned(taskIds, back) {
    var pool = taskPool(), ans = liveAnswered(), tasks = [];
    taskIds.forEach(function (id) { if (pool[id] && ans[id] === undefined) tasks.push(pool[id]); });
    if (!tasks.length) return route(back);
    state.session = { topicId: tasks[0].topicId, tasks: tasks, index: 0, correct: 0, answered: false, back: back,
      title: back === 'debt' ? 'Нужно выполнить' : back === 'upcoming' ? 'Ближайшие задания' : 'Задания на сегодня' };
    renderTask();
  }

  function renderTask() {
    var s = state.session, task = s.tasks[s.index];
    if (!task || s.index >= s.tasks.length) return renderFinish();
    var topic = topicById(task.topicId || s.topicId);
    s.answered = false;
    document.getElementById('nav').style.display = 'none';
    titleEl.textContent = s.title || (topic ? topic.name : 'Задания');

    var head = '<div class="muted">Задание ' + (s.index + 1) + ' из ' + s.tasks.length + '</div>' +
      '<div class="bar-p"><i style="width:' + Math.round(s.index * 100 / s.tasks.length) + '%"></i></div>' +
      '<div class="q">' + rich(task.q) + '</div>' + figure(task);

    if (task.type === 'choice') {
      view.innerHTML = '<div class="card">' + head + '<div class="opts" id="opts">' +
        task.options.map(function (o, i) { return '<button data-i="' + i + '">' + rich(o) + '</button>'; }).join('') +
        '</div><div id="fb"></div></div><div class="row"><button id="quit">Назад</button></div>';
      Array.prototype.forEach.call(view.querySelectorAll('#opts button'), function (b) {
        b.onclick = function () { answer(task, task.options[Number(b.getAttribute('data-i'))], b); };
      });
    } else {
      view.innerHTML = '<div class="card">' + head +
        '<input type="text" id="ans" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" aria-label="Ответ">' +
        '<div class="row"><button class="primary" id="check">Проверить</button></div><div id="fb"></div></div>' +
        '<div class="row"><button id="quit">Назад</button></div>';
      var input = document.getElementById('ans');
      var go = function () { if (input.value.trim()) answer(task, input.value, null); };
      document.getElementById('check').onclick = go;
      input.onkeydown = function (e) { if (e.key === 'Enter') go(); };
      input.focus();
    }
    document.getElementById('quit').onclick = function () { route(s.back || 'practice'); };
  }

  function answer(task, given, button) {
    var s = state.session;
    if (s.answered) return;
    s.answered = true;

    var ok = L.isCorrect(task.answer, given);
    if (ok) s.correct++;

    var attempt = { attempt_id: L.makeAttemptId(), task_id: task.id, topic_id: task.topicId || s.topicId, answer: String(given), answered_at: new Date().toISOString() };
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
      (ok ? '' : '<div>Правильный ответ: <strong>' + rich(task.answer[0]) + '</strong></div>') +
      (task.explanation ? '<div class="muted" style="margin-top:6px">' + rich(task.explanation) + '</div>' : '') + '</div>' +
      '<div class="row"><button class="primary" id="next">' + (s.index + 1 >= s.tasks.length ? 'Закончить' : 'Дальше') + '</button></div>';
    var next = document.getElementById('next');
    next.onclick = function () { s.index++; renderTask(); };
    next.focus();
  }

  function renderFinish() {
    var s = state.session;
    titleEl.textContent = 'Готово';
    view.innerHTML = '<div class="card"><h2>Молодец!</h2><p>Верно ' + s.correct + ' из ' + s.tasks.length + '.</p>' +
      (state.queued ? '<p class="muted">Ответы сохранены на устройстве и отправятся, когда появится интернет.</p>' : '') +
      '<div class="row"><button class="primary" id="home">Готово</button></div></div>';
    var back = s.back || 'practice';
    state.session = null;
    document.getElementById('home').onclick = function () { route(back); };
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
        route('home');
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
