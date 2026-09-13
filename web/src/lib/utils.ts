import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function providerLabel(
  id: string | null | undefined,
  providers: Array<{ id: string; name?: string }> = [],
) {
  if (!id) return "Provider";
  return (
    providers.find((provider) => provider.id === id)?.name ??
    id.replace(/-/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase())
  );
}

export function safeExternalUrl(value?: string) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ||
      (url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}
