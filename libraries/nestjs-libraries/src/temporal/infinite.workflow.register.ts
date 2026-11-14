import { Global, Injectable, Module, OnModuleInit } from '@nestjs/common';
import { TemporalService } from 'nestjs-temporal-core';

@Injectable()
export class InfiniteWorkflowRegister implements OnModuleInit {
  constructor(private _temporalService: TemporalService) {}

  async onModuleInit(): Promise<void> {
    if (!!process.env.RUN_CRON) {
      try {
        await this._temporalService.client
          ?.getRawClient()
          ?.workflow?.start('missingPostWorkflow', {
            workflowId: 'missing-post-workflow',
            taskQueue: 'main',
          });
      } catch (err) {}
      try {
        // REKTRS W2: the approval reminder/escalation sweep (hourly loop,
        // idempotent claims — a duplicate start attempt is expected and
        // swallowed, exactly like missingPostWorkflow above).
        await this._temporalService.client
          ?.getRawClient()
          ?.workflow?.start('rektrsApprovalRemindersWorkflow', {
            workflowId: 'rektrs-approval-reminders-workflow',
            taskQueue: 'main',
          });
      } catch (err) {}
      try {
        // REKTRS W1: the lead-machine driver (hourly comment poll sync +
        // CRM webhook retry sweep — same duplicate-start contract).
        await this._temporalService.client
          ?.getRawClient()
          ?.workflow?.start('rektrsLeadsWorkflow', {
            workflowId: 'rektrs-leads-workflow',
            taskQueue: 'main',
          });
      } catch (err) {}
      try {
        // REKTRS W3: the evergreen recycler driver (hourly tick; the
        // weekly per-org window + 6-day guard live in the sweep — same
        // duplicate-start contract).
        await this._temporalService.client
          ?.getRawClient()
          ?.workflow?.start('rektrsEvergreenWorkflow', {
            workflowId: 'rektrs-evergreen-workflow',
            taskQueue: 'main',
          });
      } catch (err) {}
    }
  }
}

@Global()
@Module({
  imports: [],
  controllers: [],
  providers: [InfiniteWorkflowRegister],
  get exports() {
    return this.providers;
  },
})
export class InfiniteWorkflowRegisterModule {}
