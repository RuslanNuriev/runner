const express = require('express');
const fs = require('fs');
const path = require('path');
const { cwd } = require('process');
const TestManager = require('../src/TestManager');
const browserConveers = require('../src/ConveerStart');
const runLock = require('../src/RunLock');
const { writeAllureResult } = require('../src/AllureConverter');

const router = express.Router();

// Состояние запусков хранится только в памяти. Ключ: launchId
const runs = new Map();
const MAX_RUNS_IN_MEMORY = 50;

// Каталоги с результатами Allure допускаются только внутри этого корня
// (он должен быть примонтирован и в контейнер раннера, и в джобу диспетчера по одному и тому же пути)
const ALLURE_ROOT = path.resolve(process.env.ALLURE_DATA_DIR || '/allure-data');

// Если диспетчер не опрашивал статус дольше этого времени (job отменена или упала),
// запуск останавливается, а контейнеры освобождаются
const WATCHDOG_MS = (Number(process.env.WATCHDOG_SECONDS) || 300) * 1000;
const WATCHDOG_TICK_MS = Math.min(WATCHDOG_MS, 30000);

const PASSED = 1;
const FAILED = 5;

const runKey = launchId => `testops-${launchId}`;

const writeFailLog = (prefix, e) => {
  try {
    const dir = `${cwd()}/reports`;
    fs.mkdirSync(dir, { recursive: true });
    const stack = e.stack || '';
    fs.writeFileSync(`${dir}/${prefix}${Date.now()}.log`, `${e.toString()}\n\n\n${stack.toString()}`);
  } catch (err) {
    console.error('[testops] не удалось записать лог ошибки', err);
  }
};

const pruneRuns = () => {
  while (runs.size > MAX_RUNS_IN_MEMORY) {
    const oldest = runs.keys().next().value;
    runs.delete(oldest);
  }
};

const toStatusName = (statusId) => {
  if (statusId === PASSED) {
    return 'passed';
  }
  if (statusId === FAILED) {
    return 'failed';
  }
  return 'other';
};

// Собирает по каждому тесту статус: passed / failed / other / no_result
// no_result: результата нет (пока выполняется) или он потерян (тест упал без report.json)
const buildTests = st => st.tests.map((t) => {
  const r = st.results[t.id];
  return {
    id: t.id,
    title: t.title,
    image: t.image || null,
    status: r ? r.status : 'no_result',
    elapsed: r ? r.elapsed : null,
    message: r && r.message ? r.message : null,
  };
});

const publicView = (st) => {
  const tests = buildTests(st);
  const count = status => tests.filter(t => t.status === status).length;
  const passed = count('passed');
  return {
    launchId: st.launchId,
    state: st.state,
    browser: st.browser,
    nodeEnv: st.nodeEnv,
    startedAt: st.startedAt,
    finishedAt: st.finishedAt || null,
    error: st.error || null,
    total: st.tests.length,
    reported: Object.keys(st.results).length,
    passed,
    failed: count('failed'),
    other: count('other'),
    noResult: count('no_result'),
    allureErrors: st.allureErrors,
    ok: st.state === 'finished' && passed === st.tests.length && st.allureErrors === 0,
    tests,
  };
};

// Записывает результат теста в каталог Allure (если он задан для запуска)
const writeResult = (st, test, extra) => {
  if (!st.allureDir) {
    return;
  }
  try {
    const now = Date.now();
    writeAllureResult(st.allureDir, {
      allureId: test.id,
      title: test.title,
      startedAt: now,
      stoppedAt: now,
      ...extra,
    });
  } catch (e) {
    st.allureErrors += 1;
    console.error(`[testops] ${st.key} не удалось записать результат Allure для теста ${test.id}`, e);
  }
};

// Тесты без результата получают в ТестОпс статус broken, чтобы они не пропадали из лаунча
const writeMissingResults = (st, reason) => {
  st.tests.forEach((t) => {
    if (!st.results[t.id]) {
      writeResult(st, t, { message: reason });
    }
  });
};

const finishRun = (st, state, errorText) => {
  if (st.state !== 'running') {
    return;
  }
  if (state === 'finished' || state === 'error') {
    writeMissingResults(st, errorText || 'Результат теста не получен: контейнер завершился без отчета (см. ProjectFail*.log и логи раннера)');
  }
  st.state = state;
  st.finishedAt = new Date().toISOString();
  if (errorText) {
    st.error = errorText;
  }
  runLock.release('testops', st.key);
  const v = publicView(st);
  console.log(`[testops] ${st.key} ${state}: passed=${v.passed} failed=${v.failed} other=${v.other} noResult=${v.noResult} allureErrors=${v.allureErrors} из ${v.total}`);
};

