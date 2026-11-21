/* logic.js — чистая логика приложения (без DOM), тестируется в Node: pwa/tests/logic.test.js */
(function (root) {
  'use strict';

  /** Приведение ответа к сравнимому виду. Должно совпадать с normalizeAnswer_ в Tasks.gs. */
  function normalizeAnswer(value) {
    return String(value === null || value === undefined ? '' : value)
      .normalize('NFC').toLowerCase()
      .replace(/[‘’´`]/g, "'")
      .replace(/\s+/g, ' ').trim()
      .replace(/[.!?,;:]+$/, '').trim();
  }

  function isCorrect(accepted, given) {
    var g = normalizeAnswer(given);
    if (!g) return false;
    return accepted.some(function (a) { return normalizeAnswer(a) === g; });
  }

  /** Код настройки (base64url от {a: адрес API, t: токен}) → {api, token} или null. */
  function decodeSetupCode(code) {
    try {
      var b64 = String(code || '').trim().replace(/-/g, '+').replace(/_/g, '/');
      while (b64.length % 4) b64 += '=';
      var bin = typeof atob === 'function' ? atob(b64) : Buffer.from(b64, 'base64').toString('binary');
      var json = decodeURIComponent(bin.split('').map(function (c) {
        return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
      }).join(''));
      var obj = JSON.parse(json);
      if (!obj || typeof obj.a !== 'string' || typeof obj.t !== 'string') return null;
      if (!/^https:\/\/script\.google\.com\/(a\/[^/]+\/)?macros\/s\/[^/\s]+\/exec$/.test(obj.a)) return null;
      if (obj.t.length < 24) return null;
      return { api: obj.a, token: obj.t };
    } catch (e) {
      return null;
    }
  }

  /** done: {task_id: {correct, at}}. */
  function topicStats(topic, done) {
    var answered = 0, correct = 0;
    topic.tasks.forEach(function (t) {
      var d = done[t.id];
      if (d) { answered++; if (d.correct) correct++; }
    });
    var retry = 0;
    topic.tasks.forEach(function (t) { var d = done[t.id]; if (d && d.correct && d.retry) retry++; });
    return { total: topic.tasks.length, answered: answered, correct: correct, wrong: answered - correct + retry };
  }

  /** mode: 'new' — ещё не решённые; 'wrong' — решённые с ошибкой; 'all' — все. */
  function pickTasks(topic, done, mode) {
    return topic.tasks.filter(function (t) {
      var d = done[t.id];
      if (mode === 'new') return !d;
      if (mode === 'wrong') return d && (!d.correct || d.retry);
      return true;
    });
  }

  function makeAttemptId() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID().replace(/-/g, '');
    var s = '';
    while (s.length < 32) s += Math.floor(Math.random() * 16).toString(16);
    return s;
  }

  /** Разбор ответа сервера на синхронизацию → какие id убрать из очереди. */
  function idsToRemove(response) {
    if (!response || response.ok !== true) return [];
    var ids = [];
    (response.accepted || []).forEach(function (x) { ids.push(x); });
    (response.duplicates || []).forEach(function (x) { ids.push(x); });
    (response.rejected || []).forEach(function (x) { if (x && x.id) ids.push(x.id); });
    return ids;
  }


  // ------------------------------------------------------------------ словарь
  // Состояние слова: {b: ящик 0–5, d: срок 'yyyy-MM-dd', n: ответов, ok, bad, lk: открытий, f: день первого ответа, at}.
  // srsApply ДОЛЖЕН совпадать с applyVocabEvent_ в Vocab.gs (тест tests/vocab.test.js сравнивает их).
  var BOX_DAYS = { 1: 1, 2: 2, 3: 4, 4: 8, 5: 16 };

  /** Дата по Стамбулу (yyyy-MM-dd) для момента времени в ISO. */
  function dayOf(iso) { return new Date(Date.parse(iso) + 3 * 3600 * 1000).toISOString().slice(0, 10); }
  function addDays(day, n) {
    var p = day.split('-').map(Number);
    return new Date(Date.UTC(p[0], p[1] - 1, p[2] + n)).toISOString().slice(0, 10);
  }

  function srsApply(state, ev) {
    var s = { b: 0, d: '', n: 0, ok: 0, bad: 0, lk: 0, f: '', at: '' };
    if (state) Object.keys(state).forEach(function (k) { s[k] = state[k]; });
    var day = dayOf(ev.at);
    if (ev.kind === 'lookup') {
      s.lk++;
      if (s.b > 0) {
        s.b = Math.min(s.b, 2);
        var tomorrow = addDays(day, 1);
        s.d = !s.d || s.d > tomorrow ? tomorrow : s.d;
      }
    } else {
      s.n++;
      if (!s.f) s.f = day;
      if (ev.ok) { s.ok++; s.b = Math.min(5, s.b + 1); s.d = addDays(day, BOX_DAYS[s.b]); }
      else { s.bad++; s.b = 1; s.d = day; }
    }
    s.at = ev.at;
    return s;
  }

  /** Два состояния одного слова (с сервера и локальное): берём то, где последнее событие позже. */
  function newerState(a, b) {
    if (!a) return b || null;
    if (!b) return a;
    return String(b.at || '') > String(a.at || '') ? b : a;
  }

  /** Слова с сервера + слова ребёнка, ещё не подтверждённые сервером; без повторов по id. */
  function poolWords(serverWords, localNew) {
    var seen = {}, out = [];
    (serverWords || []).concat(localNew || []).forEach(function (w) {
      if (w && w.id && !seen[w.id]) { seen[w.id] = true; out.push(w); }
    });
    return out;
  }

  /** Перевод слова для показа: турецкое → по-русски (и по-английски), английское → по-турецки (и по-русски). */
  function translations(w) {
    var list = w.l === 'tr' ? [w.ru, w.en] : [w.tr, w.ru];
    return list.filter(Boolean);
  }
  function answerSide(w) { return translations(w)[0] || ''; }
  function answerLangOf(w) { return w.l === 'tr' ? (w.ru ? 'ru' : 'en') : (w.tr ? 'tr' : 'ru'); }

  /**
   * Состав ежедневного блока «Слова»: сначала слова, у которых подошёл срок (ящик ≥ 1), потом новые.
   * opts: {total: всего карточек, newLimit: новых в день, today}. Новые: сначала свои слова ребёнка, потом те, что открывал в заданиях.
   */
  function pickSession(words, states, today, opts) {
    opts = opts || {};
    var total = opts.total === undefined ? 20 : opts.total, newLimit = opts.newLimit === undefined ? 5 : opts.newLimit;
    var startedToday = 0, due = [], fresh = [];
    words.forEach(function (w) {
      var s = states[w.id];
      if (s && s.n > 0) {
        if (s.f === today) startedToday++;
        if (s.b >= 1 && s.d && s.d <= today) due.push(w);
      } else fresh.push(w);
    });
    due.sort(function (a, b) {
      var sa = states[a.id], sb = states[b.id];
      return sa.d < sb.d ? -1 : sa.d > sb.d ? 1 : sa.b - sb.b;
    });
    fresh.sort(function (a, b) {
      var ca = a.src === 'child' ? 1 : 0, cb = b.src === 'child' ? 1 : 0;
      if (ca !== cb) return cb - ca;
      var la = (states[a.id] && states[a.id].lk) || 0, lb = (states[b.id] && states[b.id].lk) || 0;
      return lb - la;
    });
    var freshN = Math.max(0, Math.min(newLimit - startedToday, fresh.length, total));
    var dueN = Math.min(due.length, total - freshN);
    return { due: due.slice(0, dueN), fresh: fresh.slice(0, freshN), dueTotal: due.length, freshTotal: fresh.length };
  }

  function shuffle(arr, rnd) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor((rnd || Math.random)() * (i + 1)), t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  /**
   * Карточка. dir 'f': слово → перевод (в предложении из задания), 'r': перевод → слово.
   * Возвращает {wordId, dir, prompt, sentence, answer, options|null, correct}; options = null, если мало слов для вариантов (карточка «переверни»).
   */
  function makeCard(w, dir, pool, rnd) {
    var forward = dir !== 'r';
    var answer = forward ? answerSide(w) : w.t;
    var norm = function (x) { return normalizeAnswer(x); };
    var others = pool.filter(function (o) { return o.id !== w.id; });
    var cands = forward
      ? others.map(function (o) { return answerLangOf(o) === answerLangOf(w) ? answerSide(o) : ''; })
      : others.map(function (o) { return o.l === w.l ? o.t : ''; });
    var seen = {}; seen[norm(answer)] = true;
    var uniq = [];
    cands.forEach(function (x) { if (x && !seen[norm(x)]) { seen[norm(x)] = true; uniq.push(x); } });
    var picks = shuffle(uniq, rnd).slice(0, 3);
    var options = picks.length >= 2 ? shuffle(picks.concat([answer]), rnd) : null;
    return { wordId: w.id, dir: forward ? 'f' : 'r', prompt: forward ? w.t : answerSide(w), promptLang: forward ? w.l : (w.l === 'tr' ? answerLangOf(w) : 'tr'),
      sentence: forward ? (w.ex || '') : '', answer: answer, options: options, correct: options ? options.indexOf(answer) : -1 };
  }

  /** Направление карточки: новое слово — «слово → перевод»; повторение — по очереди туда и обратно. */
  function pickDir(state) { return state && state.n > 0 && state.n % 2 === 1 ? 'r' : 'f'; }

  /** Проверка слова, которое ребёнок добавляет сам. Возвращает {ok, error} или {ok, word}. */
  function validateNewWord(input, existing) {
    var clean = function (v, max) { return String(v === null || v === undefined ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max); };
    var lang = input.lang === 'en' ? 'en' : input.lang === 'tr' ? 'tr' : '';
    var term = clean(input.term, 80), tl = clean(input.translation, 120), example = clean(input.example, 300);
    if (!lang) return { ok: false, error: 'Выберите язык слова' };
    if (!term) return { ok: false, error: 'Впишите слово' };
    if (!tl) return { ok: false, error: lang === 'tr' ? 'Впишите перевод по-русски' : 'Впишите перевод по-турецки' };
    var dup = (existing || []).filter(function (w) { return w.l === lang && normalizeAnswer(w.t) === normalizeAnswer(term); })[0];
    if (dup) return { ok: false, error: 'Такое слово уже есть', duplicate: dup };
    var hex = makeAttemptId().slice(0, 22);
    var word = { id: 'c_' + hex, t: term, l: lang, tr: lang === 'en' ? tl : '', ru: lang === 'tr' ? tl : '', en: '', pos: '',
      ex: example, xt: '', subj: '', task: '', src: 'child' };
    return { ok: true, word: word };
  }

  /** Сводка по словарю. */
  function vocabStats(words, states, today) {
    var s = { total: words.length, fresh: 0, learning: 0, known: 0, due: 0 };
    words.forEach(function (w) {
      var st = states[w.id];
      if (!st || !st.n) { s.fresh++; return; }
      if (st.b >= 4) s.known++; else s.learning++;
      if (st.d && st.d <= today) s.due++;
    });
    return s;
  }

  /** Понедельник недели для даты «yyyy-MM-dd». */
  function weekStartOf(day) {
    var p = day.split('-').map(Number);
    var dow = (new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay() + 6) % 7;
    return addDays(day, -dow);
  }

  /**
   * Слова по неделям, отдельно турецкие (tr) и английские (en). ДОЛЖНА совпадать с weeklyVocabDynamics_ в Vocab.gs.
   * input: { today, weeks, days:[{d,l,r,ok,lk}], firsts:[{d,l}] } → { weeks:[{start,current,tr,en,all:{r,ok,fresh,lk}}] }
   */
  function weeklyVocab(input) {
    var n = input.weeks || 12, thisWeek = weekStartOf(input.today);
    var valid = function (x) { return x && x.d && (x.l === 'tr' || x.l === 'en'); };
    var minWeek = null;
    (input.days || []).concat(input.firsts || []).forEach(function (x) {
      if (!valid(x)) return;
      var w = weekStartOf(x.d);
      if (w <= thisWeek && (minWeek === null || w < minWeek)) minWeek = w;
    });
    if (minWeek === null) return { weeks: [] };
    var from = addDays(thisWeek, -7 * (n - 1));
    if (minWeek > from) from = minWeek;
    var mk = function () { return { r: 0, ok: 0, fresh: 0, lk: 0 }; };
    var weeks = [], index = {};
    for (var w = from; w <= thisWeek; w = addDays(w, 7)) {
      index[w] = weeks.length;
      weeks.push({ start: w, current: w === thisWeek, tr: mk(), en: mk(), all: mk() });
    }
    (input.days || []).forEach(function (x) {
      if (!valid(x)) return;
      var wk = index[weekStartOf(x.d)];
      if (wk === undefined) return;
      [weeks[wk][x.l], weeks[wk].all].forEach(function (t) { t.r += x.r || 0; t.ok += x.ok || 0; t.lk += x.lk || 0; });
    });
    (input.firsts || []).forEach(function (x) {
      if (!valid(x)) return;
      var wk = index[weekStartOf(x.d)];
      if (wk === undefined) return;
      weeks[wk][x.l].fresh++; weeks[wk].all.fresh++;
    });
    return { weeks: weeks };
  }

  /**
   * Сколько полных дней подряд (до вчера включительно) слова не делали. null — слова ещё ни разу не начинали.
   * activeDates — даты «yyyy-MM-dd», в которые был хотя бы один ответ на карточку; сегодняшний день ещё идёт и пропуском не считается.
   */
  function wordsMissedDays(today, activeDates) {
    var last = '';
    (activeDates || []).forEach(function (d) { if (d <= today && d > last) last = d; });
    if (!last) return null;
    if (last === today) return 0;
    var n = 0, d = addDays(today, -1);
    while (d > last) { n++; d = addDays(d, -1); }
    return n;
  }

  /** Состояние + слова → сводка по языку (lang: '' — все): {total, fresh, learning, known, due}. */
  function vocabStatsLang(words, states, today, lang) {
    return vocabStats((words || []).filter(function (w) { return !lang || w.l === lang; }), states, today);
  }

  function wordsForTask(words, taskId) {
    return words.filter(function (w) { return w.task === taskId; });
  }

  var api = { normalizeAnswer: normalizeAnswer, isCorrect: isCorrect, decodeSetupCode: decodeSetupCode,
    topicStats: topicStats, pickTasks: pickTasks, makeAttemptId: makeAttemptId, idsToRemove: idsToRemove,
    srsApply: srsApply, newerState: newerState, poolWords: poolWords, translations: translations, answerSide: answerSide, pickSession: pickSession,
    makeCard: makeCard, pickDir: pickDir, shuffle: shuffle, validateNewWord: validateNewWord, vocabStats: vocabStats, wordsForTask: wordsForTask,
    dayOf: dayOf, addDays: addDays, weeklyVocab: weeklyVocab, weekStartOf: weekStartOf, vocabStatsLang: vocabStatsLang, wordsMissedDays: wordsMissedDays };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Logic = api;
})(typeof self !== 'undefined' ? self : this);
