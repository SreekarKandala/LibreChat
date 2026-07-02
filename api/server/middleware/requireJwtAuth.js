const { SystemRoles } = require('librechat-data-provider');
const { tenantContextMiddleware } = require('@librechat/api');
const { findUser } = require('~/models');

/**
 * Login has been removed from this fork: every request runs as the single
 * service user named by SERVICE_USER_EMAIL. Access control is delegated to
 * the upstream application; this API must only be reachable through it
 * (network-isolated or proxy-gated) — it accepts all callers.
 */
let serviceUserPromise = null;
const loadServiceUser = () => {
  if (serviceUserPromise) {
    return serviceUserPromise;
  }
  serviceUserPromise = (async () => {
    const email = process.env.SERVICE_USER_EMAIL;
    if (!email) {
      throw new Error('SERVICE_USER_EMAIL is not set');
    }
    const user = await findUser({ email }, '-password -__v -totpSecret -backupCodes');
    if (!user) {
      throw new Error(`SERVICE_USER_EMAIL does not match any user: ${email}`);
    }
    user.id = user._id.toString();
    user.role = user.role ?? SystemRoles.USER;
    return user;
  })().catch((err) => {
    serviceUserPromise = null;
    throw err;
  });
  return serviceUserPromise;
};

/** Attaches the service user to the request; replaces the former JWT authentication. */
const requireJwtAuth = (req, res, next) => {
  loadServiceUser()
    .then((user) => {
      req.user = { ...user };
      req.authStrategy = 'service-user';
      tenantContextMiddleware(req, res, next);
    })
    .catch(next);
};

module.exports = requireJwtAuth;
