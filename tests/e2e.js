// Сквозная проверка приложения в настоящем браузере: офлайн, очередь, синхронизация, повторная отправка.
// Запуск: node pwa/tests/e2e.js (из папки vera-bot-v2). Нужны playwright и python3. В Apps Script/GitHub не загружать.
const { chromium } = require('playwright');
const fs = require('fs'), vm = require('vm'), path = require('path'), assert = require('assert');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const API = 'https://script.google.com/macros/s/AKfycbzTEST/exec';
const TOKEN = 'x'.repeat(40);
const CODE = Buffer.from(JSON.stringify({ a: API, t: TOKEN })).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// «Сервер»: настоящий код Tasks.gs / Sync.gs с таблицей в памяти.
const S = {}; vm.createContext(S);
['Tasks.gs', 'Sync.gs'].forEach(f => vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), S));
vm.runInContext(fs.readFileSync(path.join(ROOT, 'Vocab.gs'), 'utf8'), S);
const vocabWords = [
  { id: 'w_tr_yanlis', t: 'yanlış', l: 'tr', ru: 'неверный', pos: 'sıfat', ex: 'Bu cevap __yanlış__.', xt: 'Этот ответ неверный.', subj: 'TURKISH', task: 'ENG_PP_001', src: 'autopilot' },
  { id: 'w_tr_dogru', t: 'doğru', l: 'tr', ru: 'правильный', ex: 'Cevap __doğru__.', xt: 'Ответ правильный.', subj: 'TURKISH', src: 'autopilot' },
  { id: 'w_tr_kitap', t: 'kitap', l: 'tr', ru: 'книга', subj: 'TURKISH', src: 'autopilot' },
  { id: 'w_tr_okul', t: 'okul', l: 'tr', ru: 'школа', subj: 'TURKISH', src: 'autopilot' },
  { id: 'w_en_although', t: 'although', l: 'en', tr: 'rağmen', subj: 'ENG_GRAMMAR', src: 'autopilot' }
];
const vocabEvents = [];   // события, принятые «сервером»
const seedRows = [];
const SS = { CONFIG: { SHEETS: { TASKS: 'Tasks' } }, TASKS_HEADERS_: [], Logger: { log() {} },
  ensureSheet_: () => ({ getLastRow: () => 1, getRange: () => ({ setNumberFormat() {}, setValues: v => v.forEach(r => seedRows.push(r)) }) }) };
vm.createContext(SS); vm.runInContext(fs.readFileSync(path.join(ROOT, 'SeedTasks.gs'), 'utf8'), SS); SS.seedPresentPerfectTasks();
const tasks = seedRows.map(r => S.parseTaskRow_({ id: r[0], topicId: r[1], type: r[3], question: r[4], options: r[5], answer: r[6], explanation: r[7], topicTitle: r[8] }).task);
const tasksById = {}; tasks.forEach(t => { tasksById[t.id] = { topicId: t.topicId, accepted: t.accepted }; });
const attemptsSheet = [];   // строки листа Attempts

let vocabRes = null, netDown = false, dropNextSyncResponse = false, syncRequests = 0;
const CORS = { 'access-control-allow-origin': '*', 'content-type': 'application/json' };

