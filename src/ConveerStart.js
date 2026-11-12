const Conveer = require('../src/Conveer');

const browserConveers = {
  Chrome: new Conveer(10),
  'Mozilla Firefox': new Conveer(10),
  IE11Win7: new Conveer(1),
  Safari: new Conveer(1),
};

module.exports = browserConveers;
