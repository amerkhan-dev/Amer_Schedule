/* Planning one week from what's in the database. Used by the API and the nightly job. */
import { planWeek, dkey } from "../app/engine.mjs";

export async function replan(db, weekStart, by = "planner") {
  const state = await db.state();
  const key = dkey(weekStart);
  const plan = planWeek({ state, weekStart, existing: state.plans[key] || null, now: new Date(), by });
  await db.put("plans", key, plan);
  return plan;
}
