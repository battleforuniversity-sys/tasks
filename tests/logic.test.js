// Запуск: node pwa/tests/logic.test.js (из папки vera-bot-v2)
const assert = require('assert');
const fs = require('fs'), vm = require('vm');
const L = require('../logic.js');

let passed = 0;
const test = (n, f) => { f(); passed++; console.log('ok  -', n); };
const enc = o => Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const API = 'https://script.google.com/macros/s/AKfycbzABC/exec';

test('ответы: как на сервере (регистр, пробелы, кавычки, точка)', () => {
  assert.ok(L.isCorrect(["haven't finished", 'have not finished'], '  Haven’t   Finished. '));
  assert.ok(!L.isCorrect(['went'], ''));
  assert.ok(!L.isCorrect(['went'], 'go'));
});

test('логика сравнения совпадает с серверной (Tasks.gs) на общих примерах', () => {
  const ctx = {}; vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(__dirname + '/../../Tasks.gs', 'utf8'), ctx);
  ['  Haven’t Finished. ', 'HAS  visited!', 'x', '', '   ', "it`s", 'Ё', 'a,b;'].forEach(x => {
    assert.strictEqual(L.normalizeAnswer(x), ctx.normalizeAnswer_(x), JSON.stringify(x));
  });
});

test('код настройки: верный раскодируется, мусор и чужие адреса — нет', () => {
  const tok = 't'.repeat(40);
  assert.deepStrictEqual(L.decodeSetupCode(enc({ a: API, t: tok })), { api: API, token: tok });
  assert.strictEqual(L.decodeSetupCode(enc({ a: 'https://evil.example/exec', t: tok })), null);   // ответы не уйдут на чужой адрес
  assert.strictEqual(L.decodeSetupCode(enc({ a: API.replace('https', 'http'), t: tok })), null);
  assert.strictEqual(L.decodeSetupCode(enc({ a: API, t: 'short' })), null);
  assert.strictEqual(L.decodeSetupCode('!!!'), null);
  assert.strictEqual(L.decodeSetupCode(''), null);
  assert.strictEqual(L.decodeSetupCode(enc({ a: 'https://evil.example/exec', t: tok, allowAnyApi: true })), null);   // обходного флага нет
});

const topic = { tasks: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] };
test('статистика и выбор заданий: новые, ошибки, все', () => {
  const done = { a: { correct: true }, b: { correct: false } };
  assert.deepStrictEqual(L.topicStats(topic, done), { total: 3, answered: 2, correct: 1, wrong: 1 });
  assert.deepStrictEqual(L.pickTasks(topic, done, 'new').map(t => t.id), ['c']);
  assert.deepStrictEqual(L.pickTasks(topic, done, 'wrong').map(t => t.id), ['b']);
  // верный ответ, отмеченный «на повтор», остаётся верным, но попадает в повтор
  const flagged = Object.assign({}, done, { a: { task_id: 'a', correct: true, retry: true } });
  assert.strictEqual(L.topicStats(topic, flagged).correct, 1);
  assert.ok(L.pickTasks(topic, flagged, 'wrong').some(t => t.id === 'a'));
  assert.deepStrictEqual(L.pickTasks(topic, done, 'all').map(t => t.id), ['a', 'b', 'c']);
});

test('что убрать из очереди после ответа сервера', () => {
  assert.deepStrictEqual(L.idsToRemove({ ok: true, accepted: ['1'], duplicates: ['2'], rejected: [{ id: '3', reason: 'x' }] }), ['1', '2', '3']);
  assert.deepStrictEqual(L.idsToRemove({ ok: false, error: 'busy' }), []);   // при ошибке очередь не трогаем
  assert.deepStrictEqual(L.idsToRemove(null), []);
});

test('идентификаторы ответов уникальны и подходят серверу', () => {
  const a = L.makeAttemptId(), b = L.makeAttemptId();
  assert.notStrictEqual(a, b);
  assert.ok(/^[A-Za-z0-9_-]{8,64}$/.test(a));
});

