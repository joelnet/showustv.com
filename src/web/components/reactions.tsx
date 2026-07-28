// The reaction control on "From People You Follow" tiles (#20): a thumbs-up
// trigger pinned to the tile's bottom-right (the mark-watched check's overlay
// pattern) that opens a small Facebook-familiar picker — one horizontal row
// of 👍 ❤️ 😂 😮 😢 — just above it. Picking sets the viewer's one reaction
// on that activity, picking the current one again clears it, and the tile's
// total count rides beside the trigger. The popover reuses the profile bell
// menu's mechanics (public-profile.tsx): outside pointerdown / Escape /
// focus-out close it, arrow keys walk the options, and the current reaction
// takes focus on open. Optimistic like the check button: the trigger flips
// immediately, the response's authoritative state (or a rejection) settles
// it, and fresh /home data resets the override wholesale.
import { useEffect, useRef, useState } from "react";
import { put } from "../api";
import { REACTION_TYPES, REACTION_EMOJI, REACTION_LABELS, type ReactionType } from "../../shared/reactions";
import { IconThumbsUp } from "./icons";
import type { TileItem } from "./tiles";

export function ReactionButton({ item }: { item: TileItem }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  // The viewer's optimistic state, layered over the /home payload's. Reset
  // identity-keyed on the item like the tile's mark-watched check: a refetch
  // hands back a new object carrying the server's truth, so the override
  // drops rather than shadow it.
  const [override, setOverride] = useState<{ mine: ReactionType | null; count: number } | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  useEffect(() => {
    setOverride(null);
  }, [item]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const mine = override ? override.mine : ((item.myReaction as ReactionType | null | undefined) ?? null);
  const count = override ? override.count : (item.reactionCount ?? 0);

  // Land keyboard users on their current reaction when the picker opens
  // (the first option when they have none).
  useEffect(() => {
    if (open) itemRefs.current[Math.max(0, REACTION_TYPES.findIndex((r) => r === mine))]?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Arrow keys walk the horizontal row, wrapping at the ends — the bell
  // menu's keyboard model, turned sideways.
  const onMenuKey = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const options = itemRefs.current.filter((el): el is HTMLButtonElement => !!el);
    if (!options.length) return;
    const at = options.indexOf(document.activeElement as HTMLButtonElement);
    options[(at + (e.key === "ArrowRight" ? 1 : -1) + options.length) % options.length]?.focus();
  };

  const pick = async (value: ReactionType) => {
    if (busy || !item.username) return;
    const next = value === mine ? null : value; // re-picking the current one clears it
    const prev = { mine, count };
    setOpen(false);
    triggerRef.current?.focus();
    // Optimistic — the response's authoritative state lands right after.
    setOverride({ mine: next, count: Math.max(0, count + (next == null ? -1 : mine == null ? 1 : 0)) });
    setBusy(true);
    try {
      const d = await put("/social/reaction", {
        username: item.username,
        targetType: item.kind,
        targetId: item.id,
        reaction: next,
      });
      setOverride({ mine: (d?.reaction as ReactionType | null) ?? null, count: Number(d?.count ?? 0) });
    } catch {
      setOverride(prev); // rejected/offline — unwind the optimistic flip
    } finally {
      setBusy(false);
    }
  };

  const state = mine
    ? `You reacted ${REACTION_LABELS[mine]} to ${item.username}'s activity on ${item.title}`
    : `React to ${item.username}'s activity on ${item.title}`;

  return (
    // .wn-tile-react keeps this wrap static so the picker positions against
    // the TILE (the nearest positioned ancestor), never against the 34px
    // trigger — that's what keeps it inside the tile's bounds, where the
    // row scroller can't clip it.
    <div
      className="menu-wrap wn-tile-react"
      ref={wrapRef}
      onBlur={(e) => {
        // Tabbing (or clicking) out of the control closes the picker.
        if (!wrapRef.current?.contains(e.relatedTarget as Node)) setOpen(false);
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className="icon-btn react-btn"
        disabled={busy}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={count > 0 ? `${state} — ${count} reaction${count === 1 ? "" : "s"}` : state}
        title={state}
        onClick={() => setOpen((o) => !o)}
      >
        {mine ? (
          <span className="react-emoji" aria-hidden="true">
            {REACTION_EMOJI[mine]}
          </span>
        ) : (
          <IconThumbsUp size={16} />
        )}
        {count > 0 && <span className="react-count">{count}</span>}
      </button>
      {open && (
        <div
          className="menu-pop menu-pop--react"
          role="menu"
          aria-label={`React to ${item.username}'s activity on ${item.title}`}
          onKeyDown={onMenuKey}
        >
          {REACTION_TYPES.map((value, i) => (
            <button
              key={value}
              ref={(el) => {
                itemRefs.current[i] = el;
              }}
              type="button"
              role="menuitemradio"
              aria-checked={mine === value}
              className={mine === value ? "react-option is-checked" : "react-option"}
              aria-label={mine === value ? `${REACTION_LABELS[value]} — selected, pick again to remove` : REACTION_LABELS[value]}
              title={REACTION_LABELS[value]}
              onClick={() => pick(value)}
            >
              <span aria-hidden="true">{REACTION_EMOJI[value]}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
