// One feed post with its comment thread (/feed/:postId) — where a
// post_comment / post_reply / post_reaction notification lands. The thread
// is the shared Comments component with the 'post' target type. Beta-gated
// like the feed itself.
import { Link, Navigate, useParams } from "react-router-dom";
import { useAuth } from "../app";
import { useApi, useDocumentTitle } from "../hooks";
import { Empty, ErrorNote } from "../components/ui";
import { FeedSkeleton } from "../components/skeleton";
import { Comments } from "../components/comments";
import { PostCard } from "../components/post-card";
import { IconChevronLeft } from "../components/icons";
import { idFromParam } from "../paths";
import { isFeedBetaUsername } from "../../shared/constants";
import type { FeedPost } from "../../shared/feed";

export function FeedPostPage() {
  const { user } = useAuth();
  const { postId } = useParams();
  const id = idFromParam(postId ?? "");
  const flagged = isFeedBetaUsername(user?.username);
  const { data, loading, error } = useApi<{ post: FeedPost }>(flagged && id ? `/feed/posts/${id}` : null);
  useDocumentTitle(data?.post ? `${data.post.username} watched ${data.post.title}` : "Post");

  if (!flagged) return <Navigate to="/following" replace />;

  const back = (
    <Link to="/feed" className="feed-back">
      <IconChevronLeft size={16} /> Feed
    </Link>
  );
  if (!id || error) {
    return (
      <div className="feed">
        {back}
        {error && !/not found/i.test(error) ? (
          <ErrorNote message={error} />
        ) : (
          <Empty title="This post isn't available" hint="It may have been removed, or it's from someone you don't follow." />
        )}
      </div>
    );
  }
  if (loading || !data) {
    return (
      <div className="feed">
        {back}
        <FeedSkeleton count={1} />
      </div>
    );
  }
  return (
    <div className="feed">
      {back}
      <PostCard post={data.post} detail />
      <section className="feed-thread">
        <Comments targetType="post" targetId={data.post.id} />
      </section>
    </div>
  );
}