// ------------------------------------------------------------------ словарь
const W = (id, t, l, o) => Object.assign({ id, t, l, tr: '', ru: '', en: '', ex: '', xt: '', task: '', src: 'autopilot' }, o || {});
const words = [
  W('w1', 'yargı', 'tr', { ru: 'суждение', ex: 'Bu __yargı__ doğrudur.', task: 'TR_X_Q01' }),
  W('w2', 'öncül', 'tr', { ru: 'посылка' }),
  W('w3', 'çıkarım', 'tr', { ru: 'вывод' }),
  W('w4', 'varsayım', 'tr', { ru: 'допущение' }),
  W('w5', 'although', 'en', { tr: 'rağmen', ex: '__Although__ it rained, we went.' }),
  W('w6', 'despite', 'en', { tr: 'e rağmen' }),
  W('w7', 'whereas', 'en', { tr: 'oysa', src: 'child' }),
  W('w8', 'hence', 'en', { tr: 'bu nedenle' })
];
const seeded = (seed) => () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };

test('словарь: карточка «слово → перевод» с вариантами из похожих слов', () => {
  const c = L.makeCard(words[0], 'f', words, seeded(7));
  assert.strictEqual(c.prompt, 'yargı'); assert.strictEqual(c.answer, 'суждение');
  assert.strictEqual(c.sentence, 'Bu __yargı__ doğrudur.');
  assert.ok(c.options.length >= 3 && c.options.length <= 4);
  assert.strictEqual(c.options[c.correct], 'суждение');
  c.options.forEach(o => assert.ok(['суждение', 'посылка', 'вывод', 'допущение'].includes(o), 'варианты — русские переводы, не турецкие слова: ' + o));
  assert.strictEqual(new Set(c.options).size, c.options.length);
});

test('словарь: английское слово → перевод по-турецки; обратное направление — слово по переводу', () => {
  const f = L.makeCard(words[4], 'f', words, seeded(3));
  assert.strictEqual(f.answer, 'rağmen');
  f.options.forEach(o => assert.ok(['rağmen', 'e rağmen', 'oysa', 'bu nedenle'].includes(o), o));
  const r = L.makeCard(words[4], 'r', words, seeded(3));
  assert.strictEqual(r.prompt, 'rağmen'); assert.strictEqual(r.answer, 'although'); assert.strictEqual(r.sentence, '');
  r.options.forEach(o => assert.ok(['although', 'despite', 'whereas', 'hence'].includes(o), 'варианты — английские слова: ' + o));
  const t = L.makeCard(words[0], 'r', words, seeded(3));
  assert.strictEqual(t.prompt, 'суждение');
  t.options.forEach(o => assert.ok(['yargı', 'öncül', 'çıkarım', 'varsayım'].includes(o), o));
});

test('словарь: мало слов для вариантов → карточка «переверни»', () => {
  const c = L.makeCard(words[0], 'f', [words[0], words[1]], seeded(1));
  assert.strictEqual(c.options, null);
  assert.strictEqual(c.answer, 'суждение');
});

test('словарь: состав дня — сначала подошедшие по сроку, потом новые (свои слова ребёнка первыми)', () => {
  const states = {
    w1: { b: 2, d: '2026-11-20', n: 2, f: '2026-11-18', lk: 0 },
    w2: { b: 3, d: '2026-11-25', n: 3, f: '2026-11-10', lk: 0 },     // срок не подошёл
    w3: { b: 1, d: '2026-11-21', n: 1, f: '2026-11-19', lk: 0 },
    w8: { b: 0, d: '', n: 0, f: '', lk: 3 }                          // открывал в задании, ещё не отвечал
  };
  const s = L.pickSession(words, states, '2026-11-21', { total: 20, newLimit: 3 });
  assert.deepStrictEqual(s.due.map(w => w.id), ['w1', 'w3']);                    // по сроку, раньше — первым
  assert.deepStrictEqual(s.fresh.map(w => w.id), ['w7', 'w8', 'w4']);            // свой, потом «открывал», потом остальные
  assert.strictEqual(s.dueTotal, 2);
});

test('словарь: лимит новых слов учитывает уже начатые сегодня; общий лимит режет повторения', () => {
  const states = { w1: { b: 1, d: '2026-11-21', n: 1, f: '2026-11-21', lk: 0 }, w2: { b: 1, d: '2026-11-21', n: 1, f: '2026-11-21', lk: 0 } };
  const s = L.pickSession(words, states, '2026-11-21', { total: 20, newLimit: 3 });
  assert.strictEqual(s.fresh.length, 1);                                         // 3 − 2 уже начатых сегодня
  const tight = L.pickSession(words, states, '2026-11-21', { total: 2, newLimit: 5 });
  assert.strictEqual(tight.fresh.length + tight.due.length, 2);
  assert.strictEqual(L.pickSession(words, states, '2026-11-21', { total: 0, newLimit: 5 }).due.length, 0);
});

