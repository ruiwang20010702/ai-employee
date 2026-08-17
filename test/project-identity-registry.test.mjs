import assert from "node:assert/strict";
import test from "node:test";
import { applyProjectIdentityRegistry } from "../src/project-identity-registry.mjs";

function registry() {
  return {
    schema: "foursday-project-identities/v1",
    projects: [{
      subject: "foursday",
      canonicalName: "Foursday",
      aliases: ["Foursday", "ai员工"],
    }],
  };
}

test("项目身份导入默认零写，精确确认后只新增并确认身份记忆", async () => {
  const items = [];
  const store = {
    async listMemories() { return items; },
    async proposeMemory(memory) {
      items.push({ id: "memory-1", status: "proposed", ...memory });
      return "memory-1";
    },
    async confirmMemory(id) {
      items.find((item) => item.id === id).status = "confirmed";
      return "confirmed";
    },
  };
  const preview = await applyProjectIdentityRegistry({
    store,
    registry: registry(),
    actor: "owner",
  });
  assert.equal(preview.applied, false);
  assert.equal(items.length, 0);
  const applied = await applyProjectIdentityRegistry({
    store,
    registry: registry(),
    actor: "owner",
    confirmation: preview.confirmation,
    apply: true,
  });
  assert.equal(applied.created, 1);
  assert.equal(items[0].status, "confirmed");
  assert.deepEqual(items[0].scope.aliases, ["Foursday", "ai员工"]);
  const repeated = await applyProjectIdentityRegistry({
    store,
    registry: registry(),
    actor: "owner",
    confirmation: preview.confirmation,
    apply: true,
  });
  assert.equal(repeated.created, 0);
  assert.equal(repeated.unchanged, 1);
});

test("项目身份导入拒绝错误确认和歧义别名", async () => {
  const store = { async listMemories() { return []; } };
  await assert.rejects(
    applyProjectIdentityRegistry({
      store,
      registry: registry(),
      actor: "owner",
      confirmation: "PROJECTS-WRONG",
      apply: true,
    }),
    /does not match/u,
  );
  await assert.rejects(
    applyProjectIdentityRegistry({
      store,
      registry: {
        schema: "foursday-project-identities/v1",
        projects: [
          { subject: "one", canonicalName: "同名", aliases: ["同名"] },
          { subject: "two", canonicalName: "同名", aliases: ["同名"] },
        ],
      },
    }),
    /ambiguous/u,
  );
});
