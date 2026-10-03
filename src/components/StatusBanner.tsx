import { useSatfire } from "../lib/store";
import { SampleBadge } from "./badges";

/** Whole-app banners: sample dataset, heartbeat warning, FIRMS error, load failures. */
export default function StatusBanner() {
  const { dataset, status, errors } = useSatfire();
  const firmsError = status?.lastRun?.firmsError ?? null;
  return (
    <>
      {dataset === "sample" && (
        <div className="flex flex-wrap items-center gap-2 border-b border-amber-700/40 bg-amber-100 px-4 py-1.5 text-xs text-amber-950" role="status">
          <SampleBadge title="The whole dataset is sample data" />
          <span>
            Viewing the <b>sample scenario dataset</b> served by the backend. Detections, polygons, history and SAR results here are labelled sample data, not live observations.
            The Dozier solve, spatial join, classification and rule trace are computed on it by the same pipeline.
          </span>
        </div>
      )}
      {status?.heartbeat.warning && (
        <div className="border-b border-red-800/40 bg-red-50 px-4 py-1.5 text-xs font-semibold text-red-900" role="alert">
          Heartbeat warning: {status.heartbeat.warning}
        </div>
      )}
      {firmsError && (
        <div className="border-b border-red-800/40 bg-red-50 px-4 py-1.5 text-xs text-red-900" role="alert">
          <span className="font-semibold">FIRMS error on last run:</span> <span className="font-mono">{firmsError}</span>
        </div>
      )}
      {dataset === "live" && status && !status.firmsConfigured && (
        <div className="border-b border-amber-700/40 bg-amber-50 px-4 py-1.5 text-xs text-amber-950">
          No FIRMS key is configured on the backend, so the live dataset has no detections. Switch to “Sample scenarios” to see the pipeline on labelled sample data.
        </div>
      )}
      {errors.length > 0 && (
        <div className="border-b border-red-800/40 bg-red-50 px-4 py-1.5 text-xs text-red-900" role="alert">
          Some data failed to load: <span className="font-mono">{errors.join(" · ")}</span>
        </div>
      )}
    </>
  );
}
