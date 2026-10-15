// The feed (/feed): what the people you follow are watching, as a column
// of posts newest sitting first — your own watches included, Instagram
// style.
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { useApi, useDocumentTitle } from "../hooks";
import { Empty, ErrorNote } from "../components/ui";
import { FeedSkeleton } from "../components/skeleton";
import { IconUsers } from "../components/icons";
import { PostCard } from "../components/post-card";
import type { FeedPost } from "../../shared/feed";

interface FeedResponse {
  posts: FeedPost[];
  nextCursor: string | null;
}

export function FeedPage() {
  useDocumentTitle("Feed");
  const { data, loading, error } = useApi<FeedResponse>("/feed");
  // Pages after the first append here; a refetch of page one (new data
  // object) drops them so the list can't duplicate.
  const [extra, setExtra] = useState<{ posts: FeedPost[]; cursor: string | null } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  useEffect(() => setExtra(null), [data]);

  const head = (
    <div className="feed-head">
      <h1 className="page-title">Feed</h1>
      <Link to="/following" className="icon-btn feed-people" aria-label="People you follow" title="People you follow">
        <IconUsers size={20} />
      </Link>
    </div>
  );

  if (error) {
    return (
      <div className="feed">
        {head}
        <ErrorNote message={error} />
      </div>
    );
  }
  if (loading || !data) {
    return (
      <div className="feed">
        {head}
        <FeedSkeleton />
      </div>
    );
  }

  const posts = [...data.posts, ...(extra?.posts ?? [])];
  const cursor = extra ? extra.cursor : data.nextCursor;

  return (
    <div className="feed">
      {head}
      {!posts.length ? (
        <Empty
          title="Nothing on the air yet"
          hint="Posts show up here when you, or the people you follow, watch something."
        />
      ) : (
        <>
          {posts.map((p) => (
            <PostCard key={p.id} post={p} />
          ))}
          {moreError && <ErrorNote message={moreError} />}
          {cursor && (
            <button
              type="button"
              className="btn btn-ghost feed-more"
              disabled={loadingMore}
              onClick={async () => {
                setLoadingMore(true);
                setMoreError(null);
                try {
                  const d = await api<FeedResponse>(`/feed?before=${encodeURIComponent(cursor)}`);
                  setExtra((cur) => ({ posts: [...(cur?.posts ?? []), ...d.posts], cursor: d.nextCursor }));
                } catch (e: any) {
                  setMoreError(e.message);
                } finally {
                  setLoadingMore(false);
                }
              }}
            >
              {loadingMore ? "Loading…" : "Load more"}
            </button>
          )}
        </>
      )}
    </div>
  );
}
