/**
 * Auth0 post-login Action: copies the profile fields the API needs onto the access token.
 *
 * Auth0 access tokens carry only `sub` by default, and custom claims must be namespaced (a URL).
 * The API reads `<AUTH0_CLAIM_NAMESPACE>email`, `...email_verified` and `...name`, so set the
 * Action secret CLAIM_NAMESPACE to exactly the API's AUTH0_CLAIM_NAMESPACE (trailing slash
 * included). Paste this file into Actions > Library > Build Custom > Login / Post Login.
 *
 * @param {Event} event - Details about the user and the context in which they are logging in.
 * @param {PostLoginAPI} api - Interface whose methods can be used to change the behavior of the login.
 */
exports.onExecutePostLogin = async (event, api) => {
  const namespace = event.secrets.CLAIM_NAMESPACE;
  if (!namespace) {
    // Fail loudly: without these claims the API never learns the user's verified email.
    api.access.deny('Sign-in is misconfigured (CLAIM_NAMESPACE secret missing).');
    return;
  }
  const ns = namespace.endsWith('/') ? namespace : `${namespace}/`;
  const user = event.user;

  if (typeof user.email === 'string' && user.email) {
    api.accessToken.setCustomClaim(`${ns}email`, user.email);
    api.accessToken.setCustomClaim(`${ns}email_verified`, user.email_verified === true);
  }
  // Passwordless email users have no name; the API then falls back to the email's local part.
  const name = [user.name, user.nickname, user.given_name].find(
    (v) => typeof v === 'string' && v.trim() && v !== user.email,
  );
  if (name) api.accessToken.setCustomClaim(`${ns}name`, name.trim());
};
