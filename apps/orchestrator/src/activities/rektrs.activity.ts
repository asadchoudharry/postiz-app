import { Injectable } from '@nestjs/common';
import { Activity, ActivityMethod } from 'nestjs-temporal-core';
import { RektrsAlertsService } from '@gitroom/nestjs-libraries/rektrs/rektrs.alerts.service';
import { RektrsLeadsService } from '@gitroom/nestjs-libraries/rektrs/rektrs.leads.service';
import { RektrsEvergreenService } from '@gitroom/nestjs-libraries/rektrs/rektrs.evergreen.service';

/**
 * REKTRS W2 — orchestrator face of the approval alert chain. The reminder /
 * escalation logic itself lives in the shared library (RektrsAlertsService)
 * so it is unit-tested with the rest of the REKTRS services; this activity
 * is the thin Temporal entry point the hourly reminders workflow calls.
 *
 * W1 joins the same activity: the comment poll sync + the CRM webhook
 * retry sweep (RektrsLeadsService), driven by rektrsLeadsWorkflow.
 *
 * W3 joins as well: the evergreen recycler's weekly sweep
 * (RektrsEvergreenService.scanAllEnabled), driven by
 * rektrsEvergreenWorkflow.
 */
@Injectable()
@Activity()
export class RektrsActivity {
  constructor(
    private _rektrsAlertsService: RektrsAlertsService,
    private _rektrsLeadsService: RektrsLeadsService,
    private _rektrsEvergreenService: RektrsEvergreenService
  ) {}

  @ActivityMethod()
  async sweepRektrsApprovalReminders(): Promise<{
    reminded: number;
    escalated: number;
  }> {
    return this._rektrsAlertsService.sweepApprovalReminders();
  }

  @ActivityMethod()
  async syncRektrsLeadComments() {
    return this._rektrsLeadsService.syncLeadComments();
  }

  @ActivityMethod()
  async sweepRektrsLeadWebhooks() {
    return this._rektrsLeadsService.sweepLeadWebhooks();
  }

  @ActivityMethod()
  async scanRektrsEvergreen() {
    return this._rektrsEvergreenService.scanAllEnabled();
  }
}
