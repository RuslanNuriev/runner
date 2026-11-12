const browserConveers = require('./ConveerStart');

// Взаимоисключение запусков из разных систем (TestRail / ТестОпс).
// Ключ записи: `${provider}:${key}`, значение: { provider, since }.
const active = new Map();

// Если замок старше этого времени и все конвейеры простаивают, считаем его "протёкшим"
const STALE_AFTER_MS = 2 * 60 * 1000;

const isConveersIdle = () => Object.values(browserConveers)
  .every(c => c.queues.length === 0 && c.occupaed === 0 && c.runned.length === 0);

const dropStale = () => {
  if (!isConveersIdle()) {
    return;
  }
  const now = Date.now();
  for (const [k, v] of active.entries()) {
    if (now - v.since > STALE_AFTER_MS) {
      console.log(`RunLock: сбрасываем протёкший замок ${k}`);
      active.delete(k);
    }
  }
};

module.exports = {
  /**
   * Пытается занять раннер для рана из указанной системы.
   * @param {string} provider 'testrail' | 'testops'
   * @param {string|number} key ИД рана/лаунча
   * @returns {{ok: boolean, busyWith?: string}}
   */
  acquire(provider, key) {
    dropStale();
    const other = Array.from(active.values()).find(v => v.provider !== provider);
    if (other) {
      return { ok: false, busyWith: other.provider };
    }
    active.set(`${provider}:${key}`, { provider, since: Date.now() });
    return { ok: true };
  },

  release(provider, key) {
    active.delete(`${provider}:${key}`);
  },

  getActive() {
    return Array.from(active.keys());
  },
};