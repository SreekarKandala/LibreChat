const buildEndpointOption = require('./buildEndpointOption');
const validateMessageReq = require('./validateMessageReq');
const accessResources = require('./accessResources');
const abortMiddleware = require('./abortMiddleware');
const requireJwtAuth = require('./requireJwtAuth');
const configMiddleware = require('./config/app');
const moderateText = require('./moderateText');
const setHeaders = require('./setHeaders');
const validate = require('./validate');
const limiters = require('./limiters');
const noIndex = require('./noIndex');
const roles = require('./roles');

module.exports = {
  ...abortMiddleware,
  ...validate,
  ...limiters,
  ...roles,
  ...accessResources,
  noIndex,
  setHeaders,
  moderateText,
  requireJwtAuth,
  configMiddleware,
  validateMessageReq,
  buildEndpointOption,
};
