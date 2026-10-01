import type { Requirement } from "@/lib/frameworks/types";

/** Compact authoring format: "id|title" lines grouped by theme. */
export function group(name: string, lines: string, parentOf?: (id: string) => string | undefined): Requirement[] {
  return lines.trim().split("\n").map((line) => {
    const [id, title] = line.split("|").map((part) => part.trim());
    return { id, title, group: name, parent: parentOf?.(id) };
  });
}
