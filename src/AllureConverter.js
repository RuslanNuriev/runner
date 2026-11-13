const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Длительность шагов в cucumber JSON приходит в наносекундах
const NS_TO_MS = 1e-6;
const FRAMEWORK = 'cucumber-js';

const md5 = text => crypto.createHash('md5').update(text).digest('hex');

const sleep = ms => new Promise((resolve) => { setTimeout(resolve, ms); });

const firstLine = (text) => {
  const line = String(text || '').split('\n').find(l => l.trim() !== '') || '';
  return line.trim().slice(0, 1000);
};

const stepStatus = (status) => {
  switch (status) {
    case 'passed':
      return 'passed';
    case 'failed':
      return 'failed';
    case 'skipped':
      return 'skipped';
    default:
      // undefined, pending, ambiguous и т.д.
      return 'broken';
  }
};

const testStatus = (steps) => {
  if (steps.some(s => s.status === 'failed')) {
    return 'failed';
  }
  if (steps.some(s => s.status === 'broken')) {
    return 'broken';
  }
  if (steps.length > 0 && steps.every(s => s.status === 'skipped')) {
    return 'skipped';
  }
  return 'passed';
};

/**
 * Собирает объект результата в формате Allure (без записи на диск).
 * @param {Object} p
 * @param {string|number} p.allureId id кейса в ТестОпс (label AS_ID)
 * @param {string} p.title название кейса, оно же fullName автотеста
 * @param {Object} [p.element] элемент cucumber JSON (если результата нет, не передается)
 * @param {number} [p.startedAt] время старта, мс
 * @param {number} [p.stoppedAt] время завершения, мс
 * @param {string} [p.message] причина для результата без элемента
 * @param {string} [p.status] статус для результата без элемента (по умолчанию broken)
 * @returns {{uuid: string, result: Object}}
 */
function buildResult(p) {
  const uuid = crypto.randomUUID();
  const start = p.startedAt || Date.now();
  let cursor = start;
  let steps = [];
  let status;
  let details;

  if (p.element) {
    steps = (p.element.steps || []).map((s) => {
      const r = s.result || {};
      const duration = Math.max(0, Math.round((r.duration || 0) * NS_TO_MS));
      const step = {
        name: `${s.keyword || ''}${s.name || ''}`.trim() || 'Шаг',
        status: stepStatus(r.status),
        stage: 'finished',
        start: cursor,
        stop: cursor + duration,
      };
      if (r.error_message) {
        step.statusDetails = { message: firstLine(r.error_message), trace: String(r.error_message) };
      } else if (step.status === 'broken') {
        step.statusDetails = { message: `Статус шага: ${r.status}` };
      }
      cursor += duration;
      return step;
    });
    status = testStatus(steps);
    const bad = steps.find(s => s.status === 'failed') || steps.find(s => s.status === 'broken');
    if (bad) {
      details = bad.statusDetails
        ? { ...bad.statusDetails }
        : { message: `Шаг «${bad.name}» не выполнен (${bad.status})` };
      // Упавший предтест репортится на основной тест, подсветим это в сообщении
      if (p.element.name && p.element.name !== p.title) {
        details.message = `Предтест «${p.element.name}»: ${details.message}`;
      }
    }
  } else {
    status = p.status || 'broken';
    details = { message: p.message || 'Результат теста не получен' };
  }

  const result = {
    uuid,
    historyId: md5(p.title),
    testCaseId: md5(p.title),
    fullName: p.title,
    name: p.title,
    status,
    stage: 'finished',
    start,
    stop: Math.max(p.stoppedAt || cursor, cursor),
    steps,
    labels: [
      { name: 'AS_ID', value: String(p.allureId) },
      { name: 'framework', value: FRAMEWORK },
      { name: 'language', value: 'javascript' },
    ],
  };
  if (details) {
    result.statusDetails = details;
  }
  return { uuid, result };
}

// Временные файлы лежат уровнем выше каталога результатов (на той же файловой системе),
// чтобы allurectl watch никогда не увидел недописанный файл
const tmpPath = (dir, name) => path.join(path.dirname(dir), `.tmp-${crypto.randomUUID()}-${name}`);

function writeAtomic(dir, name, data) {
  const tmp = tmpPath(dir, name);
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, path.join(dir, name));
}

function copyAtomic(dir, name, source) {
  const tmp = tmpPath(dir, name);
  fs.copyFileSync(source, tmp);
  fs.renameSync(tmp, path.join(dir, name));
}

/**
 * Записывает результат теста (и скриншот, если он есть) в каталог allure-results.
 * Файл результата появляется последним, после вложений.
 * Синхронный вариант без паузы: подходит для результатов без вложений.
 * @param {string} dir каталог результатов
 * @param {Object} p параметры, см. buildResult, плюс screenshot (путь к png)
 * @returns {Object} записанный результат
 */
function writeAllureResult(dir, p) {
  const target = path.resolve(dir);
  fs.mkdirSync(target, { recursive: true });
  const { uuid, result } = buildResult(p);
  if (p.screenshot && fs.existsSync(p.screenshot)) {
    const source = `${uuid}-attachment.png`;
    copyAtomic(target, source, p.screenshot);
    result.attachments = [{ name: 'Скриншот', source, type: 'image/png' }];
  }
  writeAtomic(target, `${uuid}-result.json`, JSON.stringify(result, null, 2));
  return result;
}

/**
 * То же, что writeAllureResult, но между записью вложения и записью result.json
 * выдерживается пауза. allurectl watch загружает вложение и результат отдельными запросами,
 * и если результат доходит до ТестОпс раньше вложения, в отчете показывается "Вложение удалено".
 * Пауза делается только когда вложение действительно записано.
 * @param {string} dir каталог результатов
 * @param {Object} p параметры, см. writeAllureResult
 * @param {number} delayMs пауза между вложением и result.json, мс
 * @returns {Promise<Object>} записанный результат
 */
async function writeAllureResultDelayed(dir, p, delayMs) {
  const target = path.resolve(dir);
  fs.mkdirSync(target, { recursive: true });
  const { uuid, result } = buildResult(p);
  if (p.screenshot && fs.existsSync(p.screenshot)) {
    const source = `${uuid}-attachment.png`;
    copyAtomic(target, source, p.screenshot);
    result.attachments = [{ name: 'Скриншот', source, type: 'image/png' }];
    if (delayMs > 0) {
      await sleep(delayMs);
    }
  }
  writeAtomic(target, `${uuid}-result.json`, JSON.stringify(result, null, 2));
  return result;
}

module.exports = { buildResult, writeAllureResult, writeAllureResultDelayed };