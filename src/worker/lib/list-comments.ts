// The list owner's own most-recent top-level comment per item,
// surfaced read-only inside each list card and linking back to the title page
// where a reader can actually reply. One windowed query for the whole list (no
// N+1). Shared by the owner's list endpoint (routes/lists.ts) and the public
// share (routes/public.ts) so the projection can't drift between the two views
// that were deliberately unified — the same comment must read identically to owner and
// visitor. Callers own the access decision (a shadow-banned owner's comments
// stay hidden from others; the owner endpoint is already ownership-checked).
export type OwnerComment = { body: string; createdAt: string; editedAt: string | null };

export function ownerListCommentsStmt(db: D1Database, listId: number, ownerId: number): D1PreparedStatement {
  return db
    .prepare(
      `SELECT type, id, body, created_at, edited_at FROM (
         SELECT c.target_type AS type, c.target_id AS id, c.body, c.created_at, c.edited_at,
                ROW_NUMBER() OVER (PARTITION BY c.target_type, c.target_id
                                   ORDER BY c.created_at DESC, c.id DESC) AS rn
         FROM comments c
         JOIN custom_list_items li ON li.list_id = ?1
           AND li.target_type = c.target_type AND li.target_id = c.target_id
         WHERE c.user_id = ?2 AND c.parent_id IS NULL AND c.deleted_at IS NULL
       ) WHERE rn = 1`
    )
    .bind(listId, ownerId);
}

// Key the rows by "type:id" so each item can look up its owner comment.
export function collectOwnerComments(rows: { type: string; id: number; body: string; created_at: string; edited_at: string | null }[]): Map<string, OwnerComment> {
  const m = new Map<string, OwnerComment>();
  for (const r of rows) m.set(`${r.type}:${r.id}`, { body: r.body, createdAt: r.created_at, editedAt: r.edited_at });
  return m;
}
