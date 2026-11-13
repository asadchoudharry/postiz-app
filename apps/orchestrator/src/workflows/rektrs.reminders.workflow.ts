import {
  continueAsNew,
  patched,
  proxyActivities,
  sleep,
  workflowInfo,
} from '@temporalio/workflow';
import { RektrsActivity } from '@gitroom/orchestrator/activities/rektrs.activity';

const { sweepRektrsApprovalReminders } = proxyActivities<RektrsActivity>({
  startToCloseTimeout: '10 minute',
  retry: {
    maximumAttempts: 3,
    backoffCoefficient: 1,
    initialInterval: '2 minutes',
  },
});

/**
 * REKTRS W2 — approval reminder sweep driver. Mirrors missingPostWorkflow:
 * one infinite execution (started once by InfiniteWorkflowRegister under
 * RUN_CRON) that sweeps immediately, then hourly. The sweep itself is
 * idempotent (per-round claim markers in RektrsAlertsService), so the
 * cadence only bounds alert latency: a submission crossing its org's
 * reminder/escalation threshold is picked up within the hour.
 */
export async function rektrsApprovalRemindersWorkflow() {
  let loops = 0;
  await sweepRektrsApprovalReminders();
  while (true) {
    await sleep('1 hour');

    // Keep the history small, the new run sweeps immediately so the hourly cadence is kept
    if (
      patched('rektrs-reminders-continue-as-new') &&
      (++loops >= 24 || workflowInfo().historyLength > 1000)
    ) {
      return await continueAsNew<typeof rektrsApprovalRemindersWorkflow>();
    }

    await sweepRektrsApprovalReminders();
  }
}
