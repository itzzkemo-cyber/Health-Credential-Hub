import { clearAuthSession } from "@/lib/auth";
import { shouldShowShowcaseRoleButtons } from "./showcase-visibility";

export { shouldShowShowcaseRoleButtons } from "./showcase-visibility";

const showcaseFiles = new Map<string, string>();

export const isShowcaseMode = shouldShowShowcaseRoleButtons(
  import.meta.env.MODE,
);

export function retainShowcaseFile(blob: Blob): string {
  const id =
    globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  const objectPath = `/objects/showcase/${id}`;
  showcaseFiles.set(objectPath, URL.createObjectURL(blob));
  return objectPath;
}

export function resolveShowcaseFile(objectPath: string): string | null {
  return showcaseFiles.get(objectPath) ?? null;
}

export function resetShowcase(): void {
  showcaseFiles.forEach((url) => URL.revokeObjectURL(url));
  showcaseFiles.clear();
  clearAuthSession();
  window.location.assign(import.meta.env.BASE_URL);
}
