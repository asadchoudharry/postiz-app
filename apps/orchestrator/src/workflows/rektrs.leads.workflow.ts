import {
  continueAsNew,
  patched,
  proxyActivities,
  sleep,
  workflowInfo,
} from '@temporalio/workflow';
import { RektrsActivity } from '@gitroom/orchestrator/activities/rektrs.activity';

const { syncRektrsLeadComments, sweepRektrsLeadWebhooks } =
  proxyActivities<RektrsActivity>({
    startToCloseTimeout: '10 minute',
    retry: {
      maximumAttempts: 3,
      backoffCoefficient: 1,
      initialInterval: '2 minutes',
    },
  });

/**
 * REKTRS W1 — lead machine driver. Mirrors rektrsApprovalRemindersWorkflow:
 * one infinite execution (started once by InfiniteWorkflowRegister under
 * RUN_CRON) that sweeps immediately, then hourly. Each tick (1) polls
 * provider comments on W1-enabled brand channels' recent posts — the
 * ingestion path that exists independently of Meta webhook subscriptions —
 * and (2) retries outstanding CRM webhook deliveries (bounded per lead).
 * Both sweeps are idempotent (seen-claims + attempt counters), so the
 * cadence only bounds latency.
 */
export async function rektrsLeadsWorkflow() {
  let loops = 0;
  await syncRektrsLeadComments();
  await sweepRektrsLeadWebhooks();
  while (true) {
    await sleep('1 hour');

    // Keep the history small, the new run sweeps immediately so the hourly cadence is kept
    if (
      patched('rektrs-leads-continue-as-new') &&
      (++loops >= 24 || workflowInfo().historyLength > 1000)
    ) {
      return await continueAsNew<typeof rektrsLeadsWorkflow>();
    }

    await syncRektrsLeadComments();
    await sweepRektrsLeadWebhooks();
  }
}
