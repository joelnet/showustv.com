// Reddit-style comment threads. Wired up for episodes first, but generic
// over episode/movie/show targets like ratings. Mounted behind requireAuth.
//
// Reddit semantics implemented here:
//   * One vote per user per comment (-1/0/+1); posting auto-upvotes your own
//     comment, so scores start at 1.
//   * Sorts: top (raw score), best (Wilson lower bound — a 3-for-3 comment
//     shouldn't outrank a 95-for-100 one), new. Siblings sort independently
//     at every level, not globally.
//   * Soft delete keeps the thread shape: a deleted comment renders as
//     [deleted]/[deleted] but its replies survive; deleted subtrees with no
//     visible descendants are pruned entirely. Replying to or voting on a
//     deleted comment is rejected (Reddit's DELETED_COMMENT behavior).
//   * Large threads, Reddit's way: a response carries at most PAGE_BUDGET
//     nodes and MAX_DEPTH levels. Direct children that didn't fit the budget
//     collapse into a "load more comments (n)" stub carrying their ids
//     (Reddit's morechildren API); a node at the depth cap reports how many
//     descendants are hidden so the client can offer "continue this thread",
//     which re-roots via GET /:id/thread.
//
// Shaping happens in the worker, not SQL: one indexed query pulls the
// target's rows (an episode gathers thousands of comments at most, not
// Reddit-millions), the tree is built in memory, and only the shaped page is
// serialized. FETCH_CAP is the safety valve; because rows are ordered by
// (created_at, id) and a child is always newer than its parent, a truncated
// tail can only drop leaves, never orphan a kept child.

import { Hono } from "hono";
import type { Context } from "hono";
import type { AppEnv } from "../env";
import { nowIso } from "../lib/dates";
import { COMMENT_MAX_LEN, COMMENT_URL_RE } from "../../shared/constants";

export const comments = new Hono<AppEnv>();

const TARGET_TABLE: Record<string, { table: string; pk: string }> = {
  episode: { table: "episodes", pk: "id" },
  movie: { table: "movies", pk: "tmdb_id" },
  show: { table: "shows", pk: "tmdb_id" },
};

const MAX_DEPTH = 6; // replies below this render as "continue this thread"
const PAGE_BUDGET = 150; // max comment nodes serialized per response
const MORE_IDS_CAP = 1000; // ids a load-more stub can carry
const WRITE_DEPTH_CAP = 100; // hard nesting cap at write time; bounds recursion
const RATE_LIMIT = { count: 5, windowMs: 60_000 };
const FETCH_CAP = 5000;

const SORTS = ["top", "best", "new"] as const;
type Sort = (typeof SORTS)[number];
const parseSort = (raw: string | undefined): Sort =>
  (SORTS as readonly string[]).includes(raw ?? "") ? (raw as Sort) : "top";

interface Row {
  id: number;
  parent_id: number | null;
  user_id: number;
  body: string;
  created_at: string;
  deleted_at: string | null;
  username: string;
  user_deleted: string | null;
  ups: number;
  downs: number;
  my_vote: number;
}

interface TreeNode {
  row: Row;
  children: TreeNode[];
  visible: boolean; // false → pruned (deleted with no visible descendants)
  size: number; // visible nodes in this subtree, self included
  score: number;
  best: number;
}

interface MoreStub {
  count: number;
  ids: number[];
}

interface ApiNode {
  id: number;
  user: string | null; // null once the comment or its author is deleted
  mine: boolean;
  body: string | null; // null when deleted
  score: number;
  myVote: number;
  createdAt: string;
  deleted: boolean;
  children: ApiNode[];
  more: MoreStub | null; // direct children that didn't fit the budget
  deep: number; // descendants hidden below the depth cap
}

// Reddit's "best": lower bound of the Wilson score confidence interval on
// the upvote ratio, z = 1.28 (80%, Reddit's choice).
function wilson(ups: number, downs: number): number {
  const n = ups + downs;
  if (n === 0) return 0;
  const z = 1.281551565545;
  const p = ups / n;
  return (p + (z * z) / (2 * n) - z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n)) / (1 + (z * z) / n);
}

