/* plan.js — сводка по заданиям (без DOM). Та же логика, что planStats_ в Plan.gs; tests/plan.test.js сверяет их. */
(function (root) {
  'use strict';

  /** input: { today, tasks:[{id,topicId}], topicSubject:{topicId:subjectId}, plan:[{date,taskId}], answered:{taskId:true|false} } */
  function planStats(input) {
    var topicSubject = input.topicSubject || {};
    var answered = input.answered || {};
    var bySubject = {};
    var slot = function (sid) {
      return bySubject[sid] || (bySubject[sid] = { total: 0, answered: 0, correct: 0, debt: 0, today: 0, todayDone: 0 });
    };
    var taskTopic = {};

    input.tasks.forEach(function (t) {
      taskTopic[t.id] = t.topicId;
      var sid = topicSubject[t.topicId];
      if (!sid) return;
      var s = slot(sid);
      s.total++;
      if (answered[t.id] !== undefined) { s.answered++; if (answered[t.id]) s.correct++; }
    });

    var todayList = [], debtList = [], seen = {}, todayDone = 0;

    input.plan
      .map(function (r, i) { return { r: r, i: i }; })
      .sort(function (a, b) { return a.r.date < b.r.date ? -1 : a.r.date > b.r.date ? 1 : a.i - b.i; })
      .forEach(function (x) {
        var r = x.r;
        if (seen[r.taskId] || taskTopic[r.taskId] === undefined) return;
        seen[r.taskId] = true;
        var sid = topicSubject[taskTopic[r.taskId]];
        var done = answered[r.taskId] !== undefined;

        if (r.date === input.today) {
          todayList.push(r.taskId);
          if (done) todayDone++;
          if (sid) { slot(sid).today++; if (done) slot(sid).todayDone++; }
        } else if (r.date < input.today && !done) {
          debtList.push(r.taskId);
          if (sid) slot(sid).debt++;
        }
      });

    var all = { total: 0, answered: 0, correct: 0, today: todayList.length, todayDone: todayDone, debt: debtList.length };
    Object.keys(bySubject).forEach(function (id) {
      all.total += bySubject[id].total; all.answered += bySubject[id].answered; all.correct += bySubject[id].correct;
    });

    return { bySubject: bySubject, all: all, todayList: todayList, debtList: debtList };
  }

  /** Сегодняшняя дата в Стамбуле («yyyy-MM-dd»); без Intl — по часам устройства. */
  function todayInIstanbul(now) {
    var d = now || new Date();
    try {
      var parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
      if (/^\d{4}-\d{2}-\d{2}$/.test(parts)) return parts;
    } catch (e) { /* ниже */ }
    return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
  }

  var api = { planStats: planStats, todayInIstanbul: todayInIstanbul };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Plan = api;
})(typeof self !== 'undefined' ? self : this);
