# Scheduled tasks

Look can run an agent prompt on a cron schedule without keeping the task workspace open. Scheduling lives in the Electron main process and is restored when Look starts.

## Architecture and storage

- Scheduler: recurring plans are compiled internally to [`node-cron`](https://nodecron.com/) 4.x expressions. One-time plans use a durable target timestamp and an unreferenced main-process timer.
- Execution: every run creates an independent background pi session in the selected project. It does not replace the session currently shown in the renderer.
- Definitions and logs: `~/.look/scheduled-tasks.json` (or `$LOOK_HOME/scheduled-tasks.json`). Writes use temp-file plus atomic rename.
- Coordination locks: `~/.look/scheduled-task-locks/<task-id>/`. Atomic directory creation ensures that only one Look process using the same `LOOK_HOME` runs a task at a time. The lock is heartbeated and abandoned same-host process locks are reclaimed.
- Alerts: after the final failed attempt, Look emits an in-app error event and an operating-system notification.

The scheduler callback and agent execution are promise-based. Network/model work is asynchronous and does not block the renderer or the main-process event loop.

## Create and manage a task

Select **Scheduled Tasks** near the bottom of the left sidebar, directly above **Agent marketplace**. The task workspace opens in the central message area.

1. Select **New task**.
2. Choose **Run once**, **Every day**, **Every week**, or **Every month**, then select the date/day and time shown for that frequency.
3. Choose one of the models currently connected in Look.
4. Optionally enable **IM notification** and select a bot channel. The result is pushed through that bot's private (p2p) conversation with you, so message the bot privately once in Feishu/Lark first.
5. Enter the agent prompt. Use `{{name}}` placeholders for values in the Parameters JSON object.
6. Set retry attempts and initial retry delay.
7. Select **Test task** to execute the current draft immediately without saving or enabling its schedule. The result appears in the editor and is also retained in the execution log — when testing from an existing task's editor, the log is filed under that task's history. A test performs one attempt; it does not consume the configured retry budget or trigger the final-failure system alert. If IM notification is enabled, the test also verifies delivery.
8. Save. New tasks are deliberately created in `paused` state so they can be reviewed.
9. Select **Start** to enable the plan. **Run now** executes an already saved task immediately with its normal retry policy; for a one-time plan this consumes the plan, so its scheduled time will not fire again.

Editing an active task replaces its cron schedule immediately; Look does not need to restart. Pausing prevents future cron triggers but lets an already running attempt finish. Deleting a task cancels an active run and removes the definition. Historical logs remain until they age out of the retained log window.

## Configuration reference

| Field | Required | Description |
| --- | --- | --- |
| `name` | yes | Display name and background session prefix. |
| `projectId` | yes | Project whose cwd, resources, and model configuration the agent uses. |
| `schedule` | yes for new clients | `once`, `daily`, `weekly`, or `monthly` structured plan. |
| `cron` | legacy/API only | Raw cron remains supported for compatibility but is not exposed in the UI. |
| `timezone` | no | IANA timezone; the UI uses the desktop's local timezone. |
| `prompt` | yes | Agent instruction. `{{key}}` is replaced from `parameters`. |
| `parameters` | no | String-to-string JSON object. Unknown placeholders are left unchanged. |
| `model` | yes in the UI | Connected model key in `provider/model-id` form. |
| `notification` | no | Feishu/Lark notification config. `channelAppId` selects the bot channel; the result is delivered through that bot's private conversation with the user, resolved from the IM bindings at validation and send time. `targetChatId` is the legacy raw-chat target kept for tasks saved before the channel model. Saving is rejected when the selected bot has no private conversation with the user (skipped while IM is unavailable). |
| `retry.maxAttempts` | no | Total attempts including the first, 1–20; default `3`. |
| `retry.initialDelayMs` | no | Delay before the first retry; default `5000`. |
| `retry.backoffMultiplier` | no | Exponential backoff multiplier; default `2`. |
| `retry.maxDelayMs` | no | Per-retry delay ceiling; default `60000`. |
| `executionTimeoutMs` | no | Timeout for each attempt; default 30 minutes. |

Structured plan examples:

```ts
{ kind: "once", runAt: "2026-07-15T01:00:00.000Z" }
{ kind: "daily", time: "09:00" }
{ kind: "weekly", weekday: 1, time: "09:00" } // Monday
{ kind: "monthly", day: 15, time: "09:00" }
```

## Renderer API

The sandboxed renderer uses the typed `window.look` preload API. All results use `{ success: true, ... }` or `{ success: false, error }`.

```ts
const created = await window.look.createScheduledTask({
  name: "Morning repository summary",
  projectId: "project-id",
  schedule: { kind: "weekly", weekday: 1, time: "09:00" },
  timezone: "Asia/Shanghai",
  model: "openai/gpt-5",
  prompt: "Summarize {{scope}} changes and flag failing tests.",
  parameters: { scope: "the last 24 hours" },
  notification: {
    enabled: true,
    provider: "feishu",
    channelAppId: "cli_example",
  },
  retry: { maxAttempts: 3, initialDelayMs: 5000 },
});

if (created.success) {
  await window.look.startScheduledTask(created.task.id);
}
```

Available methods:

```ts
listScheduledTasks()
createScheduledTask(input)
updateScheduledTask(taskId, patch)
startScheduledTask(taskId)
pauseScheduledTask(taskId)
resumeScheduledTask(taskId)
deleteScheduledTask(taskId)
runScheduledTaskNow(taskId)
testScheduledTask(input, taskId?)
listScheduledTaskLogs(taskId?, limit?)
validateCron(expression, timezone?)
```

Equivalent IPC route names are `scheduled-task:list`, `:create`, `:update`, `:start`, `:pause`, `:resume`, `:delete`, `:run-now`, `:test`, `:logs`, and `:validate-cron`.

## Execution logs

Select a task in the central workspace to filter its **Execution trail**, or query it programmatically:

```ts
const result = await window.look.listScheduledTaskLogs(taskId, 100);
```

Each run records:

- scheduled, start, and finish timestamps;
- `running`, `retrying`, `success`, `failed`, `skipped`, or `interrupted` status;
- current attempt and maximum attempts;
- final agent output and generated session ID;
- error message and stack trace;
- IM notification delivery status and delivery error, when enabled;
- lock owner ID for coordination diagnosis.

The newest 2,000 logs are retained, and an individual query is capped at 1,000 rows. To keep the local database bounded, a single output is capped at 100,000 characters and an exception stack at 30,000 characters; truncated values end with an explicit marker.

## Restart and scale behavior

- On startup, saved `scheduled` tasks are reinstalled automatically.
- A run left as `running` or `retrying` is checked against its coordination lock. If the lock still has a live owner, Look leaves it alone. If the owner is gone, the run becomes `interrupted` and resumes at the next remaining attempt; when several interrupted runs exist for one task, only the newest resumes so attempts are not consumed twice. Runs whose task no longer exists (deleted tasks, unsaved test drafts) are marked `interrupted` so they do not stay listed as running. Recurring schedules are reinstalled before that recovery starts, so future triggers continue. If no retry remains, Look alerts immediately; a consumed one-time plan is paused instead of remaining stuck as active.
- Two Look processes using the same `LOOK_HOME` cannot execute the same task concurrently. Task/log writes use a separate cross-process storage lock so the losing `skipped` record cannot overwrite the winner's result.
- For multiple machines, point every process at storage on a filesystem that provides atomic directory creation and atomic same-filesystem rename. If machines do not share `LOOK_HOME`, use a network/distributed lock and shared database implementation before treating the scheduler as a multi-host deployment.

## Troubleshooting

**The task never fires**

Confirm that its status is Active, review its displayed next-run time, and check that the operating system has not suspended or terminated Look. Desktop scheduling only runs while the Look main process is alive.

**IM notification cannot be enabled**

Add the bot under Settings → IM Channels, then send it a private message once in Feishu/Lark. The private conversation created that way is what the scheduler pushes results to; saving a task is rejected until the bot has one.

**The run is `skipped`**

Another process owns the task lock or the previous run is still active. Inspect `ownerId` in the log and the corresponding directory under `scheduled-task-locks`. Do not delete a lock for a known-live process.

**The task repeatedly times out**

Increase `executionTimeoutMs`, reduce the prompt scope, or verify model/network availability. A timeout aborts that attempt and follows the configured retry policy.

**A task fails before the agent starts**

Verify that the project still exists, has a configured model/API credential, and was trusted for project resources. The log stack contains the main-process failure reason.

**An unattended task waits for permission**

Scheduled sessions use Look's internal `always` permission mode without changing the user's global default. Project resource trust remains separately enforced; approve the project once in Look before relying on unattended project resources.
