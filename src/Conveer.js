/* eslint-disable no-param-reassign */
module.exports = class Conveer {
  constructor(size) {
    console.log('constracted');
    // Массив из запущенных очередей
    this.queues = [];
    // Количество запущенных контейнеров
    this.size = size;
    // Счетчик, который позволяет поочереди брать таски из каждой очереди
    this.queuesIndex = 0;
    // Занятые тестами контейнеры
    this.occupaed = 0;
    // Штука, которая показывает запущен процесс или нет
    this.sequence = null;
    // Массив из запущенных тестов
    this.runned = [];
  }

  add(queue, key) {
    // Присваиваем очереди key, который равен ИД рана, что б можно было стопать ран
    queue.key = key;
    // Добавляем ран(очередь) в массив очередей, что бы из него запускались тесты
    this.queues.push(queue);
    if (!this.sequence) {
      this.sequence = this.process();
    }
    this.fillEmptySlots();
  }

  fillEmptySlots() {
    while ((this.size - this.occupaed) > 0) {
      const nextResult = this.sequence.next();
      if (nextResult.done) {
        this.sequence = null;
        break;
      } else {
        nextResult.value.then((currentTask) => {
          this.occupaed = this.occupaed - 1;
          this.deleteRunnedTask(currentTask);
          this.nextHandler(currentTask);
        }).catch((currentTask) => {
          this.nextHandler(currentTask);
        });
      }
    }
  }

  * process() {
    while (this.queues.length > 0) {
      const item = this.queues[this.queuesIndex];
      this.occupaed = this.occupaed + 1;
      const task = item.pop();
      try {
        const runResult = task.run();
        if (item.length === 0) {
          this.queues.splice(this.queuesIndex, 1);
        }
        this.queuesIndex = this.queuesIndex + 1;
        if (this.queues.length <= this.queuesIndex) {
          this.queuesIndex = 0;
        }
        this.runned.push(task);
        yield runResult;
      } catch (e) {
        console.error(e);
      }
    }
  }

  nextHandler() {
    if (!this.sequence) {
      return;
    }
    const nextResult = this.sequence.next();

    if (nextResult.done) {
      this.sequence = null;
      nextResult.value.then((currentTask) => {
        this.occupaed = this.occupaed - 1;
        this.deleteRunnedTask(currentTask);
      });
    } else {
      nextResult.value.then((currentTask) => {
        this.occupaed = this.occupaed - 1;
        this.deleteRunnedTask(currentTask);
        this.nextHandler(currentTask);
      }).catch((currentTask) => {
        this.nextHandler(currentTask);
      });
    }
  }

  deleteRunnedTask(task) {
    if (task) {
      const currentidx = this.runned.findIndex(item => task === item);
      if (currentidx > -1) {
        this.runned.splice(currentidx, 1);
      }
    }
  }

  getQueueCount() {
    return {
      queue: this.queues.length,
      occupaed: this.occupaed,
    };
  }

  getRunned() {
    return this.runned;
  }

  removeQueue(key) {
    const stopIndex = this.queues.findIndex(queue => queue.key === key);
    if (stopIndex > -1) {
      return this.queues.splice(stopIndex, 1).pop();
    }
    return null;
  }
};

