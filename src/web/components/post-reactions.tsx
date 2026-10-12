// Reactions on a feed post: Instagram's message-reaction model behind a
// single heart. The outline heart (or the viewer's current emoji) opens a
// popover with the six quick emoji; its "+" swaps the popover for the full
// curated grid (shared/post-reactions.ts). One reaction per viewer per post —
// picking another replaces it, picking the current one clears it. Optimistic
// like the rail's ReactionButton (components/reactions.tsx): the local state
// flips now, the endpoint's authoritative tallies settle it, a rejection
// unwinds it. The popover reuses that component's mechanics: outside
// pointerdown / Escape / focus-out close it, arrow keys walk it (Up/Down by a
// row in the grid), and the current reaction takes focus on open.
import { useEffect, useRef, useState } from "react";
import { put } from "../api";
import { POST_REACTION_QUICK, POST_REACTION_ALL } from "../../shared/post-reactions";
import { IconHeartOutline, IconPlus } from "./icons";

export interface ReactionState {
  myReaction: string | null;
  reactions: { emoji: string; count: number }[];
}

const GRID_COLS = 8; // keep in sync with .menu-pop--grid

// The local tally after the viewer moves from `state.myReaction` to `next`.
function applyLocal(state: ReactionState, next: string | null): ReactionState {
  const list = state.reactions.map((r) => ({ ...r }));
  const bump = (emoji: string, by: number) => {
    const r = list.find((x) => x.emoji === emoji);
    if (r) r.count += by;
    else if (by > 0) list.push({ emoji, count: by });
  };
  if (state.myReaction) bump(state.myReaction, -1);
  if (next) bump(next, 1);
  return { myReaction: next, reactions: list.filter((r) => r.count > 0) };
}

export function PostReactions({
  postId,
  state,
  onState,
  disabled,
  label,
}: {
  postId: number;
  state: ReactionState;
  onState: (next: ReactionState) => void;
  // Own post: the control renders but can't be used (the endpoint refuses).
  disabled?: boolean;
  // "<user>'s post about <title>" for the accessible names.
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const [full, setFull] = useState(false); // quick row (false) or the whole grid
  const [busy, setBusy] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const mine = state.myReaction;
  const options: readonly string[] = full ? POST_REACTION_ALL : POST_REACTION_QUICK;

  const close = () => {
    setOpen(false);
    setFull(false);
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        close();
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

  // On open (and when the "+" expands the grid) focus the current reaction,
  // or the first option.
  useEffect(() => {
    if (open) itemRefs.current[Math.max(0, options.findIndex((r) => r === mine))]?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, full]);

  const onMenuKey = (e: React.KeyboardEvent) => {
    const row = full ? GRID_COLS : 1;
    const step =
      e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : e.key === "ArrowDown" ? row : e.key === "ArrowUp" ? -row : 0;
    if (!step) return;
    e.preventDefault();
    const els = itemRefs.current.filter((el): el is HTMLButtonElement => !!el);
    if (!els.length) return;
    const at = els.indexOf(document.activeElement as HTMLButtonElement);
    els[(at + step + els.length) % els.length]?.focus();
  };

  const pick = async (emoji: string) => {
    if (busy || disabled) return;
    const next = emoji === mine ? null : emoji; // re-picking clears
    const prev = state;
    close();
    triggerRef.current?.focus();
    onState(applyLocal(state, next));
    setBusy(true);
    try {
      const d = await put(`/feed/posts/${postId}/reaction`, { emoji: next });
      onState({
        myReaction: (d?.myReaction as string | null) ?? null,
        reactions: Array.isArray(d?.reactions) ? d.reactions : [],
      });
    } catch {
      onState(prev); // rejected/offline — unwind the optimistic flip
    } finally {
      setBusy(false);
    }
  };

  const title = disabled ? "You can't react to your own post" : undefined;

  return (
    <div
      className="menu-wrap post-react"
      ref={wrapRef}
      onBlur={(e) => {
        if (!wrapRef.current?.contains(e.relatedTarget as Node)) close();
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className={mine ? "icon-btn post-react-btn is-reacted" : "icon-btn post-react-btn"}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={mine ? `Your reaction ${mine} to ${label} — change it` : `React to ${label}`}
        title={title ?? (mine ? "Change your reaction" : "React")}
        disabled={disabled || busy}
        onClick={() => (open ? close() : setOpen(true))}
      >
        {mine ? <span aria-hidden="true">{mine}</span> : <IconHeartOutline size={22} />}
      </button>
      {open && (
        <div
          className={full ? "menu-pop menu-pop--grid" : "menu-pop menu-pop--quick"}
          role="menu"
          aria-label={`React to ${label}`}
          onKeyDown={onMenuKey}
        >
          {options.map((emoji, i) => (
            <button
              key={emoji}
              ref={(el) => {
                itemRefs.current[i] = el;
              }}
              type="button"
              role="menuitemradio"
              aria-checked={mine === emoji}
              className={mine === emoji ? "react-option is-checked" : "react-option"}
              aria-label={mine === emoji ? `${emoji} — selected, pick again to remove` : emoji}
              onClick={() => pick(emoji)}
            >
              <span aria-hidden="true">{emoji}</span>
            </button>
          ))}
          {!full && (
            <button
              ref={(el) => {
                itemRefs.current[options.length] = el;
              }}
              type="button"
              role="menuitem"
              className="react-option post-react-more"
              aria-label="More reactions"
              onClick={() => {
                itemRefs.current = [];
                setFull(true);
              }}
            >
              <IconPlus size={16} />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
