const endpoints = require('./endpoints');
const staticRoute = require('./static');
const messages = require('./messages');
const actions = require('./actions');
const models = require('./models');
const convos = require('./convos');
const agents = require('./agents');
const files = require('./files');
const auth = require('./auth');
const categories = require('./categories');

module.exports = {
  auth,
  files,
  agents,
  convos,
  models,
  actions,
  messages,
  endpoints,
  categories,
  staticRoute,
};
