# @tenonhq/dovetail-clickup

ClickUp API v2 client for Dovetail. Provides task management, workspace navigation, and formatting utilities used by CTO automation scripts and the `dove clickup` CLI subcommand.

## Install

```bash
npm i -D @tenonhq/dovetail-clickup
```

## Setup

Get a personal API token from ClickUp: **Settings > My Apps > API Token** (starts with `pk_`).

```bash
# .env
CLICKUP_API_TOKEN=pk_your_token_here
CLICKUP_TEAM_ID=your_team_id
```

## Usage

```typescript
import {
  createClickUpApi,
  getTask,
  createTask,
  updateTaskStatus,
  formatTeamSync,
} from "@tenonhq/dovetail-clickup";

var api = createClickUpApi({ token: process.env.CLICKUP_API_TOKEN });

var task = await getTask({ api: api, taskId: "abc123" });

var created = await createTask({
  api: api,
  listId: "789",
  name: "Fix the bug",
  description: "Details here",
});

await updateTaskStatus({ api: api, taskId: "abc123", status: "in progress" });

var digest = await formatTeamSync({
  api: api,
  teamId: process.env.CLICKUP_TEAM_ID,
});
```

## API Surface

- **Client:** `createClickUpApi`, `createClient`
- **Users/Teams:** `getAuthorizedUser`, `getTeams`
- **Tasks:** `getTask`, `listMyTasks`, `listTeamTasks`, `createTask`, `updateTask`, `updateTaskStatus`, `deleteTask`, `addComment`
- **Hierarchy:** `getSpaces`, `getFolders`, `getLists`, `getSpaceLists`, `getListTasks`, `findListByName`
- **Formatting:** `formatForClaude`, `formatTaskDetail`, `formatTaskSummary`, `formatTeamSync`
- **Parsing:** `parseClickUpIdentifier` — extracts task/list/space IDs from ClickUp URLs
- **Plugin:** `sincPlugin` — auto-discovered by `dovetail-core` for `dove clickup` subcommands

See `src/types.ts` for the full type surface.

## Related

- [`@tenonhq/dovetail-core`](../core) — CLI host that discovers this plugin
- [`@tenonhq/dovetail-gmail`](../gmail) / [`@tenonhq/dovetail-google-calendar`](../google-calendar) — sibling integration packages
