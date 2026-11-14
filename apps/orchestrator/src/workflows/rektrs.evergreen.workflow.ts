import {
  continueAsNew,
  patched,
  proxyActivities,
  sleep,
  workflowInfo,
} from '@temporalio/workflow';
import { RektrsActivity } from '@gitroom/orchestrator/activities/rektrs.activity';

const { scanRektrsEvergreen } = proxyActivities<RektrsActivity>({
  startToCloseTimeout: '10 minute',
  retry: {
    maximumAttempts: 3,
    backoffCoefficient: 1,
    initialInterval: '2 minutes',
  },
});

/**
 * REKTRS W3 — evergreen recycler driver. Mirrors the W1/W2 drivers: one
 * infinite execution (started once by InfiniteWorkflowRegister under
 * RUN_CRON) that sweeps immediately, then hourly. The WEEKLY cadence is
 * decided inside the sweep (RektrsEvergreenService.scanAllEnabled): a
 * brand runs only inside its org's configured UTC weekday/hour window
 * and only when it has no run in the last 6 days, so the hourly tick —
 * and any duplicate start after a deploy — can never double-fire a
 * brand's weekly scan.
 */
export async function rektrsEvergreenWorkflow() {
  let loops = 0;
  await scanRektrsEvergreen();
  while (true) {
    await sleep('1 hour');

    // Keep the history small, the new run sweeps immediately so the hourly cadence is kept
    if (
      patched('rektrs-evergreen-continue-as-new') &&
      (++loops >= 24 || workflowInfo().historyLength > 1000)
    ) {
      return await continueAsNew<typeof rektrsEvergreenWorkflow>();
    }

    await scanRektrsEvergreen();
  }
}
