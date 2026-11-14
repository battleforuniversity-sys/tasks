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
    return { total: topic.tasks.length, answered: answered, correct: correct, wrong: answered - correct };
  }

  /** mode: 'new' — ещё не решённые; 'wrong' — решённые с ошибкой; 'all' — все. */
  function pickTasks(topic, done, mode) {
    return topic.tasks.filter(function (t) {
      var d = done[t.id];
      if (mode === 'new') return !d;
      if (mode === 'wrong') return d && !d.correct;
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

  var api = { normalizeAnswer: normalizeAnswer, isCorrect: isCorrect, decodeSetupCode: decodeSetupCode,
    topicStats: topicStats, pickTasks: pickTasks, makeAttemptId: makeAttemptId, idsToRemove: idsToRemove };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Logic = api;
})(typeof self !== 'undefined' ? self : this);