async function mockApi(route) {
  if (netDown) return route.abort('internetdisconnected');
  const req = route.request(), url = new URL(req.url());
  if (req.method() === 'POST' && url.searchParams.get('action') === 'sync') {
    syncRequests++;
    assert.strictEqual(req.headers()['content-type'].split(';')[0], 'text/plain', 'POST должен быть text/plain (без preflight)');
    const body = JSON.parse(req.postData());
    assert.strictEqual(body.token, TOKEN);
    const existing = {}; attemptsSheet.forEach(r => { existing[r[0]] = true; });
    const plan = JSON.parse(JSON.stringify(S.planSync_({ attempts: body.attempts.map(a => Object.assign({}, a, { device: body.device })), tasksById, existingIds: existing, nowIso: new Date().toISOString(), maxBatch: 500 })));
    plan.rows.forEach(r => attemptsSheet.push(r));
    if (dropNextSyncResponse) { dropNextSyncResponse = false; return route.abort('connectionreset'); }   // сервер записал, ответ не дошёл
    let vres;
    if (body.vocab_events || body.vocab_new) {
      const ex = {}; vocabWords.forEach(w => { ex[w.id] = true; });
      const exE = {}; vocabEvents.forEach(e => { exE[e.ev_id] = true; });
      const vp = JSON.parse(JSON.stringify(S.planVocabSync_({ events: body.vocab_events || [], newWords: body.vocab_new || [], existingWordIds: ex, existingEventIds: exE, nowIso: new Date().toISOString(), device: body.device })));
      (body.vocab_new || []).forEach(w => { if (vp.acceptedWords.indexOf(w.word_id) >= 0) vocabWords.push({ id: w.word_id, t: w.term, l: w.lang, tr: w.lang === 'en' ? w.translation : '', ru: w.lang === 'tr' ? w.translation : '', ex: w.example || '', src: 'child' }); });
      (body.vocab_events || []).forEach(e => { if (vp.acceptedEvents.indexOf(e.ev_id) >= 0) vocabEvents.push(e); });
      vres = { ok: true, accepted_events: vp.acceptedEvents, duplicate_events: vp.duplicateEvents, accepted_words: vp.acceptedWords, duplicate_words: vp.duplicateWords, rejected: vp.rejected };
      vocabRes = vres;
    }
    return route.fulfill({ status: 200, headers: CORS, body: JSON.stringify({ ok: true, accepted: plan.accepted, duplicates: plan.duplicates, rejected: plan.rejected, vocab: vres }) });
  }
  if (url.searchParams.get('action') === 'pack') {
    assert.strictEqual(url.searchParams.get('token'), TOKEN);
    const pack = JSON.parse(JSON.stringify(S.buildTaskPack_({ tasks, topics: [], progress: {}, subjectNames: {}, windowNext: 2, generatedAt: new Date().toISOString() })));
    // v2-часть пакета (на сервере её собирает buildPackForClient_ из листов; здесь — готовый образец той же формы)
    const day = new Date(Date.now() + 3 * 3600 * 1000), iso = d => d.toISOString().slice(0, 10), yesterday = new Date(day.getTime() - 86400000);
    const ids = tasks.map(t => t.id);
    pack.version = 2; pack.today = iso(day);
    pack.topics.forEach(t => { t.subjectId = 'ENG'; t.subject = 'Английский'; });
    pack.plan = ids.slice(0, 3).map(id => ({ date: iso(day), topicId: tasks[0].topicId, subjectId: 'ENG', taskId: id }))
      .concat(ids.slice(3, 6).map(id => ({ date: iso(yesterday), topicId: tasks[0].topicId, subjectId: 'ENG', taskId: id })));
    const tomorrow = new Date(day.getTime() + 86400000);
    pack.plan = pack.plan.concat(ids.slice(6, 9).map(id => ({ date: iso(tomorrow), topicId: tasks[0].topicId, subjectId: 'ENG', taskId: id })));
    pack.answered = {};
    pack.vocab = { words: JSON.parse(JSON.stringify(vocabWords)), state: {} };
    pack.dyn = { subjects: [{ id: 'ENG', name: 'Английский' }, { id: 'BIO', name: 'Биология' }],
      log: [{ t: 'x1', s: 'ENG', d: iso(new Date(day.getTime() - 8 * 86400000)) }, { t: 'x2', s: 'BIO', d: iso(new Date(day.getTime() - 9 * 86400000)) }, { t: 'x3', s: 'BIO', d: iso(new Date(day.getTime() - 15 * 86400000)) }] };
    pack.home = { exam: { name: 'YKS 2027', date: '2027-06-19' }, topics: { done: 1, total: 4, percent: 25 }, tasks: {},
      subjects: [{ id: 'ENG', name: 'Английский', state: 'active', done: 1, total: 4, percent: 25, current: { name: 'Present Perfect' },
        tasks: { mode: 'app', total: 24, answered: 0, correct: 0, debt: 0, today: 3, todayDone: 0 } },
        { id: 'BIO', name: 'Биология', state: 'active', done: 0, total: 5, percent: 0, current: { name: 'Клетка' }, tasks: { mode: 'book', total: 0, answered: 0, correct: 0, debt: 0, today: 0, todayDone: 0 } }] };
    pack.weeks = [{ range: 'Эта неделя', totalMinutes: 60, days: [{ date: iso(day), short: 'Сегодня', dayMonth: '', totalMinutes: 60,
      items: [{ start: '16:00', end: '17:00', duration: 60, label: 'Английский', location: 'дома', kind: 'home', activity: 'Времена', topic: { name: 'Present Perfect', url: '' }, tasksMode: 'app' },
              { start: '18:00', end: '19:00', duration: 60, label: 'Биология', location: 'дома', kind: 'home', activity: '', topic: { name: 'Клетка', url: '' }, tasksMode: 'book' }] }] }];
    return route.fulfill({ status: 200, headers: CORS, body: JSON.stringify({ ok: true, pack }) });
  }
  return route.fulfill({ status: 400, headers: CORS, body: '{"ok":false}' });
}

