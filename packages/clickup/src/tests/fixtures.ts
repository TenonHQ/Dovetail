import {
  ClickUpTask,
  ClickUpUser,
  PipelineGroup,
  PipelineStage,
} from "../types";

var defaultCreator: ClickUpUser = {
  id: 1,
  username: "testuser",
  email: "test@test.com",
  color: "#000000",
  profilePicture: null,
  initials: "TU",
};

export function makeClickUpTask(overrides?: Partial<ClickUpTask>): ClickUpTask {
  var defaults: ClickUpTask = {
    id: "task1",
    custom_id: null,
    name: "Test Task",
    description: "",
    status: {
      status: "in progress",
      color: "#4194f6",
      type: "open",
      orderindex: 1,
    },
    assignees: [],
    priority: null,
    url: "https://app.clickup.com/t/task1",
    date_created: "1704067200000",
    date_updated: "1704153600000",
    date_closed: null,
    creator: defaultCreator,
    list: { id: "list1", name: "Sprint 1" },
    folder: { id: "folder1", name: "Development" },
    space: { id: "space1" },
    tags: [],
    custom_fields: [],
    due_date: null,
    start_date: null,
    time_estimate: null,
  };

  if (!overrides) {
    return defaults;
  }

  return Object.assign({}, defaults, overrides);
}

export function makeUser(overrides?: Partial<ClickUpUser>): ClickUpUser {
  var defaults: ClickUpUser = {
    id: 1,
    username: "testuser",
    email: "test@test.com",
    color: "#000000",
    profilePicture: null,
    initials: "TU",
  };

  if (!overrides) {
    return defaults;
  }

  return Object.assign({}, defaults, overrides);
}

export function makePipelineGroup(
  stage: PipelineStage,
  tasks: ClickUpTask[],
): PipelineGroup {
  return { stage: stage, tasks: tasks };
}