function cmp(sort: Sort) {
  const older = (a: TreeNode, b: TreeNode) =>
    a.row.created_at < b.row.created_at ? -1 : a.row.created_at > b.row.created_at ? 1 : a.row.id - b.row.id;
  if (sort === "new") return (a: TreeNode, b: TreeNode) => older(b, a);
  if (sort === "best") return (a: TreeNode, b: TreeNode) => b.best - a.best || older(a, b);
  return (a: TreeNode, b: TreeNode) => b.score - a.score || older(a, b);
}

// One query for the whole target, then tree-build + prune in memory.
async function loadTree(c: Context<AppEnv>, targetType: string, targetId: number) {
  const { results } = await c.env.DB.prepare(
    `SELECT c.id, c.parent_id, c.user_id, c.body, c.created_at, c.deleted_at,
            u.username, u.deleted_at AS user_deleted,
            COALESCE(SUM(v.value = 1), 0) AS ups,
            COALESCE(SUM(v.value = -1), 0) AS downs,
            COALESCE(MAX(CASE WHEN v.user_id = ?1 THEN v.value END), 0) AS my_vote
     FROM comments c
     JOIN users u ON u.id = c.user_id
     LEFT JOIN comment_votes v ON v.comment_id = c.id
     WHERE c.target_type = ?2 AND c.target_id = ?3
     GROUP BY c.id
     ORDER BY c.created_at, c.id
     LIMIT ?4`
  )
    .bind(c.get("uid"), targetType, targetId, FETCH_CAP)
    .all<Row>();

  const byId = new Map<number, TreeNode>();
  const roots: TreeNode[] = [];
  for (const row of results) {
    byId.set(row.id, { row, children: [], visible: true, size: 0, score: 0, best: 0 });
  }
  for (const node of byId.values()) {
    const parent = node.row.parent_id != null ? byId.get(node.row.parent_id) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  // Post-order: prune dead subtrees, count visible nodes, score.
  const finalize = (n: TreeNode): void => {
    let size = 0;
    for (const ch of n.children) {
      finalize(ch);
      size += ch.size;
    }
    n.children = n.children.filter((ch) => ch.visible);
    n.visible = !n.row.deleted_at || size > 0;
    n.size = n.visible ? size + 1 : 0;
    n.score = n.row.ups - n.row.downs;
    n.best = wilson(n.row.ups, n.row.downs);
  };
  roots.forEach(finalize);
  const visibleRoots = roots.filter((r) => r.visible);
  const total = visibleRoots.reduce((s, r) => s + r.size, 0);
  return { byId, roots: visibleRoots, total };
}

// Depth-first serialization under a shared node budget. When the budget runs
// out mid-sibling-list, the remainder becomes one load-more stub; a node at
// the depth cap keeps its children server-side and reports them as `deep`.
function shapeLevel(
  uid: number,
  nodes: TreeNode[],
  depth: number,
  state: { budget: number },
  sort: Sort
): { list: ApiNode[]; more: MoreStub | null } {
  const sorted = [...nodes].sort(cmp(sort));
  const list: ApiNode[] = [];
  for (let i = 0; i < sorted.length; i++) {
    if (state.budget <= 0) {
      const rest = sorted.slice(i);
      return {
        list,
        more: { count: rest.reduce((s, r) => s + r.size, 0), ids: rest.slice(0, MORE_IDS_CAP).map((r) => r.row.id) },
      };
    }
    state.budget--;
    const n = sorted[i];
    const deleted = !!n.row.deleted_at;
    const node: ApiNode = {
      id: n.row.id,
      user: deleted || n.row.user_deleted ? null : n.row.username,
      mine: !deleted && n.row.user_id === uid,
      body: deleted ? null : n.row.body,
      score: n.score,
      myVote: n.row.my_vote,
      createdAt: n.row.created_at,
      deleted,
      children: [],
      more: null,
      deep: 0,
    };
    if (depth >= MAX_DEPTH && n.children.length) {
      node.deep = n.size - 1;
    } else if (n.children.length) {
      const sub = shapeLevel(uid, n.children, depth + 1, state, sort);
      node.children = sub.list;
      node.more = sub.more;
    }
    list.push(node);
  }
  return { list, more: null };
}

const badTarget = (targetType: string, targetId: number) =>
  !TARGET_TABLE[targetType] || !Number.isInteger(targetId) || targetId <= 0;

// ---------- Routes ----------
// NB: /:id/thread is registered before /:type/:id so the literal segment wins.

// Continue-this-thread: the subtree below comment :id, re-rooted (depth and
// budget reset), like following a Reddit permalink deeper into a thread.
comments.get("/:id/thread", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: "bad id" }, 400);
  const target = await c.env.DB.prepare("SELECT target_type, target_id FROM comments WHERE id = ?1")
    .bind(id)
    .first<{ target_type: string; target_id: number }>();
  if (!target) return c.json({ error: "not found" }, 404);
  const { byId } = await loadTree(c, target.target_type, target.target_id);
  const node = byId.get(id);
  if (!node || !node.visible) return c.json({ error: "not found" }, 404);
  const sort = parseSort(c.req.query("sort"));
  const { list, more } = shapeLevel(c.get("uid"), node.children, 0, { budget: PAGE_BUDGET }, sort);
  return c.json({ comments: list, more });
});

