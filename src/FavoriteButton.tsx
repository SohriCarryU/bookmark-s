import { LoaderCircle, Star } from "lucide-react";
import "./favorites.css";

export default function FavoriteButton({ title, favorited, busy, disabled, onClick }: {
  title: string;
  favorited: boolean;
  busy: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return <button
    type="button"
    className={`favorite-toggle${favorited ? " is-favorite" : ""}`}
    aria-label={favorited ? `取消收藏 ${title}` : `收藏 ${title} 到个人书签`}
    title={favorited ? "取消个人收藏" : "收藏到个人书签"}
    aria-pressed={favorited}
    aria-busy={busy}
    disabled={busy || disabled}
    onClick={onClick}
  >
    {busy ? <LoaderCircle className="spin" size={18} aria-hidden="true" /> : <Star size={18} fill={favorited ? "currentColor" : "none"} aria-hidden="true" />}
  </button>;
}
