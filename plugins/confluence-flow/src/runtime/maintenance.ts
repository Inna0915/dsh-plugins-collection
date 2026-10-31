import { mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { dataHome } from "./store.js";

const DAY = 24 * 60 * 60 * 1000;
// Read material is only reused within a session (5-minute cache, snapshot continuation, scan
// paging, preview drafts). Write receipts guard request IDs and operation-status for a month.
export const retentionDays: Record<string, number> = {
  snapshots: 7,
  scans: 7,
  "read-cache": 7,
  drafts: 7,
  operations: 30,
};
let checked = "";

function localDay(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
async function prune(
  directory: string,
  cutoff: number,
  keep = "",
): Promise<number> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(
    () => [],
  );
  const removed = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name !== keep)
      .map(async (entry) => {
        const file = path.join(directory, entry.name);
        try {
          if ((await stat(file)).mtimeMs >= cutoff) {
            return 0;
          }
          await unlink(file);
          return 1;
        } catch {
          return 0;
        }
      }),
  );
  return removed.reduce<number>((sum, value) => sum + value, 0);
}
// Runs before the first operation of each local day. Repeat calls in a process cost nothing; across
// processes an exclusive per-day marker lets exactly one caller prune. Failures never block the caller.
export async function dailyMaintenance(
  now = new Date(),
): Promise<{ ran: boolean; removed: number }> {
  const day = localDay(now);
  const home = dataHome();
  if (checked === `${home}|${day}`) {
    return { ran: false, removed: 0 };
  }
  checked = `${home}|${day}`;
  const markers = path.join(home, "maintenance");
  try {
    await mkdir(markers, { recursive: true });
    await writeFile(path.join(markers, day), "", { flag: "wx" });
  } catch {
    return { ran: false, removed: 0 };
  }
  try {
    const counts = await Promise.all([
      ...Object.entries(retentionDays).map(([folder, days]) =>
        prune(path.join(home, folder), now.getTime() - days * DAY),
      ),
      prune(markers, Number.POSITIVE_INFINITY, day),
    ]);
    return {
      ran: true,
      removed: counts.reduce((sum, value) => sum + value, 0),
    };
  } catch {
    return { ran: true, removed: 0 };
  }
}