// Full listing for a target. `count` is every visible comment (placeholders
// included), even the ones beyond this page's budget.
comments.get("/:type/:id", async (c) => {
  const targetType = c.req.param("type");
  const targetId = Number(c.req.param("id"));
  if (badTarget(targetType, targetId)) return c.json({ error: "bad target" }, 400);
  const sort = parseSort(c.req.query("sort"));
  const { roots, total } = await loadTree(c, targetType, targetId);
  const { list, more } = shapeLevel(c.get("uid"), roots, 0, { budget: PAGE_BUDGET }, sort);
  return c.json({ comments: list, more, count: total });
});

// Expand a load-more stub: shape the requested subtrees (Reddit's
// morechildren). Ids resolve inside the target's tree, so foreign or pruned
// ids just drop out.
comments.post("/more", async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const targetType = String(b.target_type ?? "");
  const targetId = Number(b.target_id);
  if (badTarget(targetType, targetId)) return c.json({ error: "bad target" }, 400);
  const sort = parseSort(typeof b.sort === "string" ? b.sort : undefined);
  const rawIds: unknown[] = Array.isArray(b.ids) ? b.ids : [];
  const ids = [...new Set(rawIds.map(Number))].filter((n) => Number.isInteger(n) && n > 0).slice(0, MORE_IDS_CAP);
  if (!ids.length) return c.json({ comments: [], more: null });
  const { byId } = await loadTree(c, targetType, targetId);
  const nodes = ids.flatMap((id) => {
    const n = byId.get(id);
    return n && n.visible ? [n] : [];
  });
  const { list, more } = shapeLevel(c.get("uid"), nodes, 0, { budget: PAGE_BUDGET }, sort);
  return c.json({ comments: list, more });
});

