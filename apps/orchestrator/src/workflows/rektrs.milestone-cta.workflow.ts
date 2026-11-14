import {
  continueAsNew,
  patched,
  proxyActivities,
  sleep,
  workflowInfo,
} from '@temporalio/workflow';
import { RektrsActivity } from '@gitroom/orchestrator/activities/rektrs.activity';

const { scanRektrsMilestoneCta } = proxyActivities<RektrsActivity>({
  startToCloseTimeout: '10 minute',
  retry: {
    maximumAttempts: 3,
    backoffCoefficient: 1,
    initialInterval: '2 minutes',
  },
});

/**
 * REKTRS W4 — milestone auto-CTA driver. Mirrors the W1/W3 drivers: one
 * infinite execution (started once by InfiniteWorkflowRegister under
 * RUN_CRON) that sweeps immediately, then hourly. Unlike W3 there is no
 * weekly window inside the sweep — the milestone cadence IS hourly, so a
 * post receives its CTA soon after it crosses the brand's like
 * threshold. Idempotency lives in the sweep itself (one dedupe row per
 * post, attempt cap 3), so the hourly tick — and any duplicate start
 * after a deploy — can never post a second CTA on a post.
 */
export async function rektrsMilestoneCtaWorkflow() {
  let loops = 0;
  await scanRektrsMilestoneCta();
  while (true) {
    await sleep('1 hour');

    // Keep the history small, the new run sweeps immediately so the hourly cadence is kept
    if (
      patched('rektrs-milestone-cta-continue-as-new') &&
      (++loops >= 24 || workflowInfo().historyLength > 1000)
    ) {
      return await continueAsNew<typeof rektrsMilestoneCtaWorkflow>();
    }

    await scanRektrsMilestoneCta();
  }
}
