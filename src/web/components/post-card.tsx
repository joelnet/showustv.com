// One feed post, Instagram-style: a square image, the heart + comment row,
// the reaction tallies, then the caption ("joelnet watched S02·E05–E07 of
// Severance"), a link into the comment thread, and the time. No header: the
// caption already names the user. The image is the show or
// movie poster, cropped square (a show's backdrop is the fallback); a 404
// anywhere in the chain walks to the next candidate so the card never shows a
// broken image.
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../app";
import { backdrop, poster } from "../img";
import { fmtAgo, fmtDateTime } from "../format";
import { mediaPath } from "../paths";
import { episodeRangeText, type FeedPost } from "../../shared/feed";
import { IconComment } from "./icons";
import { PostReactions, type ReactionState } from "./post-reactions";

function imageChain(post: FeedPost): string[] {
  const chain =
    post.kind === "show" ? [poster(post.poster, "w500"), backdrop(post.backdrop)] : [poster(post.poster, "w500")];
  return chain.filter((u): u is string => !!u);
}

function PostImage({ post, alt }: { post: FeedPost; alt: string }) {
  const [chain, setChain] = useState(() => imageChain(post));
  useEffect(() => setChain(imageChain(post)), [post]);
  const src = chain[0];
  return (
    <div className="post-media">
      {src && <img src={src} alt={alt} loading="lazy" onError={() => setChain((c) => c.slice(1))} />}
    </div>
  );
}

export function PostCard({ post, detail = false }: { post: FeedPost; detail?: boolean }) {
  const { user } = useAuth();
  // Reaction state is local so the picker's optimistic flips show in the
  // tallies too; a refetch hands back a new post object and resets it.
  const [rx, setRx] = useState<ReactionState>({ myReaction: post.myReaction, reactions: post.reactions });
  useEffect(() => setRx({ myReaction: post.myReaction, reactions: post.reactions }), [post]);

  const titlePath = mediaPath(post.kind, post.targetId, post.title);
  const titleLink = <Link to={titlePath}>{post.title}</Link>;
  const verb = post.rewatch ? "rewatched" : "watched";
  const span = post.kind === "show" ? episodeRangeText(post.episodes) : "";
  const label = `${post.username}'s post about ${post.title}`;
  const imgAlt = `${post.title} poster`;

  return (
    <article className="post-card" aria-label={label}>
      {detail ? (
        <PostImage post={post} alt={imgAlt} />
      ) : (
        <Link to={`/feed/${post.id}`} className="post-media-link" aria-label={`Open ${label}`}>
          <PostImage post={post} alt={imgAlt} />
        </Link>
      )}
      <div className="post-actions">
        <PostReactions postId={post.id} state={rx} onState={setRx} disabled={post.mine} label={label} />
        {!detail && (
          <Link to={`/feed/${post.id}`} className="icon-btn post-comment-btn" aria-label={`Comments on ${label}`}>
            <IconComment size={18} />
            {post.commentCount > 0 && <span className="post-comment-count">{post.commentCount}</span>}
          </Link>
        )}
      </div>
      {rx.reactions.length > 0 && (
        <div className="post-rx-summary" aria-label="Reactions">
          {rx.reactions.map((r) => (
            <span key={r.emoji} className={r.emoji === rx.myReaction ? "post-rx is-mine" : "post-rx"}>
              <span aria-hidden="true">{r.emoji}</span> {r.count}
            </span>
          ))}
        </div>
      )}
      <p className="post-caption">
        <Link to={`/u/${post.username}`} className="post-user">
          {post.username}
        </Link>{" "}
        {verb}{" "}
        {span ? (
          <>
            <span className="post-ep mono">{span}</span> of {titleLink}
          </>
        ) : (
          titleLink
        )}
      </p>
      {!detail && post.commentCount > 0 && (
        <Link to={`/feed/${post.id}`} className="post-comments-link">
          View {post.commentCount === 1 ? "1 comment" : `all ${post.commentCount} comments`}
        </Link>
      )}
      <time className="post-when mono" dateTime={post.lastAt} title={user ? fmtDateTime(post.lastAt, user.tz) : undefined}>
        {fmtAgo(post.lastAt)}
      </time>
    </article>
  );
}