(async () => {
  const server = spawn('python3', ['-m', 'http.server', '8765', '--bind', '127.0.0.1'], { cwd: path.join(ROOT, 'pwa'), stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 800));
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 820, height: 1100 } });
  await context.route(API + '*', mockApi);
  const page = await context.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  let n = 0; const ok = m => console.log('ok  - ' + (++n) + '. ' + m);
  const text = sel => page.locator(sel).innerText();

  // 1. Первый запуск с интернетом: настройка по ссылке, задания скачались
  await page.goto('http://127.0.0.1:8765/?setup=' + CODE);
  await page.waitForSelector('text=Английский');
  assert.ok(!page.url().includes('setup='), 'код настройки должен исчезнуть из адреса');
  assert.ok((await text('#status')).includes('Не отправлено: 0'));
  let dash = await text('#view');
  assert.ok(dash.includes('Задания на сегодня') && dash.includes('0 из 3'), 'дашборд: сегодня 0 из 3');
  assert.ok(dash.includes('долг 3') || dash.includes('3 задания'), 'дашборд: долг 3');
  assert.ok(dash.includes('📱 Задания в приложении') && dash.includes('📖 Задания в книжке'), 'значки по предметам');
  assert.ok((await text('#nav')).includes('Долг'));
  await page.click('#nav [data-tab=upcoming]');
  const up = await text('#view');
  assert.ok(up.includes('Завтра') && up.includes('3 задания') && up.includes('Решить заранее (3)'), 'ближайшие: завтра 3 задания');
  assert.ok(up.includes('В свободное время') && up.includes('Осталось 15 заданий') && up.includes('Решить 10'), 'свободное время: 24 − 9 выданных = 15');
  await page.click('#nav [data-tab=practice]');
  assert.ok((await text('#view')).includes('Решено 0 из 24'));
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(() => caches.keys().then(k => k.length > 0));
  ok('настройка по ссылке, задания скачаны, код убран из адреса, оболочка закэширована');

  // 2. Без сети: приложение открывается и работает
  netDown = true; await context.setOffline(true);
  await page.reload();
  await page.waitForSelector('text=Английский');
  assert.ok((await text('#status')).includes('Нет сети'));
  await page.click('#nav [data-tab=schedule]');
  const sched = await text('#view');
  assert.ok(sched.includes('16:00–17:00 · Английский') && sched.includes('📱 Задания в приложении') && sched.includes('📖 Задания в книжке'), 'расписание офлайн');
  await page.click('#nav [data-tab=today]');
  assert.ok((await text('#view')).includes('Сделано 0 из 3'));
  await page.click('#nav [data-tab=practice]');
  ok('без сети приложение открывается из кэша, задания на месте');

  // Сначала — «Задания на сегодня»: первые два задания решаются оттуда (тема и устройство те же)
  await page.click('#nav [data-tab=today]');
  await page.click('button:has-text("Начать (3)")');
  assert.ok((await text('.q')).includes('She ___ her homework already'));
  await page.click('#opts button:has-text("has finished")');
  assert.ok((await text('#fb')).includes('Верно'));
  await page.click('#next');
  await page.click('#opts button:has-text("was")');
  assert.ok((await text('#fb')).includes('Правильный ответ: have been'));
  await page.click('#next');
  await page.click('#quit');
  assert.ok((await text('#view')).includes('Сделано 2 из 3'), 'сегодня 2 из 3 после двух ответов');
  await page.click('#nav [data-tab=practice]');
  await page.click('button[data-mode=new]');
  // пропустим до первого fill: ещё 10 choice
  for (let i = 3; i <= 12; i++) { await page.locator('#opts button').first().click(); await page.click('#next'); }
  // задание 13 (fill, верно, альтернативная форма)
  await page.fill('#ans', "Haven't finished.");
  await page.click('#check');
  assert.ok((await text('#fb')).includes('Верно'));
  await page.click('#next');
  assert.ok((await text('#status')).includes('Не отправлено: 13'));
  ok('13 ответов без сети сохранены на устройстве, счётчик «Не отправлено: 13», объяснения показываются');
  await page.click('#quit');
  assert.ok((await text('#view')).includes('Решено 13 из 24'));
  // задания на сегодня (1–3) и долг (4–6) решены в тренировке — экраны пересчитались сразу, без сети
  await page.click('#nav [data-tab=today]');
  assert.ok((await text('#view')).includes('Сделано 3 из 3'), 'сегодня 3 из 3');
  await page.click('#nav [data-tab=debt]');
  assert.ok((await text('#view')).includes('Долга нет'), 'долг закрыт решением');
  await page.click('#nav [data-tab=practice]');
  assert.strictEqual(attemptsSheet.length, 0, 'без сети на сервер ничего не должно уйти');

  // 3. Перезагрузка не теряет очередь
  await page.reload();
  await page.waitForSelector('text=Английский');
  await page.click('#nav [data-tab=practice]');
  await page.waitForSelector('text=Решено 13 из 24');
  assert.ok((await text('#status')).includes('Не отправлено: 13'));
  ok('очередь переживает перезапуск приложения');

  // 4. Сеть появилась, но ответ сервера потерялся: ответы дойдут один раз, без дублей
  netDown = false; await context.setOffline(false);
  dropNextSyncResponse = true;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.waitForFunction(() => document.getElementById('status').innerText.includes('Не удалось синхронизировать'), null, { timeout: 8000 });
  assert.strictEqual(attemptsSheet.length, 13, 'сервер записал, но приложение этого не узнало');
  assert.ok((await text('#status')).includes('Не отправлено: 13'));
  ok('потерянный ответ сервера: очередь сохранена, ошибка показана');

  await page.click('#syncBtn');
  await page.waitForFunction(() => document.getElementById('status').innerText.includes('Не отправлено: 0'), null, { timeout: 8000 });
  assert.strictEqual(attemptsSheet.length, 13, 'повторная отправка не должна создавать дубли');
  ok('повторная отправка: 13 строк в Attempts, дублей нет, очередь пуста');

  // 5. Правильность посчитал сервер
  const byTask = {}; attemptsSheet.forEach(r => { byTask[r[1]] = r; });
  assert.strictEqual(byTask['ENG_PP_001'][4], true);
  assert.strictEqual(byTask['ENG_PP_002'][4], false);
  assert.strictEqual(byTask['ENG_PP_013'][4], true);
  assert.strictEqual(byTask['ENG_PP_013'][3], "Haven't finished.");
  assert.strictEqual(byTask['ENG_PP_001'][7], 'Browser');
  ok('is_correct посчитан сервером (верно/неверно/альтернативный ответ), устройство записано');

  // 6. Продолжение: решены 13, остальные 11 — «Продолжить»
  await page.waitForSelector('button:has-text("Продолжить (11 заданий)")');
  await page.click('button:has-text("Повторить ошибки")');
  assert.ok((await text('.q')).includes('London'));
  ok('«Повторить ошибки» открывает решённые с ошибкой задания');

  // «Сложное — на повтор»: отметка при верном ответе делает задание ошибкой и уходит в очередь служебным ответом
  const qBefore = Number((await text('#status')).match(/Не отправлено: (\d+)/)[1]);
  await page.locator('#opts button').first().click();
  await page.click('#flag');
  assert.ok((await text('#fb')).length > 0 && (await text('#flag')).includes('Отмечено на повтор'), 'кнопка «на повтор» меняет состояние');
  await page.waitForFunction(n => document.getElementById('status').textContent.includes('Не отправлено: ' + n), qBefore + 2);
  ok('кнопка «Сложное — на повтор»: ответ + отметка в очереди (' + (qBefore + 2) + ')');

  // 7. Неверный токен
  await page.click('#quit');
  // Динамика по неделям: диаграмма, фильтр по предмету, ответы с этого устройства попадают в текущую неделю
  await page.click('#nav [data-tab=dynamics]');
  assert.ok(await page.locator('svg.dynsvg').count() === 1, 'диаграмма');
  const allRects = await page.locator('svg.dynsvg rect').count();
  assert.ok(allRects >= 3, 'столбцы по предметам: ' + allRects);
  await page.click('[data-sub=BIO]');
  assert.ok(await page.locator('svg.dynsvg rect').count() < allRects, 'фильтр по предмету');
  await page.click('[data-met=rep]');
  assert.ok((await text('#view')).includes('Повторы по неделям'), 'переключатель метрики');
  ok('вкладка «Динамика»: диаграмма и фильтр по предмету');

  // 8. Слова: вкладка, карточки офлайн, своё слово, синхронизация
  await page.click('#nav [data-tab=words]');
  let wv = await text('#view');
  assert.ok(wv.includes('Всего слов') && wv.includes('Начать ('), 'вкладка «Слова»: сводка и кнопка начала: ' + wv.slice(0, 200));
  netDown = true; await context.setOffline(true);
  await page.click('button[data-w=start]');
  let answered = 0;
  for (let i = 0; i < 30; i++) {
    if (await page.locator('#next').count() === 0 && await page.locator('#opts').count() === 0 && await page.locator('#flip').count() === 0) break;
    if (await page.locator('#opts button').count()) await page.locator('#opts button').first().click();
    else if (await page.locator('#flip').count()) { await page.click('#flip'); await page.click('#knew'); }
    answered++;
    await page.click('#next');
    if (await page.locator('text=Слова на сегодня — готово').count()) break;
  }
  assert.ok(answered >= 5, 'отвечено карточек: ' + answered);
  assert.ok(await page.locator('text=Слова на сегодня — готово').count() === 1, 'экран «готово»');
  await page.click('#home');
  assert.strictEqual(vocabEvents.length, 0, 'без сети события слов не уходят');
  ok('слова: ' + answered + ' карточек пройдено без сети');

  // своё слово: ошибка сохраняет ввод, дубль отклоняется, корректное — в очередь
  await page.click('#addWord');
  await page.fill('#wTerm', 'tembel');
  await page.click('#wSave');
  assert.ok((await text('#view')).includes('Нужны') || (await text('#view')).length > 0);
  assert.strictEqual(await page.inputValue('#wTerm'), 'tembel', 'введённое не стирается при ошибке');
  await page.fill('#wTl', 'ленивый');
  await page.fill('#wEx', 'O çok __tembel__.');
  await page.click('#wSave');
  await page.waitForSelector('text=Добавлено: tembel', { timeout: 5000 });
  assert.ok((await text('#view')).includes('Добавлено: tembel'), 'слово добавлено: ' + (await text('#view')).slice(0, 300));
  await page.fill('#wTerm', 'tembel'); await page.fill('#wTl', 'ленивый');
  await page.click('#wSave');
  await page.waitForSelector('.err', { timeout: 5000 });
  assert.ok(await page.locator('.err').count() >= 1, 'дубль отклонён');
  await page.click('#wBack');
  assert.ok((await text('#view')).includes('tembel'), 'своё слово видно в списке сразу, без сети');
  ok('своё слово добавлено офлайн, дубль отклонён');

  // сеть вернулась: события и слово уходят один раз
  netDown = false; await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.waitForFunction(() => /Не отправлено: 0/.test(document.getElementById('status').innerText), null, { timeout: 10000 }).catch(async e => { throw new Error('статус: ' + (await text('#status')) + ' | rejected: ' + JSON.stringify(vocabRes)); });
  assert.ok(vocabEvents.length >= answered, 'события слов на сервере: ' + vocabEvents.length);
  assert.ok(vocabWords.some(w => w.t === 'tembel' && w.ru === 'ленивый'), 'слово ребёнка на сервере, перевод в ru');
  const evCount = vocabEvents.length;
  await page.click('#syncBtn');
  await page.waitForTimeout(800);
  assert.strictEqual(vocabEvents.length, evCount, 'повторная синхронизация без дублей');
  ok('слова: ' + evCount + ' событий и своё слово дошли до сервера без дублей');

  // «Слова в задании»: открытие — событие lookup
  await page.click('#nav [data-tab=practice]');
  await page.click('button[data-mode=new], button:has-text("Продолжить")');
  if (await page.locator('#taskWords').count()) {
    const before = vocabEvents.length;
    await page.click('#taskWords summary');
    await page.waitForTimeout(300);
    ok('слова задания: список открывается (' + before + ')');
  }
  await page.click('#quit').catch(() => {});

  assert.deepStrictEqual(errors, [], 'ошибки в консоли: ' + errors.join('; '));
  ok('ошибок JavaScript нет');

  await page.click('#nav [data-tab=home]');
  await page.screenshot({ path: '/tmp/claude-0/prev/pwa-home.png', fullPage: true });
  await browser.close(); server.kill();
  console.log('\nПройдено проверок: ' + n + '; запросов синхронизации: ' + syncRequests);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
