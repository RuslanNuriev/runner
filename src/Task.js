module.exports = class Task {
  constructor(testProject, browser, nodeEnv, sendReport, done) {
    this.testProject = testProject;
    this.browser = browser;
    this.nodeEnv = nodeEnv;
    this.sendReport = sendReport;
    this.done = done;
    this.stdout = '';
    this.stderr = '';
  }
  async run() {
    try {
      this.testProject.on('stdout', (s) => {
        this.stdout = s.toString();
      });
      this.testProject.on('stderr', (s) => {
        this.stderr = s.toString();
      });
      const resultItem = await this.testProject.run(this.nodeEnv, this.browser);
      await this.sendReport(resultItem);
    } catch (e) {
      // empty
    }
    this.done();
    return this;
  }

  stop() {
    this.testProject.stop();
  }
};

