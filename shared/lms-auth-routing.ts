export function getLmsPostLoginPath(roles: readonly string[]) {
  if (roles.includes("admin")) return "/lms-admin";
  if (roles.includes("trainer") && !roles.includes("student")) return "/trainer";
  return "/learn/dashboard";
}
