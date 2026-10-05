// The session snapshot a panel renders, kept current: the panel re-reads it
// whenever the session says it changed (a restore landing after the panel
// mounted, a diagnostic from a background step, a save). `refresh` re-reads it
// after an action the panel itself started.

import { useEffect, useState } from "react";

import type { DataSourceSession, SessionState } from "../session";

export function useSessionSnapshot(session: DataSourceSession): [SessionState, () => void] {
  const [snapshot, setSnapshot] = useState(session.getState());
  useEffect(() => {
    const sub = session.onDidChange(() => setSnapshot(session.getState()));
    return () => sub.dispose();
  }, [session]);
  return [snapshot, () => setSnapshot(session.getState())];
}
