// The authorization revision this browser has seen (DESIGN §4.3). Every response may carry
// X-Authz-Revision; requests send back the highest one so a replica that has not caught up reloads
// before deciding, which is what makes "grant, then immediately use it" work across replicas.

type Listener = (revision: number) => void;

let current = 0;
const listeners = new Set<Listener>();

export function getRevision(): number {
  return current;
}

export function observeRevision(value: string | null | undefined) {
  const next = Number(value);
  if (!Number.isFinite(next) || next <= current) return;
  current = next;
  listeners.forEach((listener) => listener(next));
}

export function onRevisionChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
