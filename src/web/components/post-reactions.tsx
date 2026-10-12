// Reactions on a feed post: Instagram's message-reaction model. A quick row
// of six emoji sits inline on the card; the "+" opens the full curated grid
// (shared/post-reactions.ts). One reaction per viewer per post — picking
// another replaces it, picking the current one clears it. Optimistic like
// the rail's ReactionButton (components/reactions.tsx): the local state flips
// now, the endpoint's authoritative tallies settle it, a rejection unwinds
// it. The grid popover reuses that component's mechanics: outside pointerdown
// / Escape / focus-out close it, arrow keys walk it (Up/Down by a row), and
// the current reaction takes focus on open.
import { useEffect, useRef, useState } from "react";
import { put } from "../api";
import { POST_REACTION_QUICK, POST_REACTION_ALL } from "../../shared/post-reactions";
import { IconPlus } from "./icons";

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
  // Own post: the controls render but can't be used (the endpoint refuses).
  disabled?: boolean;
  // "<user>'s post about <title>" for the accessible names.
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const mine = state.myReaction;

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

  useEffect(() => {
    if (open) itemRefs.current[Math.max(0, POST_REACTION_ALL.findIndex((r) => r === mine))]?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const onGridKey = (e: React.KeyboardEvent) => {
    const step =
      e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : e.key === "ArrowDown" ? GRID_COLS : e.key === "ArrowUp" ? -GRID_COLS : 0;
    if (!step) return;
    e.preventDefault();
    const options = itemRefs.current.filter((el): el is HTMLButtonElement => !!el);
    if (!options.length) return;
    const at = options.indexOf(document.activeElement as HTMLButtonElement);
    options[(at + step + options.length) % options.length]?.focus();
  };

  const pick = async (emoji: string) => {
    if (busy || disabled) return;
    const next = emoji === mine ? null : emoji; // re-picking clears
    const prev = state;
    setOpen(false);
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
        if (!wrapRef.current?.contains(e.relatedTarget as Node)) setOpen(false);
      }}
    >
      <div className="post-quick" role="group" aria-label={`React to ${label}`}>
        {POST_REACTION_QUICK.map((emoji) => (
          <button
            key={emoji}
            type="button"
            className={mine === emoji ? "react-option is-checked" : "react-option"}
            aria-pressed={mine === emoji}
            aria-label={mine === emoji ? `${emoji} — your reaction, pick again to remove` : `React ${emoji}`}
            title={title}
            disabled={disabled || busy}
            onClick={() => pick(emoji)}
          >
            <span aria-hidden="true">{emoji}</span>
          </button>
        ))}
        <button
          ref={triggerRef}
          type="button"
          className="icon-btn post-react-more"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label="More reactions"
          title={title ?? "More reactions"}
          disabled={disabled || busy}
          onClick={() => setOpen((o) => !o)}
        >
          <IconPlus size={16} />
        </button>
      </div>
      {open && (
        <div className="menu-pop menu-pop--grid" role="menu" aria-label={`React to ${label}`} onKeyDown={onGridKey}>
          {POST_REACTION_ALL.map((emoji, i) => (
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
        </div>
      )}
    </div>
  );
}
