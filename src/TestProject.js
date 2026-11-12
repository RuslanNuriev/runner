/* eslint-disable class-methods-use-this,no-param-reassign */
const { spawn, execSync } = require('child_process');
const EventEmitter = require('events');
const {
  readFileSync, unlinkSync, rename, writeFileSync, rmdirSync,
} = require('fs');
const { cwd, env } = require('process');
const { dirname } = require('path');
const config = require('config');
const json5 = require('json5');

let testNumber = 0;

class TestProject extends EventEmitter {
  constructor(tests, containerId) {
    super();
    this.statuses = {
      passed: 1,
      failed: 5,
    };
    this.browsers = {
      Chrome: 'CHROME_HUB',
      'Mozilla Firefox': 'FIREFOX_HUB',
      IE11Win7: 'IE_HUB',
      Safari: 'SAFARI_HUB',
    };
    this.tests = tests;
    this.url = tests[0].custom_url;
    this.timestamp = 0;
    this.errorNumber = 0;
    this.preTests = {};
    // Остановка запуска: имя docker-контейнера, флаг и запущенные проекты предтестов
    this.containerName = null;
    this.stopped = false;
    this.preTestProjects = [];
    if (containerId){
      this.containerId = containerId;
    } else {
      this.containerId = `${this.url}_${Date.now()}`;
    }
    this.initDependencies();
  }

  /**
   * Запускает собранный тестовый проект
   * @returns {Promise<any>}
   */
  run(nodeEnv, browser) {
    this.loginRegistry();
    if (this.shouldRunOneByOne()) {
      return this.runOneByOne(nodeEnv, browser);
    }
    return this.runTest(nodeEnv, browser, this.getTitles());
  }

  async runOneByOne(nodeEnv, browser) {
    const result = [];
    const titles = this.tests.map(({ title }) => title);
    for (const item of titles) {
      try {
        await this.runPreTests(nodeEnv, browser, item);
        result.push(...(await this.runTest(nodeEnv, browser, item)));
      } catch (e) {
        return e;
      }
    }
    return result;
  }

  // Нужно ли запускать каждый тест в отдельном контейнере
  shouldRunOneByOne() {
    return Object.keys(this.preTests).length > 0;
  }

  loginRegistry() {
    const login = config.get('docker.login');
    const password = config.get('docker.password');
    if (login && password) {
      execSync(`docker login registry.jarvis.su -u ${login} -p '${password}'`);
    }
  }

  runTest(nodeEnv, browser, titles) {
    return new Promise((resolve, reject) => {
      if (this.stopped) {
        resolve([]);
        return;
      }
      browser = this.browsers[browser] || '';
      nodeEnv = nodeEnv || 'default';
      const hostPath = env.HOST_REPORT_DIR || cwd();
      testNumber += 1;
      const z = testNumber;
      this.containerName = `autotest-${String(this.getRunId()).replace(/[^a-zA-Z0-9_.-]/g, '_')}-${z}-${Date.now()}`;
      this.timestamp = Date.now();
      this.removeImageTest();
      // console.log('Запускаю runTest', this.url, titles, this.getRunId());
      const params = [
          'run',
          '--net=host',
          '--env', `PLATFORM=${browser}`,
          '--env', `NODE_ENV=${nodeEnv}`,
          '--env', `RUN_ID=${this.getRunId()}`,
          '--env', `CONTAINER_ID=${this.containerId}`,
          '-v', `${hostPath}/reports/${z}:/reports`,
          '-v', `${hostPath}/public/screenshots/${this.timestamp}:/app/screenshots`,
          '--rm',
          '--name', this.containerName,
          '-t',
          this.url,
          'npm',
          'test',
          '--',
          '--name', `^(${titles})$`,
        ];
      this.childProcess = spawn(
        'docker',
        params,
      );
      console.log(`Docker ${params.join(' ')}`);
      this.initLogs();
      this.childProcess.on('error', () => {
        this.removeImageTest();
        reject();
      });
      this.childProcess.on('close', () => {
        console.log(`close: RunID ${this.getRunId()}  ${this.url}`);
        this.removeImageTest();
        resolve(this.parseResult(z));
      });
    });
  }

  parseResult(z) {
    const outreport = `${cwd()}/reports/${z}/report.json`;
    const projectResults = [];
    try {
      const obj = JSON.parse(readFileSync(outreport, 'utf8'));
      unlinkSync(outreport);
      rmdirSync(dirname(outreport));
      const elements = this.prepareResultElements(obj);
      for (const item of elements) {
        const res = {};
        // console.log(item);
        const status = this.getTestResult(item);
        res.status_id = this.getTeststatusId(status);
        res.comment = this.getCommentByResult(status, item);
        res.test_id = this.getTestIdByName(item.name);
        res.elapsed = this.getTestRunTime(item);
        // Служебные данные для конвертации в Allure. Поля неперечисляемые,
        // поэтому в TestRail (JSON.stringify) они не попадают
        Object.defineProperty(res, 'raw', { value: item, enumerable: false });
        Object.defineProperty(res, 'startedAt', { value: this.timestamp, enumerable: false });
        Object.defineProperty(res, 'screenshot', {
          value: status === 'passed' ? null : `${cwd()}/public/screenshots/${this.timestamp}/${this.errorNumber}.png`,
          enumerable: false,
        });
        projectResults.push(res);
      }
    } catch (e) {
      const timestamp = Date.now();
      const stack = e.stack || '';
      writeFileSync(`${cwd()}/reports/ProjectFail${timestamp}.log`, `${e.toString()}\n\n\n${stack.toString()}`);
      rename(outreport, `${cwd()}/reports/report${this.timestamp}.json`, (err) => {
        if (err) {
          console.log('ERROR: ', err);
        }
      });
    }
    return projectResults;
  }

