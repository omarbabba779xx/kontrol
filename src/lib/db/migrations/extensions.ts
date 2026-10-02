import { identity } from "@/lib/db/migrations/m0002-identity";
import { scheduling } from "@/lib/db/migrations/m0003-scheduling";
import { tasksNotifications } from "@/lib/db/migrations/m0004-tasks-notifications";
import type { Migration } from "@/lib/db/migrations/runner";

/**
 * Migrations after the baseline, in order. Add new ones at the end with the next id; never edit or reorder one that has shipped.
 */
export const extensions: Migration[] = [identity, scheduling, tasksNotifications];
