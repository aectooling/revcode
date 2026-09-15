import { useCallback, useEffect, useRef, useState } from "react";
import type { Mode } from "../components/console-panel";

export interface ConsoleDraft {
  version: 1; code: string; mode: Mode; steps: { name: string; code: string }[];
  verify: string; documentToken: string; sessionId: string | null;
}
type Api = <T>(path: string, body?: unknown) => Promise<T>;

/** Host storage follows an instance across port/origin changes. Writes are serialized. */
export function useConsoleDraft({ api, instanceId, online, draft, restore }: {
  api: Api; instanceId?: string; online: boolean; draft: ConsoleDraft; restore(draft: ConsoleDraft): void;
}) {
  const [status, setStatus] = useState("");
  const [loaded, setLoaded] = useState<string>();
  const latest = useRef(draft);
  const restoreRef = useRef(restore);
  latest.current = draft;
  restoreRef.current = restore;
  const queue = useRef(Promise.resolve());
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!online || !instanceId || loaded === instanceId) return;
    let disposed = false;
    const initial = JSON.stringify(latest.current);
    void api<{ draft: ConsoleDraft | null }>("/api/console-draft").then(result => {
      if (disposed) return;
      // A slow restore must never overwrite text typed since the request began.
      if (result.draft && JSON.stringify(latest.current) === initial) {
        restoreRef.current(result.draft);
        setStatus("Draft restored. Check the target before running.");
      }
      setLoaded(instanceId);
    }).catch(() => { if (!disposed) setStatus("Draft could not be restored. Editing remains available."); });
    return () => { disposed = true; };
  }, [api, online, instanceId, loaded, retry]);

  const serialized = JSON.stringify(draft);
  useEffect(() => {
    if (!online || loaded !== instanceId || !instanceId) return;
    let disposed = false;
    const timer = setTimeout(() => {
      const saving = JSON.parse(serialized) as ConsoleDraft;
      queue.current = queue.current.catch(() => {}).then(async () => {
        try { await api("/api/console-draft", saving); if (!disposed) setStatus("Draft saved"); }
        catch { if (!disposed) setStatus("Draft could not be saved. Your edits remain here."); }
      });
    }, 500);
    return () => { disposed = true; clearTimeout(timer); };
  }, [serialized, online, loaded, instanceId, api, retry]);
  const retrySave = useCallback(() => setRetry(value => value + 1), []);
  return { status: !online ? "Host offline; draft changes are not saved yet." : status, retrySave };
}