// Post a comment or reply. Returns the shaped node so the client can splice
// it in without refetching the thread.
comments.post("/", async (c) => {
  const uid = c.get("uid");
  const b = await c.req.json().catch(() => ({}));
  const targetType = String(b.target_type ?? "");
  const targetId = Number(b.target_id);
  const parentId = b.parent_id == null ? null : Number(b.parent_id);
  const body = String(b.body ?? "").trim();

  if (badTarget(targetType, targetId)) return c.json({ error: "bad target" }, 400);
  if (parentId != null && (!Number.isInteger(parentId) || parentId <= 0)) return c.json({ error: "bad parent" }, 400);
  if (!body) return c.json({ error: "Comment can't be empty" }, 400);
  if (body.length > COMMENT_MAX_LEN) return c.json({ error: `Keep it under ${COMMENT_MAX_LEN} characters` }, 400);
  if (COMMENT_URL_RE.test(body)) return c.json({ error: "Links aren't allowed in comments" }, 400);

  const t = TARGET_TABLE[targetType];
  const exists = await c.env.DB.prepare(`SELECT 1 FROM ${t.table} WHERE ${t.pk} = ?1`).bind(targetId).first();
  if (!exists) return c.json({ error: `no such ${targetType}` }, 404);

  if (parentId != null) {
    const parent = await c.env.DB.prepare("SELECT target_type, target_id, deleted_at FROM comments WHERE id = ?1")
      .bind(parentId)
      .first<{ target_type: string; target_id: number; deleted_at: string | null }>();
    if (!parent || parent.target_type !== targetType || parent.target_id !== targetId)
      return c.json({ error: "no such comment" }, 404);
    if (parent.deleted_at) return c.json({ error: "You can't reply to a deleted comment" }, 400);
    // Walk ancestors to bound nesting — display handles depth gracefully,
    // but shaping recursion must not.
    const depth = await c.env.DB.prepare(
      `WITH RECURSIVE anc(pid, d) AS (
         SELECT parent_id, 1 FROM comments WHERE id = ?1
         UNION ALL
         SELECT p.parent_id, anc.d + 1 FROM comments p JOIN anc ON p.id = anc.pid
         WHERE anc.d < ?2
       ) SELECT MAX(d) AS d FROM anc`
    )
      .bind(parentId, WRITE_DEPTH_CAP + 1)
      .first<{ d: number }>();
    if ((depth?.d ?? 0) >= WRITE_DEPTH_CAP) return c.json({ error: "This thread is too deep — reply higher up" }, 400);
  }

  const since = new Date(Date.now() - RATE_LIMIT.windowMs).toISOString();
  const recent = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM comments WHERE user_id = ?1 AND created_at > ?2")
    .bind(uid, since)
    .first<{ n: number }>();
  if ((recent?.n ?? 0) >= RATE_LIMIT.count)
    return c.json({ error: "You're commenting too fast — give it a minute" }, 429);

  const row = await c.env.DB.prepare(
    "INSERT INTO comments (target_type, target_id, user_id, body, parent_id) VALUES (?1, ?2, ?3, ?4, ?5) RETURNING id, created_at"
  )
    .bind(targetType, targetId, uid, body, parentId)
    .first<{ id: number; created_at: string }>();
  // Reddit auto-upvotes your own comment; best-effort — a miss just means a
  // score of 0 instead of 1.
  await c.env.DB.prepare("INSERT INTO comment_votes (comment_id, user_id, value) VALUES (?1, ?2, 1)")
    .bind(row!.id, uid)
    .run();
  const me = await c.env.DB.prepare("SELECT username FROM users WHERE id = ?1").bind(uid).first<{ username: string }>();

  const node: ApiNode = {
    id: row!.id,
    user: me?.username ?? null,
    mine: true,
    body,
    score: 1,
    myVote: 1,
    createdAt: row!.created_at,
    deleted: false,
    children: [],
    more: null,
    deep: 0,
  };
  return c.json({ comment: node }, 201);
});

// Vote: 1 up, -1 down, 0 clears. Returns the authoritative score so the
// client's optimistic math self-corrects.
comments.put("/:id/vote", async (c) => {
  const uid = c.get("uid");
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: "bad id" }, 400);
  const b = await c.req.json().catch(() => ({}));
  const value = Number(b.value);
  if (![-1, 0, 1].includes(value)) return c.json({ error: "vote must be -1, 0, or 1" }, 400);

  const cm = await c.env.DB.prepare("SELECT deleted_at FROM comments WHERE id = ?1")
    .bind(id)
    .first<{ deleted_at: string | null }>();
  if (!cm) return c.json({ error: "not found" }, 404);
  if (cm.deleted_at) return c.json({ error: "You can't vote on a deleted comment" }, 400);

  if (value === 0) {
    await c.env.DB.prepare("DELETE FROM comment_votes WHERE comment_id = ?1 AND user_id = ?2").bind(id, uid).run();
  } else {
    await c.env.DB.prepare(
      `INSERT INTO comment_votes (comment_id, user_id, value) VALUES (?1, ?2, ?3)
       ON CONFLICT (comment_id, user_id) DO UPDATE SET value = excluded.value`
    )
      .bind(id, uid, value)
      .run();
  }
  const s = await c.env.DB.prepare("SELECT COALESCE(SUM(value), 0) AS score FROM comment_votes WHERE comment_id = ?1")
    .bind(id)
    .first<{ score: number }>();
  return c.json({ score: s?.score ?? 0 });
});

// Delete own comment, Reddit-style: the row stays so replies keep their
// place, but the body is wiped here and now — deletion is a privacy action,
// not a display flag. Idempotent for the author.
comments.delete("/:id", async (c) => {
  const uid = c.get("uid");
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: "bad id" }, 400);
  const { meta } = await c.env.DB.prepare(
    "UPDATE comments SET deleted_at = ?3, body = '' WHERE id = ?1 AND user_id = ?2 AND deleted_at IS NULL"
  )
    .bind(id, uid, nowIso())
    .run();
  if (!meta.changes) {
    const mine = await c.env.DB.prepare("SELECT 1 FROM comments WHERE id = ?1 AND user_id = ?2").bind(id, uid).first();
    if (!mine) return c.json({ error: "not found" }, 404);
  }
  return c.json({ ok: true });
});
