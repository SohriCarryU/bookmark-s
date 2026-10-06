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
  tags: Tag[];
  clicks: number;
  pinned: boolean;
  createdAt: string;
};
export type User = { username: string };
export type Submission = {
  id: string;
  title: string;
  url: string;
  description: string;
  categoryId: string;
  tags: Tag[];
  status: "pending" | "approved" | "rejected";
  createdAt: string;
};
export type Bootstrap = {
  categories: Category[];
  tags: TagCount[];
  bookmarks: Bookmark[];
  user: User | null;
  stats: {
    totalBookmarks: number;
    totalClicks: number;
    totalCategories: number;
  };
};
export type BookmarkInput = Pick<
  Bookmark,
  "title" | "url" | "description" | "categoryId"
> & { tags: string[] };
