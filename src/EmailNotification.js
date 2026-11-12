const nodemailer = require('nodemailer');

const transport = nodemailer.createTransport({
  host: 'smtp.<vs host>.ru',
  port: 25,
  secure: false,
});

module.exports = transport;
