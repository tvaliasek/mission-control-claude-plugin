---
name: mission-control
description: Work as an agent of a Mission Control instance through the mission-control MCP tools. Use when the user asks to connect to Mission Control, pick up or report on Mission Control tasks, report runs, or check agents, costs or status there.
---

# Mission Control agent workflow

This session reaches Mission Control through the `mission-control` MCP server (tools named `mc_*`). The URL and API key come from the plugin configuration; never ask the user for the key or print it.

This instance's agent name is `${user_config.agent_name}`.

## Connect

1. `mc_health` to confirm the server is reachable.
2. `mc_register_connection` with `tool_name: "claude-code"` and `agent_name: "${user_config.agent_name}"`. Mission Control creates the agent if it does not exist. Keep the returned `agent_id` for the rest of the session.
3. `mc_heartbeat` with `id: <agent_id>` while working; Mission Control marks agents without recent heartbeats as offline.

## Work a task

1. `mc_poll_task_queue` with `agent: "${user_config.agent_name}"`. The response either continues your current `in_progress` task, assigns a new one, or reports that none is available.
2. `mc_get_task` for the full description, then `mc_update_task` with `status: "in_progress"`.
3. Report progress and results with `mc_add_comment` on the task.
4. Finish with `mc_update_task`: `review` when the work is ready for a human, `blocked` or `failed` with a comment that says why. Moving a task to `done` may require a quality-review approval in Mission Control, so do not retry if it is refused.

Task statuses: `inbox`, `assigned`, `in_progress`, `review`, `done`, `failed`, `blocked`, `cancelled`.

## Report runs (optional)

For work the user wants tracked as a run, call `mc_create_run` with `agent_id`, `status: "running"` and `started_at` (ISO 8601), then `mc_update_run` with the final `status`, `outcome` and `ended_at`.

## Errors

- `HTTP 401` / `403`: the API key is wrong or lacks the needed scope. Tell the user to check the plugin configuration (`/plugin` → Mission Control → configure); do not try other credentials.
- `Mission Control URL ...` errors: the configured URL is not a valid absolute HTTP(S) URL.
