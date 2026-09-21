
/* Thin wrappers so the rest of the page can call the shared engine
 * (src/shared/engine.js) without passing state around by hand. */
function buildPlan(weekStart, existing) {
  return planWeek({ state: snapshot(), weekStart, existing, now: new Date() });
}
function statsFor(plan) {
  return weekStats(snapshot(), plan, S.week);
}
