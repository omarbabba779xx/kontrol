/** Starts the in-process scheduler when KONTROL_SCHEDULER=true. Otherwise run schedules from cron against /api/jobs/run. */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.KONTROL_SCHEDULER === "true") {
    const { startSchedulerLoop } = await import("@/lib/core/scheduler");
    startSchedulerLoop();
  }
}
