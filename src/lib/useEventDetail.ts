import { useEffect, useState } from "react";
import type { Dataset, SatEvent } from "../../shared/types.ts";
import { api, errorText } from "./api";

/**
 * `GET /api/events` trims each event's detections; the detail route returns all of them.
 * Returns the full event once loaded, otherwise the list version (`fallback`).
 */
export function useEventDetail(id: string | null, dataset: Dataset, fallback: SatEvent | null, version = "") {
  const [state, setState] = useState<{ key: string; event: SatEvent | null; error: string | null } | null>(null);
  const key = `${dataset}|${id ?? ""}|${version}`;

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    api
      .event(id, dataset)
      .then((event) => !cancelled && setState({ key, event, error: null }))
      .catch((e) => !cancelled && setState({ key, event: null, error: errorText(e) }));
    return () => {
      cancelled = true;
    };
  }, [id, dataset, key]);

  const mine = state?.key === key ? state : null;
  return {
    event: mine?.event ?? fallback,
    full: Boolean(mine?.event),
    loading: Boolean(id) && !mine,
    error: mine?.error ?? null,
  };
}
