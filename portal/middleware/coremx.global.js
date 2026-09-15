// Central's authentication/keychain pages remain available; business pages do not.
export default defineNuxtRouteMiddleware((to) => {
  const allowed =
    to.path === '/mail' ||
    to.path === '/' ||
    to.path === '/coremx' ||
    to.path.startsWith('/coremx/') ||
    to.path === '/admin/auth' ||
    to.path.startsWith('/admin/auth/') ||
    ['/terms', '/privacy'].includes(to.path);
  if (!allowed) return navigateTo('/mail');
});