  initLogs() {
    this.childProcess.stdout.on('data', (data) => {
      this.emit('stdout', data);
      console.log(`stdout: ${data}`);
    });
    this.childProcess.stderr.on('data', (data) => {
      this.emit('stderr', data);
      console.log(`stderr: ${data}`);
    });
  }

  async runPreTests(nodeEnv, browser, title) {
    const cfg = this.preTests[title];
    if (!cfg) {
      return;
    }
    const tpArray = cfg.map(tstcfg => new TestProject([
      {
        custom_url: tstcfg.url,
        title: tstcfg.title,
        run_id: this.getRunId(),
        id: this.getTestIdByName(title),
      },

    ], this.containerId));
    this.preTestProjects = tpArray;
    for (const item of tpArray) {
      if (this.stopped) {
        throw new Error('Запуск остановлен');
      }
      const res = await item.run(nodeEnv, browser);
      // console.log(res[0].status_id);
      if (res[0].status_id !== 1) {
        throw res;
      }
    }
  }

  /**
   * Собирает все заголовки из тестовго проекта и собирает их в строку для запука
   * @returns {string}
   */
  getTitles() {
    const titles = [];
    for (const item of this.tests) {
      titles.push(item.title);
    }
    return titles.join('|');
  }

  prepareResultElements(res) {
    return [].concat(...res.map(r => r.elements));
  }

  /**
   *   Из результата объекта одного теста отдает ответ прошел тест или нет
   */
  getTestResult(testResult) {
    const failedStep = testResult.steps.find(s => s.result.status !== 'passed');
    if (failedStep) {
      return failedStep.result.status;
    }
    return 'passed';
  }

  /**
   * Складывает время прохождения шагов и возвращает общее время прохождения теста
   * @param testResult
   * @returns {string}
   */

  getTestRunTime(testResult) {
    let testTime = 0;
    for (const el of testResult.steps) {
      testTime += el.result.duration || 0;
    }
    if (parseInt(testTime * 0.000000001, 10) === 0) {
      return '1s';
    }
    return `${parseInt(testTime * 0.000000001, 10)}s`;
  }

  /**
   * Получает ID статуса теста
   * @param testResult
   * @returns {*}
   */
  getTeststatusId(testResult) {
    return this.statuses[testResult];
  }

  /**
   * Получает ID теста по имени
   * @param testResult
   * @returns {*}
   */
  getTestIdByName(name) {
    const test = this.tests.find(t => t.title === name);
    if (test) {
      return test.id;
    }
    throw new Error(`Для теста ${name} не найден ID, надо закомитить тест`);
  }

  /**
   * Записывает результаты теста по шагам, обозначая статус каждого шага
   * @param status
   * @param testResult
   * @returns {string}
   */
  getCommentByResult(status, testResult) {
    const statusAlias = {
      passed: '**Пройден:**',
      failed: '**Провален:**',
      skipped: '**Пропущен:**',
      undefined: '**Нет шага:**',
    };
    if (status === 'passed') {
      return 'Тест пройден';
    }
    this.errorNumber += 1;
    const comment = [];
    comment.push(`![Valid XHTML] (https://plgiirczejbn0y5xfna8.<vs host>.ru/screenshots/${this.timestamp}/${this.errorNumber}.png)`);
    for (const i of testResult.steps) {
      const line = [];
      line.push(statusAlias[i.result.status], i.keyword, i.name);
      if (i.result.status === 'failed') {
        line.push(`\n>>>>${i.result.error_message.replace(/\n/g, '\n>>>>')}\n`);
      }
      comment.push(line.join(' '));
    }
    return comment.join('\n');
  }

  stop() {
    console.log('TestProject/stop kill process', this.url);
    this.stopped = true;
    if (this.childProcess) {
      this.childProcess.kill('SIGTERM');
    }
    // Остановка docker CLI не останавливает контейнер (при -t сигнал в него не проксируется),
    // поэтому удаляем контейнер по имени. Без блокировки event loop
    if (this.containerName) {
      spawn('docker', ['rm', '-f', this.containerName], { stdio: 'ignore' }).on('error', () => {});
    }
    this.preTestProjects.forEach(item => item.stop());
  }

  getRunId() {
    return this.tests[0].run_id;
  }

  removeImageTest() {
    try {
      //execSync(`docker rmi ${this.url}`);
      execSync('docker image prune -f -a');
    } catch (e) {
      // empty
    }
  }

  initDependencies() {
    try {
      const depConfigsrc = execSync(`docker run --rm -t ${this.url} cat /app/config/default.json5`);
      const depConfig = json5.parse(depConfigsrc.toString());
      this.preTests = depConfig.preTests || {};
    } catch (e) {
      // empty
    }
  }
}

module.exports = TestProject;