test('словарь: направление — новое слово «туда», повторения по очереди туда и обратно', () => {
  assert.strictEqual(L.pickDir(null), 'f');
  assert.strictEqual(L.pickDir({ n: 0 }), 'f');
  assert.strictEqual(L.pickDir({ n: 1 }), 'r');
  assert.strictEqual(L.pickDir({ n: 2 }), 'f');
});

test('словарь: своё слово — проверка, дубли, перевод в нужное поле', () => {
  assert.strictEqual(L.validateNewWord({ lang: '', term: 'a', translation: 'b' }, []).ok, false);
  assert.strictEqual(L.validateNewWord({ lang: 'tr', term: ' ', translation: 'b' }, []).ok, false);
  assert.match(L.validateNewWord({ lang: 'en', term: 'x', translation: '' }, []).error, /Turkish/);
  assert.match(L.validateNewWord({ lang: 'tr', term: 'x', translation: '' }, []).error, /Russian/);
  const tr = L.validateNewWord({ lang: 'tr', term: '  kelime ', translation: 'слово', example: 'Bu bir __kelime__.' }, words);
  assert.ok(tr.ok); assert.strictEqual(tr.word.t, 'kelime'); assert.strictEqual(tr.word.ru, 'слово'); assert.strictEqual(tr.word.src, 'child');
  assert.ok(/^c_[0-9a-f]{22}$/.test(tr.word.id));
  const en = L.validateNewWord({ lang: 'en', term: 'rather', translation: 'oldukça' }, words);
  assert.strictEqual(en.word.tr, 'oldukça'); assert.strictEqual(en.word.ru, '');
  const dup = L.validateNewWord({ lang: 'en', term: 'ALTHOUGH', translation: 'x' }, words);
  assert.strictEqual(dup.ok, false); assert.strictEqual(dup.duplicate.id, 'w5');
  assert.ok(L.validateNewWord({ lang: 'tr', term: 'although', translation: 'x' }, words).ok, 'одинаковое написание в другом языке — другое слово');
});

test('словарь: слова задания, сводка, склейка состояний и списков', () => {
  assert.deepStrictEqual(L.wordsForTask(words, 'TR_X_Q01').map(w => w.id), ['w1']);
  const st = { w1: { b: 4, d: '2026-12-01', n: 5 }, w2: { b: 2, d: '2026-11-20', n: 2 } };
  assert.deepStrictEqual(L.vocabStats(words.slice(0, 3), st, '2026-11-21'), { total: 3, fresh: 1, learning: 1, known: 1, due: 1 });
  assert.strictEqual(L.newerState({ at: '2026-11-21T10:00:00Z', b: 2 }, { at: '2026-11-21T11:00:00Z', b: 3 }).b, 3);
  assert.strictEqual(L.newerState(null, { b: 1 }).b, 1);
  assert.deepStrictEqual(L.poolWords([words[0]], [words[0], words[1]]).map(w => w.id), ['w1', 'w2']);
  assert.deepStrictEqual(L.translations(words[0]), ['суждение']);
  assert.deepStrictEqual(L.translations(W('x', 'a', 'en', { tr: 'b', ru: 'в' })), ['b', 'в']);
});

test('слова: сколько дней подряд пропущено (сегодня не считается, нет ответов — null)', () => {
  const L = require('../logic.js');
  assert.strictEqual(L.wordsMissedDays('2026-11-21', []), null);
  assert.strictEqual(L.wordsMissedDays('2026-11-21', ['2026-11-21']), 0, 'сегодня сделано');
  assert.strictEqual(L.wordsMissedDays('2026-11-21', ['2026-11-20']), 0, 'вчера делали, сегодня ещё идёт');
  assert.strictEqual(L.wordsMissedDays('2026-11-21', ['2026-11-18', '2026-11-10']), 2, 'пропущены 19 и 20');
  assert.strictEqual(L.wordsMissedDays('2026-11-21', ['2026-11-18', '2026-11-25']), 2, 'даты из будущего игнорируются');
  assert.strictEqual(L.wordsMissedDays('2026-12-02', ['2026-11-28']), 3, 'через границу месяца');
});

console.log('\nПройдено тестов: ' + passed);