// Тесты без результата помечаются статусом skipped. Результаты кладутся в соседний каталог
// <dir>-aborted, чтобы их мог загрузить отдельный шаг (after_script), не дублируя уже загруженное
const writeAbortedResults = (st, reason) => {
  if (!st.allureDir) {
    return 0;
  }
  const abortedDir = `${st.allureDir}-aborted`;
  let count = 0;
  st.tests.forEach((t) => {
    if (st.results[t.id]) {
      return;
    }
    try {
      const now = Date.now();
      writeAllureResult(abortedDir, {
        allureId: t.id,
        title: t.title,
        startedAt: now,
        stoppedAt: now,
        status: 'skipped',
        message: `Запуск прерван: ${reason}`,
      });
      count += 1;
    } catch (e) {
      st.allureErrors += 1;
      console.error(`[testops] ${st.key} не удалось записать прерванный результат для теста ${t.id}`, e);
    }
  });
  return count;
};

// Останавливает запуск: сбрасывает очереди, останавливает контейнеры, освобождает замок
const stopRun = (st, reason) => {
  if (st.state !== 'running') {
    return 0;
  }
  try {
    Object.values(browserConveers).forEach((conveer) => {
      conveer.removeQueue(st.key);
      conveer.getRunned().forEach((task) => {
        if (task.testProject.getRunId() === st.key) {
          task.stop();
        }
      });
    });
  } catch (e) {
    console.error(`[testops] ${st.key} ошибка остановки`, e);
    writeFailLog('TestOpsStopFail', e);
  }
  const aborted = writeAbortedResults(st, reason);
  // Очереди удалены, колбэк done уже не сработает, поэтому завершаем запуск вручную
  finishRun(st, 'stopped', reason);
  return aborted;
};

// Сторожевой таймер. Если сам таймер сработал с большим опозданием, значит event loop был
// заблокирован (синхронные вызовы docker), и диспетчер просто не мог достучаться:
// в этом случае даем всем запускам отсрочку, а не останавливаем их
let lastTick = Date.now();
setInterval(() => {
  const now = Date.now();
  const blocked = now - lastTick > WATCHDOG_TICK_MS * 3;
  lastTick = now;
  runs.forEach((st) => {
    if (st.state !== 'running') {
      return;
    }
    if (blocked) {
      st.lastSeen = now;
      return;
    }
    if (now - st.lastSeen > WATCHDOG_MS) {
      console.log(`[testops] ${st.key} диспетчер не опрашивает статус более ${WATCHDOG_MS / 1000} с, останавливаем запуск`);
      stopRun(st, `диспетчер не отвечает более ${WATCHDOG_MS / 1000} с (job отменена или упала)`);
    }
  });
}, WATCHDOG_TICK_MS).unref();

const validateLaunch = (body) => {
  if (!body || body.launchId === undefined || body.launchId === '') {
    return 'launchId обязателен';
  }
  if (!Array.isArray(body.tests) || body.tests.length === 0) {
    return 'tests должен быть непустым массивом';
  }
  // Тест без image допустим только с описанием ошибки (он сразу получит статус failed)
  const bad = body.tests.find(t => !t || t.id === undefined || !t.title || (!t.image && !t.error));
  if (bad) {
    return 'каждый тест должен содержать id, title и image (или error)';
  }
  const ids = new Set(body.tests.map(t => String(t.id)));
  if (ids.size !== body.tests.length) {
    return 'id тестов должны быть уникальны';
  }
  return null;
};

const resolveAllureDir = (dir) => {
  if (dir === undefined || dir === null || dir === '') {
    return { ok: true, dir: null };
  }
  const resolved = path.resolve(String(dir));
  if (!resolved.startsWith(`${ALLURE_ROOT}${path.sep}`)) {
    return { ok: false };
  }
  return { ok: true, dir: resolved };
};

// Авторизация по токену. Если DISPATCH_TOKEN не задан, все запросы отклоняются
router.use((req, res, next) => {
  const expected = process.env.DISPATCH_TOKEN;
  if (!expected || req.get('Authorization') !== `Bearer ${expected}`) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  next();
});

