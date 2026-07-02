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
  message?: string;
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

  const confirm = useCallback<ConfirmFn>(
    (opts) =>
      new Promise((resolve) => {
        resultRef.current = null;
        setReq({ opts, resolve });
      }),
    []
  );

  useEffect(() => {
    if (req) ref.current?.showModal();
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
                autoFocus={req.opts.danger}
                onClick={() => requestClose(false)}
              >
                {req.opts.cancelLabel ?? "Cancel"}
              </button>
              <button
                type="button"
                className={`btn${req.opts.danger ? " btn-solid-danger" : ""}`}
                autoFocus={!req.opts.danger}
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
