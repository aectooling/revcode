import { Loader2, WifiOff } from "lucide-react";
import { cn } from "../lib/utils";

export function ConnectionBanner({
  hostOnline,
  revitConnected,
  detail,
}: {
  hostOnline: boolean;
  revitConnected: boolean;
  detail: string;
}) {
  if (hostOnline && revitConnected) return null;
  const lost = !hostOnline;
  return (
    <div
      role="status"
      className={cn(
        "flex shrink-0 items-center gap-3 border-b px-4 py-1.5 text-xs shadow-sm sm:px-6",
        lost ? "border-danger/20 bg-danger-soft text-danger" : "border-warn/20 bg-warn-soft text-warn",
      )}
    >
      {lost ? (
        <WifiOff className="size-4 shrink-0" />
      ) : (
        <Loader2 className="size-4 shrink-0 animate-spin" />
      )}
      <div className="min-w-0 flex-1">
        <span className="font-medium">
          {lost ? "Can't reach the local Revcode host." : "Waiting for Revit"}
        </span>
        <span className="ml-1.5 opacity-80">
          {detail ||
            (lost
              ? "Reconnecting automatically."
              : "Open Revcode from the Revit ribbon. Commands are never replayed.")}
        </span>
      </div>
    </div>
  );
}