router.post('/launch', (req, res) => {
  const validationError = validateLaunch(req.body);
  if (validationError) {
    res.status(400).json({ error: validationError });
    return;
  }
  const {
    launchId, tests, browser = 'Chrome', nodeEnv = 'default', allureResultsDir,
  } = req.body;
  const id = String(launchId);
  const key = runKey(id);

  if (!browserConveers[browser]) {
    res.status(400).json({ error: `Неизвестный браузер ${browser}`, available: Object.keys(browserConveers) });
    return;
  }
  const allure = resolveAllureDir(allureResultsDir);
  if (!allure.ok) {
    res.status(400).json({ error: `allureResultsDir должен лежать внутри ${ALLURE_ROOT}` });
    return;
  }
  const existing = runs.get(id);
  if (existing && existing.state === 'running') {
    res.status(409).json({ error: 'Запуск с таким launchId уже выполняется', launchId: id });
    return;
  }
  const lock = runLock.acquire('testops', key);
  if (!lock.ok) {
    res.status(409).json({ error: `Раннер занят запуском из ${lock.busyWith}`, busyWith: lock.busyWith });
    return;
  }

  const st = {
    launchId: id,
    key,
    state: 'running',
    browser,
    nodeEnv,
    allureDir: allure.dir,
    allureErrors: 0,
    lastSeen: Date.now(),
    startedAt: new Date().toISOString(),
    tests: tests.map(t => ({
      id: t.id, title: t.title, image: t.image, error: t.error,
    })),
    results: {},
  };
  runs.delete(id);
  runs.set(id, st);
  pruneRuns();

  // Отвечаем сразу: конструктор TestManager синхронно опрашивает docker-образы (execSync)
  res.json({ launchId: id, state: st.state, total: st.tests.length });

  // Отчет приходит на каждый завершенный Task (обычно массив результатов)
  const sendReport = async (result) => {
    if (st.state !== 'running') {
      return;
    }
    [].concat(result).forEach((item) => {
      if (!item || item.test_id === undefined) {
        return;
      }
      const test = st.tests.find(t => String(t.id) === String(item.test_id));
      if (!test) {
        return;
      }
      st.results[test.id] = { status: toStatusName(item.status_id), elapsed: item.elapsed };
      console.log(`[testops] ${key} тест ${test.id}: ${st.results[test.id].status} (${item.elapsed})`);
      writeResult(st, test, {
        element: item.raw,
        startedAt: item.startedAt,
        stoppedAt: Date.now(),
        screenshot: item.screenshot,
      });
    });
  };

  setImmediate(async () => {
    try {
      // Тесты, для которых диспетчер не смог определить образ, сразу получают статус failed
      st.tests.filter(t => t.error).forEach((t) => {
        st.results[t.id] = { status: 'failed', elapsed: null, message: t.error };
        writeResult(st, t, { message: t.error });
      });
      const runnable = st.tests.filter(t => !t.error);
      if (runnable.length === 0) {
        finishRun(st, 'finished');
        return;
      }
      const checkedTests = {};
      runnable.forEach((t) => {
        checkedTests[String(t.id)] = true;
      });
      const managerTests = runnable.map(t => ({
        id: t.id,
        title: t.title,
        custom_url: t.image,
        run_id: key,
      }));
      console.log(`[testops] ${key} старт: ${managerTests.length} тестов, браузер ${browser}, окружение ${nodeEnv}, Allure: ${st.allureDir || 'нет'}`);
      const Manager = new TestManager(managerTests, checkedTests, sendReport, () => finishRun(st, 'finished'));
      // Конструктор синхронный и может блокировать event loop надолго (docker run для каждого образа)
      st.lastSeen = Date.now();
      await Manager.runAll(nodeEnv, browser);
    } catch (e) {
      console.error(`[testops] ${key} ошибка запуска`, e);
      writeFailLog('TestOpsRunFail', e);
      finishRun(st, 'error', e.toString());
    }
  });
});

router.get('/status/:launchId', (req, res) => {
  const st = runs.get(String(req.params.launchId));
  if (!st) {
    res.status(404).json({ error: 'Запуск не найден' });
    return;
  }
  st.lastSeen = Date.now();
  res.json(publicView(st));
});

router.post('/stop/:launchId', (req, res) => {
  const st = runs.get(String(req.params.launchId));
  if (!st) {
    res.status(404).json({ error: 'Запуск не найден' });
    return;
  }
  if (st.state !== 'running') {
    res.json({ launchId: st.launchId, state: st.state, aborted: 0 });
    return;
  }
  const reason = String((req.body && req.body.reason) || 'запуск остановлен').slice(0, 200);
  const aborted = stopRun(st, reason);
  res.json({ launchId: st.launchId, state: st.state, aborted });
});

module.exports = router;
