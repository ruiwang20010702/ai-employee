import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  evaluatePlan,
  validateProjectManifest,
} from "../src/capability-policy.mjs";
import { loadProjectManifests } from "../src/project-manifests.mjs";

function manifest() {
  return {
    version: 1,
    projectId: "vocab_project",
    name: "单词项目",
    rootDirectory: "/workspace/vocab",
    requesters: ["authorized-user"],
    capabilities: {
      research: { mode: "automatic" },
      code_patch: { mode: "approval_required" },
      local_test: {
        mode: "automatic",
        commands: { 检查: { executable: "/usr/bin/true", args: [] } },
      },
      production_deploy: {
        mode: "automatic",
        commands: {
          发布: { executable: "/usr/bin/true", args: [] },
          验收: { executable: "/usr/bin/true", args: [] },
          回滚: { executable: "/usr/bin/true", args: [] },
        },
      },
    },
  };
}

test("未登记能力、越界目录和未授权请求人默认拒绝", () => {
  assert.equal(
    evaluatePlan({
      manifest: manifest(),
      requesterId: "other-user",
      steps: [{ capability: "research" }],
    }).decision,
    "DENY",
  );
  assert.equal(
    evaluatePlan({
      manifest: manifest(),
      requesterId: "authorized-user",
      steps: [{ capability: "unknown_tool" }],
    }).decision,
    "DENY",
  );
  assert.equal(
    evaluatePlan({
      manifest: manifest(),
      requesterId: "authorized-user",
      steps: [{ capability: "code_patch", workingDirectory: "/workspace/other" }],
    }).decision,
    "DENY",
  );
});

test("完整计划按最高风险与最严格审批合并判断", () => {
  const decision = evaluatePlan({
    manifest: manifest(),
    requesterId: "authorized-user",
    steps: [
      { capability: "research" },
      { capability: "code_patch", workingDirectory: "/workspace/vocab/app" },
      {
        capability: "production_deploy",
        workingDirectory: "/workspace/vocab",
        inputs: {
          commandId: "发布",
          verificationCommandId: "验收",
          rollbackCommandId: "回滚",
        },
      },
    ],
  });
  assert.equal(decision.decision, "REQUIRE_APPROVAL");
  assert.equal(decision.maxLevel, "L4");
});

test("禁止区不能通过项目清单获得授权", () => {
  const value = manifest();
  value.capabilities.payment = { mode: "automatic" };
  assert.throws(() => validateProjectManifest(value), /Unknown capability/u);
  delete value.capabilities.payment;
  assert.equal(
    evaluatePlan({
      manifest: value,
      requesterId: "authorized-user",
      steps: [{ capability: "payment" }],
    }).decision,
    "DENY",
  );
});

test("完整计划不能超过能力授权次数", () => {
  const value = manifest();
  value.capabilities.research.maxRuns = 1;
  const result = evaluatePlan({
    manifest: value,
    requesterId: "authorized-user",
    steps: [{ capability: "research" }, { capability: "research" }],
  });
  assert.equal(result.decision, "DENY");
  assert.match(result.reason, /次数/u);
});

test("L3 推送即使标记自动也必须单次审批并绑定远端", () => {
  const value = manifest();
  value.capabilities.git_push = {
    mode: "automatic",
    remote: "origin",
    expectedRemoteUrl: "https://github.com/example/project.git",
    branchPrefix: "ai-employee/",
  };
  const result = evaluatePlan({
    manifest: value,
    requesterId: "authorized-user",
    steps: [{
      capability: "git_push",
      workingDirectory: "/workspace/vocab",
    }],
  });
  assert.equal(result.decision, "REQUIRE_APPROVAL");
  value.capabilities.git_push.expectedRemoteUrl =
    "https://user:secret@github.com/example/project.git";
  assert.throws(() => validateProjectManifest(value), /must not contain credentials/u);
});

test("共享文档写入必须固定唯一目标且强制审批", () => {
  const value = manifest();
  value.capabilities.shared_document_write = {
    mode: "automatic",
    folderNodeId: "folder-1",
    maxContentBytes: 100_000,
  };
  const result = evaluatePlan({
    manifest: value,
    requesterId: "authorized-user",
    steps: [{ capability: "shared_document_write" }],
  });
  assert.equal(result.decision, "REQUIRE_APPROVAL");
  value.capabilities.shared_document_write.workspaceId = "workspace-1";
  assert.throws(
    () => validateProjectManifest(value),
    /exactly one folderNodeId or workspaceId/u,
  );
});

test("高风险能力禁用时不要求预填外部目标", () => {
  const value = manifest();
  value.capabilities.shared_document_write = { mode: "disabled" };
  value.capabilities.git_push = { mode: "disabled" };
  assert.doesNotThrow(() => validateProjectManifest(value));
});

test("待办创建必须固定执行人和优先级且强制审批", () => {
  const value = manifest();
  value.capabilities.dingtalk_todo_create = {
    mode: "automatic",
    allowedExecutorUserIds: ["user-1"],
    allowedPriorities: ["20", "30"],
    maxTitleChars: 80,
  };
  const allowed = evaluatePlan({
    manifest: value,
    requesterId: "authorized-user",
    steps: [{
      capability: "dingtalk_todo_create",
      inputs: {
        title: "完成方案评审",
        executorUserIds: ["user-1"],
        priority: "30",
        due: "2026-08-05T18:00:00+08:00",
      },
    }],
  });
  assert.equal(allowed.decision, "REQUIRE_APPROVAL");
  const denied = evaluatePlan({
    manifest: value,
    requesterId: "authorized-user",
    steps: [{
      capability: "dingtalk_todo_create",
      inputs: { title: "越权", executorUserIds: ["other-user"] },
    }],
  });
  assert.equal(denied.decision, "DENY");
  assert.match(denied.reason, /执行人/u);
});

