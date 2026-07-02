import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { onRevalidate } from "./offline";

interface ApiState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

// Stale-while-revalidate: a reload() (or same-path refetch) keeps the current
// data on screen and swaps it silently — only the first load or a path change
// shows a loading state.
export function useApi<T = any>(path: string | null) {
  const [state, set] = useState<ApiState<T>>({ data: null, loading: !!path, error: null });
  const [tick, setTick] = useState(0);
  const prevPath = useRef<string | null>(null);

  useEffect(() => {
    if (!path) return;
    let live = true;
    const pathChanged = prevPath.current !== path;
    prevPath.current = path;
    set((s) => ({
      data: pathChanged ? null : s.data,
      loading: pathChanged || s.data == null,
      error: null,
    }));
    api<T>(path)
      .then((data) => live && set({ data, loading: false, error: null }))
      .catch((e) => live && set({ data: null, loading: false, error: e.message }));
    return () => {
      live = false;
    };
  }, [path, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);

  // Refetch when connectivity returns or queued offline changes finish
  // syncing — stale cache-served data on screen gets replaced silently.
  useEffect(() => onRevalidate(reload), [reload]);

  return { ...state, reload };
}
