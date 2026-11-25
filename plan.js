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

    var todayList = [], debtList = [], seen = {}, todayDone = 0, upcoming = [], upcomingByDate = {};

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
        } else if (r.date > input.today) {
          if (!upcomingByDate[r.date]) { upcomingByDate[r.date] = { date: r.date, ids: [] }; upcoming.push(upcomingByDate[r.date]); }
          upcomingByDate[r.date].ids.push(r.taskId);
        }
      });

    var all = { total: 0, answered: 0, correct: 0, today: todayList.length, todayDone: todayDone, debt: debtList.length };
    Object.keys(bySubject).forEach(function (id) {
      all.total += bySubject[id].total; all.answered += bySubject[id].answered; all.correct += bySubject[id].correct;
    });

    return { bySubject: bySubject, all: all, todayList: todayList, debtList: debtList, upcoming: upcoming };
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

  function dynWeekStart(d) {
    var p = d.split('-').map(Number);
    var back = (new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay() + 6) % 7;
    return new Date(Date.UTC(p[0], p[1] - 1, p[2] - back)).toISOString().slice(0, 10);
  }

  function dynAddDays(d, n) {
    var p = d.split('-').map(Number);
    return new Date(Date.UTC(p[0], p[1] - 1, p[2] + n)).toISOString().slice(0, 10);
  }

  function dynEsc(v) {
    return String(v === null || v === undefined ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /** Шаг оси: 1, 2, 5 × 10^k так, чтобы было не больше ~4 делений. */
  function dynNiceStep(max) {
    var raw = Math.max(1, max / 4), pow = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10)), f = raw / pow;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * pow;
  }

  /**
   * Динамика по неделям: сколько ответов дано за неделю, по предметам. Считается КАЖДЫЙ ответ (весь объём работы).
   * Повтор — ответ на задание, на которое уже отвечали раньше (любой исход). Неверный — ok === false.
   * input: { today:'yyyy-MM-dd', weeks:12, log:[{t:taskId, s:subjectId, d:'yyyy-MM-dd', at:ISO, ok:true|false|null}], subjects:[{id,name}] }
   * → { weeks:[{start, all:{sid:n}, wrong:{sid:n}, rep:{sid:n}, total, totalWrong, totalRep, current}], subjects:[{id,name,color}] }
   */
  function weeklyDynamics(input) {
    var n = input.weeks || 12, thisWeek = dynWeekStart(input.today);
    var rows = [];
    (input.log || []).forEach(function (l, k) {
      if (!l || !l.t || !l.s || !l.d) return;
      rows.push({ t: l.t, s: l.s, d: l.d, at: l.at || (l.d + 'T00:00:00.000Z'), ok: l.ok, sec: Number(l.sec) > 0 ? Number(l.sec) : 0, k: k });
    });
    rows.sort(function (a, b) { return a.at < b.at ? -1 : a.at > b.at ? 1 : a.k - b.k; });

    var minWeek = null;
    rows.forEach(function (r) {
      var w = dynWeekStart(r.d);
      if (w <= thisWeek && (minWeek === null || w < minWeek)) minWeek = w;
    });
    if (minWeek === null) return { weeks: [], subjects: [] };

    var from = dynAddDays(thisWeek, -7 * (n - 1));
    if (minWeek > from) from = minWeek;

    var weeks = [], index = {};
    for (var w = from; w <= thisWeek; w = dynAddDays(w, 7)) {
      index[w] = weeks.length;
      weeks.push({ start: w, all: {}, wrong: {}, rep: {}, time: {}, total: 0, totalWrong: 0, totalRep: 0, totalTime: 0, current: w === thisWeek });
    }

    var order = [], names = {}, used = {}, seen = {};
    (input.subjects || []).forEach(function (s) { order.push(s.id); names[s.id] = s.name; });
    rows.forEach(function (r) {
      var repeat = seen[r.t] === true;
      seen[r.t] = true;                                   // повтор определяется по всей истории, даже вне окна
      var wk = index[dynWeekStart(r.d)];
      if (wk === undefined) return;
      var x = weeks[wk];
      x.all[r.s] = (x.all[r.s] || 0) + 1; x.total++;
      if (r.ok === false) { x.wrong[r.s] = (x.wrong[r.s] || 0) + 1; x.totalWrong++; }
      if (repeat) { x.rep[r.s] = (x.rep[r.s] || 0) + 1; x.totalRep++; }
      if (r.sec) x.time[r.s] = (x.time[r.s] || 0) + r.sec;   // секунды; ниже переводятся в минуты
      used[r.s] = true;
      if (order.indexOf(r.s) < 0) order.push(r.s);
    });

    weeks.forEach(function (x) {
      Object.keys(x.time).forEach(function (sid) { x.time[sid] = Math.round(x.time[sid] / 60); x.totalTime += x.time[sid]; });
    });

    var subjects = [];
    order.forEach(function (sid, k) { if (used[sid]) subjects.push({ id: sid, name: names[sid] || sid, color: k % 12 }); });
    return { weeks: weeks, subjects: subjects };
  }

  var DYN_METRICS = { all: 'Total answers', wrong: 'Wrong', rep: 'Repeats', time: 'Time spent (min)' };

  /** Столбчатая диаграмма со стеком: по X недели, по Y ответы. metric: all | wrong | rep; selected — id одного предмета или ''. */
  function dynamicsSvg(model, selected, metric) {
    metric = DYN_METRICS[metric] ? metric : 'all';
    var shown = model.subjects.filter(function (s) { return !selected || s.id === selected; });
    var W = 640, H = 300, L = 40, R = 10, T = 22, B = 34, pw = W - L - R, ph = H - T - B;
    var totals = model.weeks.map(function (w) {
      return shown.reduce(function (n, s) { return n + ((w[metric] || {})[s.id] || 0); }, 0);
    });
    var max = Math.max.apply(null, totals.concat([0]));
    var step = dynNiceStep(max), top = Math.max(step * Math.ceil(max / step), step);
    var y = function (v) { return T + ph - v * ph / top; };

    var out = '<svg class="dynsvg" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + dynEsc(DYN_METRICS[metric]) + ' by week">';
    for (var v = 0; v <= top; v += step) {
      out += '<line class="dgrid" x1="' + L + '" x2="' + (W - R) + '" y1="' + y(v) + '" y2="' + y(v) + '"/>' +
        '<text class="dax" x="' + (L - 6) + '" y="' + (y(v) + 4) + '" text-anchor="end">' + v + '</text>';
    }
    if (max === 0) out += '<text class="dax" x="' + (W / 2) + '" y="' + (T + ph / 2) + '" text-anchor="middle">' + (metric === 'time' ? 'No time recorded yet' : 'No such answers') + '</text>';

    var slot = pw / Math.max(model.weeks.length, 1), bw = Math.min(52, slot * 0.66);
    model.weeks.forEach(function (w, k) {
      var x = L + slot * k + (slot - bw) / 2, acc = 0;
      shown.forEach(function (s) {
        var c = (w[metric] || {})[s.id] || 0;
        if (!c) return;
        var h = c * ph / top;
        out += '<rect class="dc' + s.color + '" x="' + x.toFixed(1) + '" y="' + y(acc + c).toFixed(1) + '" width="' + bw.toFixed(1) +
          '" height="' + h.toFixed(1) + '" rx="2"><title>' + dynEsc(s.name) + ': ' + c + '</title></rect>';
        acc += c;
      });
      if (totals[k] > 0) out += '<text class="dtot" x="' + (x + bw / 2).toFixed(1) + '" y="' + (y(totals[k]) - 5).toFixed(1) + '" text-anchor="middle">' + totals[k] + '</text>';
      var p = w.start.split('-');
      out += '<text class="dax' + (w.current ? ' dnow' : '') + '" x="' + (x + bw / 2).toFixed(1) + '" y="' + (H - 12) + '" text-anchor="middle">' + p[2] + '.' + p[1] + '</text>';
    });
    return out + '</svg>';
  }

  /** Итоги недели по выбранным предметам: { all, wrong, rep, pct (доля неверных, %) }. */
  function dynWeekTotals(model, week, selected) {
    var r = { all: 0, wrong: 0, rep: 0, time: 0, pct: 0 };
    model.subjects.forEach(function (s) {
      if (selected && s.id !== selected) return;
      r.all += week.all[s.id] || 0; r.wrong += week.wrong[s.id] || 0; r.rep += week.rep[s.id] || 0; r.time += (week.time || {})[s.id] || 0;
    });
    r.pct = r.all ? Math.round(r.wrong * 100 / r.all) : 0;
    return r;
  }

  var DYN_COLORS_LIGHT = ['#2f5d9e', '#d9822b', '#2d7a4f', '#b3362d', '#8a5fb0', '#2a9d9d', '#b8921a', '#6b7280', '#d45d8c', '#5b8c2a', '#8c5a3c', '#3b82c4'];
  var DYN_COLORS_DARK = ['#8db4ee', '#f0a65a', '#6cc58f', '#f0877d', '#c3a2e0', '#5fd0d0', '#e0c050', '#a4a9b3', '#f08fb4', '#9cc95a', '#c99a7a', '#7fb5ea'];
  function dynCss() {
    var rule = function (list) { return list.map(function (c, i) { return '.dc' + i + '{fill:' + c + ';background-color:' + c + '}'; }).join(''); };
    return '.dynsvg{width:100%;height:auto;display:block}.dgrid{stroke:var(--line);stroke-width:1}.dax{fill:var(--muted);font-size:14px}' +
      '.dax.dnow{fill:var(--text);font-weight:700}.dtot{fill:var(--text);font-size:14px;font-weight:650}.dynsvg rect{stroke:var(--surface);stroke-width:1}' +
      '.dsw{display:inline-block;width:12px;height:12px;border-radius:3px;flex:none;margin-top:3px}' +
      rule(DYN_COLORS_LIGHT) + '@media (prefers-color-scheme:dark){' + rule(DYN_COLORS_DARK) + '}';
  }


  var api = { planStats: planStats, todayInIstanbul: todayInIstanbul, weeklyDynamics: weeklyDynamics, dynamicsSvg: dynamicsSvg, dynWeekTotals: dynWeekTotals, dynMetrics: DYN_METRICS, dynCss: dynCss };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Plan = api;
})(typeof self !== 'undefined' ? self : this);
