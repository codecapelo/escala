import { useState, useEffect } from "react";
import { api, message } from "./api";
export function useResource<T>(path: string, version = 0) {
  const [data, setData] = useState<T | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [retry, setRetry] = useState(0);
  useEffect(() => {
    let live = true;
    setLoading(true);
    setError("");
    api<T>(path)
      .then((d) => {
        if (live) setData(d);
      })
      .catch((e) => {
        if (live) setError(message(e));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [path, version, retry]);
  return { data, loading, error, reload: () => setRetry((v) => v + 1) };
}
