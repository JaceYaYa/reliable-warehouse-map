// These two existing accounts are explicitly authorized owners on both sites.
export function isProtectedOwnerUsername(value: unknown): boolean {
  return typeof value === "string" && ["boss", "xmcxmc"].includes(value.trim().toLowerCase());
}

export const USER_ROLES = ["admin", "employee", "warehouse"] as const;

export type UserRole = (typeof USER_ROLES)[number];

export function normalizeUserRole(value: unknown): UserRole | null {
  if (typeof value !== "string") return null;
  const role = value.trim().toLowerCase();
  return USER_ROLES.includes(role as UserRole) ? role as UserRole : null;
}

export function canWriteWarehouseData(role: unknown): boolean {
  const normalized = normalizeUserRole(role);
  return normalized === "admin";
}

export function userRoleLabel(role: unknown, username?: string): string {
  if (isProtectedOwnerUsername(username)) return "老板";
  switch (normalizeUserRole(role)) {
    case "admin": return "管理员";
    case "employee": return "员工";
    case "warehouse": return "员工";
    default: return "未知角色";
  }
}
