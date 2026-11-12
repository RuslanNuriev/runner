/* eslint-disable guard-for-in */
const TestProject = require('../src/TestProject');
// const Conveer = require('../src/Conveer');
const Task = require('../src/Task');
const browserConveers = require('../src/ConveerStart');

class TestManager {
  constructor(tests, checkedTests, sendReport, done) {
    this.prepareChekedTests(checkedTests);
    this.tests = tests.filter(x => !!x).filter(this.isCheked.bind(this));
    this.testProjects = [];
    this.indexByUrl = {};
    this.sendReport = sendReport;
    this.prepareIndexByUrl();
    this.prepareTestProjectInstances(true);
    this.done = done;
  }

  /**
   * Запускает все собранные тестовые проекты
   * @returns {Promise<Array>}
   */
  async runAllOld(nodeEnv, browser) {
    const result = [];
    for (const TestProjectItem of this.getTestProjects()) {
      const resultItem = await TestProjectItem.run(nodeEnv, browser);
      result.push(resultItem);
      if (this.sendReport) {
        await this.sendReport(resultItem);
      }
    }
    return result;
  }

  async runAll(nodeEnv, browser) {
    // console.log('runall');

    if (this.tests.length === 0) {
      throw new Error('Список выбранных тестов пустой');
    }

    const newNodeEnv = nodeEnv || 'default';
    const choosenBrowser = browser || 'Chrome';
    const queue = [];
    let queueLength = 0;
    const done = () => {
      queueLength -= 1;
      if (queueLength === 0 && this.done) {
        this.done();
      }
    };
    for (const TestProjectItem of this.getTestProjects()) {
      queue.push(new Task(TestProjectItem, choosenBrowser, newNodeEnv, this.sendReport, done));
    }
    queueLength = queue.length;
    if (!browserConveers[choosenBrowser]) {
      throw new Error(`Не найден browserConveers с именем ${choosenBrowser}`);
    }
    browserConveers[choosenBrowser].add(queue, this.tests[0].run_id);
  }

  getTestProjects() {
    return this.testProjects;
  }

  /**
   * Создаем экземпляры объектов тестовых проектов
   */
  prepareTestProjectInstances(isByOne=false) {
    for (const i in this.indexByUrl) {
      if (!isByOne) {
        this.testProjects.push(new TestProject(this.indexByUrl[i]));
      } else {
        this.testProjects.push(
          ...this.indexByUrl[i].map((item) => new TestProject([item])),
        );
      }
    }
    // console.log(this.testProjects);
  }

  /**
   * Подготавливаем объект с группами тестов разбитыми по проектам
   */
  prepareIndexByUrl() {
    for (const item of this.tests) {
      if (item.hasOwnProperty('custom_url') && item.custom_url) {
        if (this.indexByUrl[item.custom_url]) {
          this.indexByUrl[item.custom_url].push(item);
        } else {
          this.indexByUrl[item.custom_url] = [item];
        }
      }
    }
    // console.log(this.indexByUrl);
  }

  /**
   * Отбирает тесты с флагом true и передаем их тест менеджеру
   * @param test
   * @returns {boolean}
   */
  isCheked(test) {
    return this.checkedTests[test.id.toString()] === true;
  }

  /**
   * Смотрит есть ли выбранные тесты или нет
   * Если есть, то отдает их дальше
   * Если нет, то меняет всефлаги с false на true и отдает их дальше
   * @param checkedTests
   * @returns {*}
   */
  prepareChekedTests(checkedTests) {
    this.checkedTests = checkedTests;
    let cheked = false;
    for (const i in checkedTests) {
      if (checkedTests[i] === true) {
        cheked = true;
        break;
      }
    }
    if (!cheked) {
      for (const i in this.checkedTests) {
        this.checkedTests[i] = true;
      }
    }
    return checkedTests;
  }
}

module.exports = TestManager;
