export type Category = {
  id: string;
  name: string;
  icon: string;
  color: string;
  sortOrder: number;
};
export type Tag = { id: string; name: string };
export type TagCount = Tag & { count: number };
export type Bookmark = {
  id: string;
  title: string;
  url: string;
  description: string;
  categoryId: string;
  categoryIds: string[];
  pinnedCategoryIds: string[];
  tags: Tag[];
  clicks: number;
  pinned: boolean;
  createdAt: string;
  createdBy: string | null;
  editedBy: string[];
};
export type User = {
  id: string;
  username: string;
  role: "admin" | "user";
  canAddBookmarks: boolean;
  canPinBookmarks: boolean;
  isOwner: boolean;
};
export type SiteSettings = {
  siteMode: "public" | "private";
  allowUserAddBookmarks: boolean;
  allowUserPinBookmarks: boolean;
};
export type Submission = {
  id: string;
  title: string;
  url: string;
  description: string;
  categoryId: string;
  categoryIds: string[];
  tags: Tag[];
  status: "pending" | "approved" | "rejected";
  createdAt: string;
  createdBy: string | null;
};
export type Bootstrap = {
  categories: Category[];
  tags: TagCount[];
  bookmarks: Bookmark[];
  user: User | null;
  siteMode: "public" | "private";
  allowUserAddBookmarks: boolean;
  allowUserPinBookmarks: boolean;
  canViewContent: boolean;
  stats: {
    totalBookmarks: number;
    totalClicks: number;
    totalCategories: number;
  };
};
export type BookmarkInput = Pick<
  Bookmark,
  "title" | "url" | "description" | "categoryIds"
> & { tags: string[] };
export type PersonalPreferences = {
  blockedTagIds: string[];
  tags: TagCount[];
};
