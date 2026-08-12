// App-wide confirm dialog. Imperative, promise-based:
//
//   const confirm = useConfirm();
//   const res = await confirm({ title, message, confirmLabel, cancelLabel });
//   // true  → confirm button, false → cancel button, null → dismissed (Esc/backdrop)
//
// Built on native <dialog> for focus trapping and Esc handling.
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

export interface ConfirmOptions {
  title: string;
  // Nodes, not just a string: dates and counts inside a confirm are
  // production metadata and set in mono (`<strong>` in .dialog-body), so the
  // thing you're confirming is typeset the same as the row you tapped
  // (DESIGN.md, the Printed-On-The-Tape rule).
  message?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean | null>;

const ConfirmCtx = createContext<ConfirmFn>(async () => null);

export const useConfirm = () => useContext(ConfirmCtx);

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [req, setReq] = useState<{ opts: ConfirmOptions; resolve: (r: boolean | null) => void } | null>(null);
  const ref = useRef<HTMLDialogElement>(null);
  const resultRef = useRef<boolean | null>(null);
  // The button the dialog should open on: the confirm normally, the cancel on
  // a destructive one. It needs a ref because React's `autoFocus` prop is not
  // the HTML `autofocus` ATTRIBUTE — React calls focus() during commit, and
  // showModal() then runs the spec's own focus algorithm, which finds no
  // autofocus attribute and lands on the first focusable child. So every
  // dialog opened on Cancel, and Enter on "Watch it again?" cancelled the
  // rewatch the user had just asked for.
  const focusRef = useRef<HTMLButtonElement>(null);

  const confirm = useCallback<ConfirmFn>(
    (opts) =>
      new Promise((resolve) => {
        resultRef.current = null;
        setReq({ opts, resolve });
      }),
    []
  );

  useEffect(() => {
    if (!req) return;
    ref.current?.showModal();
    focusRef.current?.focus(); // after showModal(), which would otherwise win
  }, [req]);

  const requestClose = (r: boolean | null) => {
    resultRef.current = r;
    ref.current?.close();
  };

  return (
    <ConfirmCtx.Provider value={confirm}>
      {children}
      {req && (
        <dialog
          ref={ref}
          className="dialog"
          onClose={() => {
            req.resolve(resultRef.current);
            setReq(null);
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget) requestClose(null); // backdrop
          }}
        >
          <div className="dialog-body">
            <h2>{req.opts.title}</h2>
            {req.opts.message && <p>{req.opts.message}</p>}
            <div className="dialog-actions">
              <button
                type="button"
                className="btn btn-ghost"
                ref={req.opts.danger ? focusRef : null}
                onClick={() => requestClose(false)}
              >
                {req.opts.cancelLabel ?? "Cancel"}
              </button>
              <button
                type="button"
                className={`btn${req.opts.danger ? " btn-solid-danger" : ""}`}
                ref={req.opts.danger ? null : focusRef}
                onClick={() => requestClose(true)}
              >
                {req.opts.confirmLabel ?? "OK"}
              </button>
            </div>
          </div>
        </dialog>
      )}
    </ConfirmCtx.Provider>
  );
}
