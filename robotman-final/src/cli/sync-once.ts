/** One-shot sync: `npm run sync`. Useful for external cron or debugging. */
import { syncAll } from "../sync.js";
import { closeStore } from "../store/repository.js";

const results = await syncAll();
if (results.length === 0) {
  console.log("No configured connectors. Set ASHBY_API_KEY and/or GEM_API_KEY.");
} else {
  for (const r of results) {
    console.log(`${r.source}: ${r.ok ? `${r.upserted} upserted` : `ERROR ${r.error}`}`);
  }
}
await closeStore();