test("日程创建限制参与人、时长并拒绝未支持的会议室参数", () => {
  const value = manifest();
  value.capabilities.dingtalk_calendar_create = {
    mode: "approval_required",
    allowedAttendeeUserIds: ["user-1"],
    maxDurationMinutes: 60,
  };
  const allowed = evaluatePlan({
    manifest: value,
    requesterId: "authorized-user",
    steps: [{
      capability: "dingtalk_calendar_create",
      inputs: {
        title: "项目评审",
        start: "2026-08-05T10:00:00+08:00",
        end: "2026-08-05T11:00:00+08:00",
        attendeeUserIds: ["user-1"],
      },
    }],
  });
  assert.equal(allowed.decision, "REQUIRE_APPROVAL");
  const denied = evaluatePlan({
    manifest: value,
    requesterId: "authorized-user",
    steps: [{
      capability: "dingtalk_calendar_create",
      inputs: {
        title: "项目评审",
        start: "2026-08-05T10:00:00+08:00",
        end: "2026-08-05T11:00:00+08:00",
        rooms: ["invented-room"],
      },
    }],
  });
  assert.equal(denied.decision, "DENY");
});

test("会议室按名称白名单授权且循环日程必须限制次数", () => {
  const value = manifest();
  value.capabilities.dingtalk_calendar_create = {
    mode: "approval_required",
    allowedAttendeeUserIds: [],
    allowedRoomNames: ["永澄亭"],
    allowRecurrence: true,
    allowedRecurrenceTypes: ["daily", "weekly"],
    maxRecurrenceCount: 10,
  };
  const base = {
    title: "项目评审",
    start: "2026-08-05T10:00:00+08:00",
    end: "2026-08-05T11:00:00+08:00",
  };
  assert.equal(evaluatePlan({
    manifest: value,
    requesterId: "authorized-user",
    steps: [{
      capability: "dingtalk_calendar_create",
      inputs: { ...base, roomName: "永澄亭" },
    }],
  }).decision, "REQUIRE_APPROVAL");
  assert.equal(evaluatePlan({
    manifest: value,
    requesterId: "authorized-user",
    steps: [{
      capability: "dingtalk_calendar_create",
      inputs: {
        ...base,
        recurrence: {
          type: "weekly",
          interval: 1,
          count: 8,
          daysOfWeek: ["tuesday"],
        },
      },
    }],
  }).decision, "REQUIRE_APPROVAL");
  const unlimited = evaluatePlan({
    manifest: value,
    requesterId: "authorized-user",
    steps: [{
      capability: "dingtalk_calendar_create",
      inputs: { ...base, recurrence: { type: "daily", interval: 1, count: 99 } },
    }],
  });
  assert.equal(unlimited.decision, "DENY");
  assert.match(unlimited.reason, /循环/u);
  const combined = evaluatePlan({
    manifest: value,
    requesterId: "authorized-user",
    steps: [{
      capability: "dingtalk_calendar_create",
      inputs: {
        ...base,
        roomName: "永澄亭",
        recurrence: { type: "daily", interval: 1, count: 5 },
      },
    }],
  });
  assert.equal(combined.decision, "DENY");
  assert.match(combined.reason, /不能与/u);
});

test("审批决策明确属于禁止自动化边界", () => {
  assert.equal(
    evaluatePlan({
      manifest: manifest(),
      requesterId: "authorized-user",
      steps: [{ capability: "dingtalk_approval_decision" }],
    }).decision,
    "DENY",
  );
});

test("日志提交绑定模板编号、模板名和完整字段结构", () => {
  const value = manifest();
  value.capabilities.dingtalk_report_submit = {
    mode: "approval_required",
    templateId: "template-1",
    templateName: "项目日报",
    fields: [
      { name: "今日完成", sort: "0", type: "1" },
      { name: "明日计划", sort: "1", type: "1" },
    ],
    maxContentBytes: 10_000,
  };
  const allowed = evaluatePlan({
    manifest: value,
    requesterId: "authorized-user",
    steps: [{
      capability: "dingtalk_report_submit",
      inputs: {
        fieldValues: { 今日完成: "完成方案", 明日计划: "推进评审" },
      },
    }],
  });
  assert.equal(allowed.decision, "REQUIRE_APPROVAL");
  const denied = evaluatePlan({
    manifest: value,
    requesterId: "authorized-user",
    steps: [{
      capability: "dingtalk_report_submit",
      inputs: { fieldValues: { 今日完成: "完成方案", 自定义字段: "越权" } },
    }],
  });
  assert.equal(denied.decision, "DENY");
  assert.match(denied.reason, /固定模板/u);
});

test("日志能力拒绝重复字段和未支持的模板字段类型", () => {
  const value = manifest();
  value.capabilities.dingtalk_report_submit = {
    mode: "approval_required",
    templateId: "template-1",
    templateName: "项目日报",
    fields: [
      { name: "今日完成", sort: "0", type: "1" },
      { name: "今日完成", sort: "1", type: "9" },
    ],
  };
  assert.throws(
    () => validateProjectManifest(value),
    /unique|unsupported/u,
  );
});

test("项目清单目录拒绝重复项目编号", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ai-projects-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await Promise.all([
    writeFile(join(directory, "一.json"), JSON.stringify(manifest())),
    writeFile(join(directory, "二.json"), JSON.stringify(manifest())),
  ]);
  await assert.rejects(loadProjectManifests(directory), /Duplicate projectId/u);
});
