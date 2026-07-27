"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { NativeDataProvider } = require("./data-provider.js");

test("forwards bounded cursor pages without accumulating state", async () => {
  const calls = [];
  const bridge = {
    request: async (method, params) => {
      calls.push({ method, params });
      return { items: [{ pk: 1 }], nextCursor: { timestamp: 10, pk: 1 } };
    }
  };
  const provider = new NativeDataProvider(bridge);
  const page = await provider.listMessages(7, {
    limit: 25,
    cursor: { timestamp: 5, pk: 2 }
  });
  assert.equal(page.items.length, 1);
  assert.deepEqual(calls, [{
    method: "listMessages",
    params: {
      chatPk: 7,
      source: "line",
      limit: 25,
      cursor: { timestamp: 5, pk: 2 },
      beforeCursor: null
    }
  }]);
  assert.equal(Object.hasOwn(provider, "messages"), false);
});

test("forwards previous-page cursors for chats and messages", async () => {
  const calls = [];
  const provider = new NativeDataProvider({
    request: async (method, params) => {
      calls.push({ method, params });
      return { items: [], nextCursor: null, hasPrevious: true };
    }
  });
  const beforeChat = { lastUpdated: 200, source: "line", pk: 7 };
  const beforeMessage = { timestamp: 100, pk: 2 };
  await provider.listChats({ beforeCursor: beforeChat });
  await provider.listMessages(7, { beforeCursor: beforeMessage });
  assert.deepEqual(calls, [
    {
      method: "listChats",
      params: { limit: 100, cursor: null, beforeCursor: beforeChat }
    },
    {
      method: "listMessages",
      params: {
        chatPk: 7,
        source: "line",
        limit: 180,
        cursor: null,
        beforeCursor: beforeMessage
      }
    }
  ]);
});

test("rejects renderer requests above the native page limit", async () => {
  const provider = new NativeDataProvider({ request: async () => ({ items: [] }) });
  await assert.rejects(() => provider.listChats({ limit: 1001 }), RangeError);
});

test("rejects an oversized response even if a bridge is compromised", async () => {
  const provider = new NativeDataProvider({
    request: async () => ({ items: new Array(1001), nextCursor: null })
  });
  await assert.rejects(() => provider.listAttachments(), RangeError);
});

test("normalizes duplicate digest requests", async () => {
  const calls = [];
  const provider = new NativeDataProvider({
    request: async (method, params) => {
      calls.push({ method, params });
      return { items: [], nextCursor: null };
    }
  });
  const digest = "AB".repeat(32);
  await provider.listDuplicateMembers(digest, { limit: 20 });
  assert.equal(calls[0].method, "listDuplicateMembers");
  assert.equal(calls[0].params.sha256, digest.toLowerCase());
  await assert.rejects(() => provider.listDuplicateMembers("bad"), TypeError);
});

test("forwards explicit duplicate-link candidate mode", async () => {
  const calls = [];
  const provider = new NativeDataProvider({
    request: async (method, params) => {
      calls.push({ method, params });
      return {};
    }
  });
  await provider.buildCandidate("output-token", {
    fullCrc: true,
    linkDuplicates: true
  });
  assert.deepEqual(calls[0], {
    method: "buildCandidate",
    params: {
      output: "output-token",
      fullCrc: true,
      linkDuplicates: true
    }
  });
});

test("validates and forwards bounded message searches", async () => {
  const calls = [];
  const provider = new NativeDataProvider({
    request: async (method, params) => {
      calls.push({ method, params });
      return { items: [], nextCursor: null };
    }
  });
  await provider.searchMessages(" photo ", { chatPk: 7, limit: 20 });
  assert.deepEqual(calls[0], {
    method: "searchMessages",
    params: {
      query: "photo",
      chatPk: 7,
      source: "line",
      limit: 20,
      cursor: null,
      beforeCursor: null
    }
  });
  await provider.searchMessages("photo", { chatPk: 8, source: "square", limit: 20 });
  assert.equal(calls[1].params.source, "square");
  await assert.rejects(
    () => provider.searchMessages("photo", { source: "archive" }),
    TypeError
  );
  await assert.rejects(() => provider.searchMessages("  "), TypeError);
  await assert.rejects(() => provider.searchMessages("x".repeat(1025)), RangeError);
});

test("normalizes web-compatible cleanup pages and filters", async () => {
  const calls = [];
  const provider = new NativeDataProvider({
    request: async (method, params) => {
      calls.push({ method, params });
      return {
        items: [],
        page: 2,
        pageSize: 24,
        totalItems: 0,
        totalPages: 1
      };
    }
  });
  await provider.listCleanupGroups({
    page: 2,
    search: " photo ",
    kind: "thumbnail",
    category: "group",
    sort: "size"
  });
  assert.deepEqual(calls[0], {
    method: "listCleanupGroups",
    params: {
      page: 2,
      pageSize: 24,
      search: "photo",
      kind: "thumbnail",
      category: "group",
      sort: "size"
    }
  });
  await provider.listCleanupGroups({ category: "no_attachments" });
  assert.equal(calls[1].params.category, "no_attachments");
  await assert.rejects(() => provider.listCleanupGroups({ page: 0 }), RangeError);
  await assert.rejects(() => provider.listCleanupGroups({ kind: "video" }), TypeError);
  await assert.rejects(() => provider.listCleanupGroups({ category: "other" }), TypeError);
});

