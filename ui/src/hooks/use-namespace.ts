import { usePreferences } from "@/stores/preferences";
import { useSession } from "@/stores/session";

const FALLBACK = "argo";

/** The namespace list pages work in, chosen from the namespaces the server manages. */
export function useNamespace() {
  const info = useSession((s) => s.info);
  const remembered = usePreferences((s) => s.namespace);
  const setNamespace = usePreferences((s) => s.setNamespace);

  const namespaces = info?.managedNamespace ? [info.managedNamespace] : info?.namespaces?.length ? info.namespaces : [FALLBACK];
  const namespace = remembered && namespaces.includes(remembered) ? remembered : namespaces[0];
  return { namespace, setNamespace, namespaces };
}
