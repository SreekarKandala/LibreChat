/**
 * OpenID login was removed from this fork. Graph/OBO token services still
 * import this config accessor; any feature that actually needs it (Entra ID
 * people picker, SharePoint OBO tokens) fails explicitly instead of silently.
 */
const getOpenIdConfig = () => {
  throw new Error('OpenID authentication was removed from this fork');
};

module.exports = { getOpenIdConfig };
