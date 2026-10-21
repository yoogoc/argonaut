import { useEffect, useState } from "react";

/** The current time, re-rendering every `interval` ms while `active`, for live durations. */
export function useNow(active = true, interval = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setNow(Date.now()), interval);
    return () => window.clearInterval(id);
  }, [active, interval]);
  return now;
}
