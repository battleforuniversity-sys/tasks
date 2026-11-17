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

console.log('\nПройдено тестов: ' + passed);
