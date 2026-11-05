export function getLmsPostLoginPath(roles: readonly string[]) {
  if (roles.includes("admin")) return "/lms-admin";
  if (roles.some(role => ["admissions", "academic_coordinator", "operations"].includes(role))) return "/admin/calendar";
  if (roles.includes("trainer") && !roles.includes("student")) return "/trainer";
  return "/learn/dashboard";
}

export function getAdminLoginDestination(roles: readonly string[]) {
  return roles.includes("admin") ? "/admin" : null;
}
