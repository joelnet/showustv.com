// Read-only list view — a non-owner (or signed-out visitor from a shared
// link) sees this at /u/:username/lists/:id-slug when the owner has made the
// list public. Renders inside PublicShell (signed-out) or the app Shell
// (signed-in), so it returns just the content, no chrome of its own — the
// owner gets the editable ListDetailPage at the same URL instead.
import { useEffect } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { useApi } from "../hooks";
import { useAuth } from "../app";
import { SmpteBars } from "../components/ui";
import { ShareButton } from "../components/share";
import { PubListSkeleton } from "../components/skeleton";
import { ListItems, ListByline, ListComments, type ListViewItem } from "../components/list-view";
import { idFromParam, publicListPath } from "../paths";

interface PublicList {
  list: {
    id: number;
    name: string;
    username: string;
    preamble: string | null;
    commentsEnabled: boolean;
  };
  items: ListViewItem[];
}

export function PublicListPage() {
  const { username } = useParams();
  const id = idFromParam(useParams().id); // tolerate the "2-favorites" slug suffix
  const location = useLocation();
  const navigate = useNavigate();
  const { data, loading, error } = useApi<PublicList>(`/public/lists/${encodeURIComponent(username!)}/${id}`);
  const { user } = useAuth();

  // Canonicalize the address bar to the slugged URL once the name is known,
  // matching the show/movie detail pages.
  useEffect(() => {
    if (!data) return;
    const canonical = publicListPath(data.list.username, data.list.id, data.list.name);
    if (location.pathname !== canonical) navigate(canonical + location.search, { replace: true });
  }, [data, location.pathname, location.search, navigate]);

  return (
    <>
      {loading ? (
        <PubListSkeleton />
      ) : error || !data ? (
        <div className="empty">
          <SmpteBars />
          <h3>Nothing to see here</h3>
          <p>This list is private or doesn&rsquo;t exist.</p>
        </div>
      ) : (
        <>
          {/* Share sits right of the name, icon-only, mirroring
              the public profile header. This page only renders for public
              lists (the server 404s private ones), so it's always safe. */}
          <div className="list-title-wrap">
            <h1 className="page-title">{data.list.name}</h1>
            <ShareButton
              variant="icon"
              title={data.list.name}
              text={`A list by ${data.list.username} on Show Us TV.`}
              path={publicListPath(data.list.username, data.list.id, data.list.name)}
            />
          </div>
          <ListByline username={data.list.username} count={data.items.length} />
          {data.list.preamble && <p className="list-preamble">{data.list.preamble}</p>}
          <ListItems items={data.items} username={data.list.username} />
          {/* The public route only ever renders a shared list (the server 404s
              private ones), so isShared is always true here. */}
          <ListComments
            id={data.list.id}
            commentsEnabled={data.list.commentsEnabled}
            isShared
            viewerSignedIn={!!user}
          />
        </>
      )}
    </>
  );
}
