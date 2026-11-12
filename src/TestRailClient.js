const { createJsonClient } = require('restify-clients');


class TestRailClient {
  constructor() {
    this.client = createJsonClient({
      url: 'https://testrail.<vs host>.ru',
      headers: {
        'Content-Type': 'application\/json',
      },
      connectTimeout: 10000,
      requestTimeout: 10000,
    });
  }

  auth() {
    this.client.basicAuth('r.nuriev@<vs host>.ru', '<token>');
  }

  /**
   * Получает все тесты из тестрана
   * @param runId
   * @returns {Promise<any>}
   */
  getTests(runId) {
    return new Promise((resolve, reject) => {
      this.auth();
      this.client.get(`/index.php?/api/v2/get_tests/${runId}`, (err, req, res, obj) => {
        // console.log(obj);
        if (err) {
          reject(err);
        } else {
          resolve(obj.tests);
        }
        resolve(obj.tests);
      });
    });
  }

  /**
   * Добавляет в тестран результаты тестов
   * @param runId
   * @param res
   * @returns {Promise<any>}
   */
  addResults(runId, res) {
    return new Promise((resolve, reject) => {
      const allResults = [].concat(...res.map(r => r));
      const result = {};
      result.results = allResults;
      // console.log(result);
      this.client.post(`/index.php?/api/v2/add_results/${runId}`, result, (err, req, res, obj) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }


  getRun(runId) {
    return new Promise((resolve, reject) => {
      this.auth();
      this.client.get(`/index.php?/api/v2/get_run/${runId}`, (err, req, res, obj) => {
        // console.log(obj);
        if (err) {
          reject(err);
        } else {
          resolve(obj);
        }
        resolve(obj);
      });
    });
  }
}


module.exports = TestRailClient;

