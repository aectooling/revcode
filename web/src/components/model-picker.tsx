import { providerLabel } from "../lib/utils";
import type { ProviderSummary as Provider } from "../../../src/host/types";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "./ui/select";

const MANAGE = "__manage-providers__";

/** Compact trigger used inside the composer toolbar. */
export const toolbarTriggerClass =
  "h-7 w-auto max-w-[176px] min-w-0 gap-1.5 border-transparent bg-transparent px-2 text-xs font-medium text-ink-soft hover:border-transparent hover:bg-ink/[.06] hover:text-ink data-[placeholder]:text-muted";

export type ModelControlsProps = {
  connected: boolean;
  providers: Provider[];
  selected: { provider: string; model: string };
  onSelectModel(provider: string, modelId: string): void;
  onManageProvider(): void;
};

export function ModelControls({
  connected,
  providers,
  selected,
  onSelectModel,
  onManageProvider,
}: ModelControlsProps) {
  const groupedModels = providers.filter((provider) => provider.models.length > 0);

  if (connected && !groupedModels.length) {
    return (
      <button
        type="button"
        className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-sm px-2 text-xs font-semibold text-ink-soft transition-colors hover:bg-ink/[.06] hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        onClick={onManageProvider}
      >
        Connect your first provider
      </button>
    );
  }

  const modelValue = selected.model ? `${selected.provider}/${selected.model}` : "";

  return (
    <Select
      disabled={!connected}
      value={modelValue}
      onValueChange={(value) => {
        if (value === MANAGE) onManageProvider();
        else {
          const [provider, ...id] = value.split("/");
          if (provider && id.length) onSelectModel(provider, id.join("/"));
        }
      }}
    >
      <SelectTrigger aria-label="Model" className={toolbarTriggerClass}>
        <SelectValue placeholder="Waiting for models" />
      </SelectTrigger>
      <SelectContent align="start">
        {groupedModels.map(({ id: provider, models }) => (
          <SelectGroup key={provider}>
            <SelectLabel>{providerLabel(provider, providers)}</SelectLabel>
            {models.map((model) => (
              <SelectItem key={`${provider}/${model.id}`} value={`${provider}/${model.id}`}>
                {model.name ?? model.id}
              </SelectItem>
            ))}
          </SelectGroup>
        ))}
        <SelectSeparator />
        <SelectItem value={MANAGE} className="font-semibold text-ink-soft">
          Manage providers…
        </SelectItem>
      </SelectContent>
    </Select>
  );
}
