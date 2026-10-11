export const permissionKeys = [
  "manage_users",
  "manage_groups",
  "manage_settings",
  "add_bookmarks",
  "edit_bookmarks",
  "delete_bookmarks",
  "pin_bookmarks",
  "manage_tags",
  "manage_categories",
  "review_submissions",
  "view_operations",
] as const;

export type PermissionKey = (typeof permissionKeys)[number];

export const permissionLabels: Record<PermissionKey, string> = {
  manage_users: "管理用户",
  manage_groups: "管理用户组",
  manage_settings: "管理站点配置",
  add_bookmarks: "添加书签",
  edit_bookmarks: "编辑书签",
  delete_bookmarks: "删除书签",
  pin_bookmarks: "置顶书签",
  manage_tags: "管理标签",
  manage_categories: "管理文件夹",
  review_submissions: "审核网站分享",
  view_operations: "查看操作记录",
};

export const allPermissions = [...permissionKeys] as PermissionKey[];
