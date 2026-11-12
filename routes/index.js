const express = require('express');

const router = express.Router();
const url = require('url');
const { exec, spawn } = require('child_process');
const TestRailClient = require('../src/TestRailClient');
const TestManager = require('../src/TestManager');
const fs = require('fs');
const { cwd, env } = require('process');
const browserConveers = require('../src/ConveerStart');
const transport = require('../src/EmailNotification');
const runLock = require('../src/RunLock');


const whoAreStarted = {};

/* GET home page. */
router.get('/', async (req, res, next) => {
  // Создаем клиент
  const Client = new TestRailClient();
  // Получаем данные о тестране
  const queryData = url.parse(req.url, true).query;
  const data = JSON.parse(queryData.data);
  const { checkedTests } = data;
  // Получаем конфиг если он есть, что бы запустить тесты на нужной площадке
  const nodeEnv = data.context.run.name.indexOf('#') === -1 ? null : data.context.run.name.split('#').pop().trim();
  // Сохраняем ИД тестрана
  const runId = data.context.run.id;
  // Получаем из конфига тестрана браузер если он указан
  const runInfo = await Client.getRun(runId);
  const browser = runInfo.config;
  if (!whoAreStarted[runId]) {
    // Не даем запустить ран, пока идет ран из ТестОпс
    const lock = runLock.acquire('testrail', runId);
    if (!lock.ok) {
      res.jsonp({ runned: runId, error: `Раннер занят запуском из ${lock.busyWith}, попробуйте позже.` });
      return;
    }
    whoAreStarted[runId] = true;
    const releaseRun = () => {
      delete whoAreStarted[runId];
      runLock.release('testrail', runId);
    };
    // Получаем все тесты из тестрана
    const tests = await Client.getTests(runId);

    if (!tests) {
      releaseRun();
      res.jsonp({ runned: runId, error: 'Не удалось получить список тестов от тестрейла, попробуйте еще раз.' });
      return;
    }

    res.jsonp({ runned: runId });

    // Запускаем все тесты
    const Manager = new TestManager(tests, checkedTests, result => Client.addResults(runId, [result]), () => {
      transport.sendMail({
        from: 'testrail.notification@<vs host>.ru',
        to: data.context.user.email,
        subject: `Тестран завершен ${data.context.run.name}`,
        html: `<html lang="ru"><head> <meta charset="UTF-8">
        </head><body>Тестран завершен ${data.context.run.name}
        <p>Ссылка на тестран <a href="${runInfo.url}">${runInfo.url}</a></p></body></html>`,
      });
      releaseRun();
    });
    try {
      await Manager.runAll(nodeEnv, browser);
    } catch (e) {
      releaseRun();
      const timestamp = Date.now();
      const stack = e.stack || '';
      fs.writeFileSync(`${cwd()}/reports/RunFail${timestamp}.log`, `${e.toString()}\n\n\n${stack.toString()}`);
    }
  } else {
    res.jsonp({ runned: runId, alreadyStarted: true });
  }
});

router.get('/stop', (req, res) => {
  try {
    console.log('Начинаем попытку стопа');
    const queryData = url.parse(req.url, true).query;
    const data = JSON.parse(queryData.data);
    const runId = data.context.run.id;
    // Обходим все конвейеры (браузеры) динамически, чтобы не зависеть от их списка
    Object.values(browserConveers).forEach((conveer) => {
      conveer.removeQueue(runId);
      conveer.getRunned().forEach((task) => {
        if (task.testProject.getRunId() === runId) {
          task.stop();
        }
      });
    });
    // Очереди удалены, колбэк done уже не сработает, поэтому освобождаем ран вручную
    delete whoAreStarted[runId];
    runLock.release('testrail', runId);
    res.jsonp({ stopped: runId });
  } catch (e) {
    const timestamp = Date.now();
    const stack = e.stack || '';
    fs.writeFileSync(`${cwd()}/reports/StopFail${timestamp}.log`, `${e.toString()}\n\n\n${stack.toString()}`);
    res.status(500).jsonp({ error: e.toString() });
  }
});

router.get('/check', (req, res) => {
  const queryData = url.parse(req.url, true).query;
  const data = JSON.parse(queryData.data);
  res.jsonp(whoAreStarted.hasOwnProperty(data.id));
});

router.get('/report', (req, res) => {
  res.render('index', {
    title: 'Hey',
    message: 'Hello there!',
    whoAreStarted: JSON.stringify(whoAreStarted),
    queueCount: {
      chrome: browserConveers.Chrome.getQueueCount(),
      firefox: browserConveers['Mozilla Firefox'].getQueueCount(),
      // ie: browserConveers.IE11Win7.getQueueCount(),
    },
    runned: {
      chrome: browserConveers.Chrome.getRunned(),
      firefox: browserConveers['Mozilla Firefox'].getRunned(),
      // ie: browserConveers.IE11Win7.getRunned(),
    },
  });
});

module.exports = router;