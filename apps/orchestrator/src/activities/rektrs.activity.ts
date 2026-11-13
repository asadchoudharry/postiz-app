import { Injectable } from '@nestjs/common';
import { Activity, ActivityMethod } from 'nestjs-temporal-core';
import { RektrsAlertsService } from '@gitroom/nestjs-libraries/rektrs/rektrs.alerts.service';

/**
 * REKTRS W2 — orchestrator face of the approval alert chain. The reminder /
 * escalation logic itself lives in the shared library (RektrsAlertsService)
 * so it is unit-tested with the rest of the REKTRS services; this activity
 * is the thin Temporal entry point the hourly reminders workflow calls.
 */
@Injectable()
@Activity()
export class RektrsActivity {
  constructor(private _rektrsAlertsService: RektrsAlertsService) {}

  @ActivityMethod()
  async sweepRektrsApprovalReminders(): Promise<{
    reminded: number;
    escalated: number;
  }> {
    return this._rektrsAlertsService.sweepApprovalReminders();
  }
}