test("forwards cleanup detail and group actions without exposing arbitrary methods", async () => {
  const calls = [];
  const provider = new NativeDataProvider({
    request: async (method, params) => {
      calls.push({ method, params });
      if (method === "listCleanupReviews") {
        return {
          items: [],
          page: 1,
          pageSize: 24,
          totalItems: 0,
          totalPages: 1
        };
      }
      return { markedCount: 1, markedBytes: 10 };
    }
  });
  await provider.listCleanupReviews("chat:u1");
  await provider.applyCleanupGroupAction("chat:u1", "keep_thumbnail");
  await provider.planSafeAttachmentCleanup();
  await provider.clearManualAttachmentPlan();
  await provider.clearAllRemovalPlans();
  await provider.setAllChatAttachmentsPlanned(true);
  assert.equal(calls[0].params.groupKey, "chat:u1");
  assert.deepEqual(calls[1], {
    method: "applyCleanupGroupAction",
    params: { groupKey: "chat:u1", action: "keep_thumbnail" }
  });
  assert.deepEqual(calls.slice(2), [
    { method: "planSafeAttachmentCleanup", params: {} },
    { method: "clearManualAttachmentPlan", params: {} },
    { method: "clearAllRemovalPlans", params: {} },
    {
      method: "setAllChatAttachmentsPlanned",
      params: { planned: true }
    }
  ]);
  assert.throws(
    () => provider.applyCleanupGroupAction("chat:u1", "delete_now"),
    TypeError
  );
});

test("forwards cleanup preflight and plan preview reports", async () => {
  const calls = [];
  const provider = new NativeDataProvider({
    request: async (method, params) => {
      calls.push({ method, params });
      return method === "cleanupPlanPreviews" ? [] : { blockerCount: 0 };
    }
  });
  await provider.cleanupPreflight();
  await provider.cleanupPlanPreviews();
  assert.deepEqual(calls, [
    { method: "cleanupPreflight", params: {} },
    { method: "cleanupPlanPreviews", params: {} }
  ]);
});

test("bounds cleanup audit history requests", async () => {
  const calls = [];
  const provider = new NativeDataProvider({
    request: async (method, params) => {
      calls.push({ method, params });
      return { plan: {}, events: [] };
    }
  });
  await provider.cleanupAudit(40);
  assert.deepEqual(calls[0], {
    method: "cleanupAudit",
    params: { limit: 40 }
  });
  assert.throws(() => provider.cleanupAudit(1001), RangeError);
});

test("validates and forwards advanced SQLite cleanup operations", async () => {
  const calls = [];
  const provider = new NativeDataProvider({
    request: async (method, params) => {
      calls.push({ method, params });
      return {
        lineEmptyChats: 0,
        lineSystemOnlyChats: 0,
        squareAvailable: true,
        communityChats: 1,
        communityMessages: 2,
        communityFiles: 3,
        communityBytes: 4,
        communityCleanupPlanned: false,
        squareEmptyChats: 0,
        squareSystemOnlyChats: 0,
        orphanCommunityMessages: 0,
        currentAccountDetected: true,
        accountFolders: 2,
        oldAccountFolders: 1,
        oldAccountFiles: 3,
        oldAccountBytes: 4,
        oldAccountCleanupPlanned: false,
        automaticCleanupPlanned: false,
        plannedChats: 0,
        plannedDatabaseMessages: 0,
        plannedFiles: 0,
        plannedBytes: 0
      };
    }
  });
  await provider.advancedCleanupReport();
  await provider.setChatRemovalPlanned("square", 8, true);
  await provider.planAutomaticCleanup();
  await provider.setCommunityCleanupPlanned(true);
  await provider.setOldAccountCleanupPlanned(true);
  await provider.clearAdvancedCleanupPlan();
  assert.deepEqual(calls, [
    { method: "advancedCleanupReport", params: {} },
    {
      method: "setChatRemovalPlanned",
      params: { source: "square", chatPk: 8, planned: true }
    },
    { method: "planAutomaticCleanup", params: {} },
    { method: "setCommunityCleanupPlanned", params: { planned: true } },
    { method: "setOldAccountCleanupPlanned", params: { planned: true } },
    { method: "clearAdvancedCleanupPlan", params: {} }
  ]);
  assert.throws(
    () => provider.setChatRemovalPlanned("archive", 8, true),
    TypeError
  );
  assert.throws(
    () => provider.setChatRemovalPlanned("line", "not-a-pk", true),
    TypeError
  );
});
