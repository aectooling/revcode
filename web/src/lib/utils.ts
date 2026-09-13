import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function titleCase(value: string) {
  return String(value ?? "")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

const PROVIDER_NAMES: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  "openai-codex": "OpenAI Codex",
  google: "Google",
};

export function providerLabel(
  id: string | null | undefined,
  providers: Array<{ id: string; name?: string }> = [],
) {
  if (!id) return "Provider";
  return (
    providers.find((provider) => provider.id === id)?.name ??
    PROVIDER_NAMES[id] ??
    titleCase(id)
  );
}
