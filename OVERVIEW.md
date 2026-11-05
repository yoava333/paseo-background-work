Shows the work a Claude agent left running after its turn ended: Monitor watches and Bash commands
started in the background. An idle agent that is still watching CI or running a long test suite
otherwise looks the same as one that is finished.

When an agent has background work, a pill appears above its composer, such as "1 monitor", "2
shells", or "3 running" for a mix. Press it to see each task's description, command, how long it has
been running, and when a Monitor expires. The pill disappears when the work ends.

## How it works

Paseo does not pass Claude's background task list to plugins, so the plugin reads the agent
timeline on the daemon. It recognizes Claude Code's result text for a started Monitor or background
command, and the completion notice Claude sends when the task ends. It clears an agent's tasks when
the Claude process exits, restarts, or the agent is closed or archived, and drops a Monitor when its
timeout passes. The app asks the daemon for the current list every 3 seconds.

## Setup

Requires Paseo 0.15.1 or later. Works with Claude Code agents on any operating system Paseo
supports. There are no settings.

## Data and limits

The plugin reads agent timelines on the daemon and sends nothing outside your Paseo host.

- Only Claude Code agents are covered.
- If Claude Code changes the wording of its background task results, tasks stop appearing until the
  plugin is updated.
- Live Monitor events are not shown, because Paseo does not receive them while the session runs.
- There is no Stop button. Plugins cannot stop a Claude background task.
- The pill can lag the real state by up to 3 seconds.
