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

test("validates and forwards bounded attachment exports", async () => {
  const calls = [];
  const provider = new NativeDataProvider({
    request: async (method, params) => {
      calls.push({ method, params });
      return { outputName: "LINE-Cheater-Export", exportedFiles: 1 };
    }
  });
  await provider.exportAttachments({
    output: "export-token",
    paths: ["Container/Message Attachments/u1/123.jpg"],
    imagesOnly: true,
    includeThumbnails: false
  });
  assert.deepEqual(calls[0], {
    method: "exportAttachments",
    params: {
      output: "export-token",
      paths: ["Container/Message Attachments/u1/123.jpg"],
      source: null,
      chatPk: null,
      imagesOnly: true,
      includeThumbnails: false
    }
  });
  await provider.exportAttachments({
    output: "export-token",
    source: "square",
    chatPk: 8,
    includeThumbnails: true
  });
  assert.equal(calls[1].params.source, "square");
  assert.equal(calls[1].params.chatPk, 8);
  assert.throws(() => provider.exportAttachments({ output: "x" }), TypeError);
  assert.throws(() => provider.exportAttachments({
    output: "x",
    paths: new Array(1001).fill("attachment")
  }), RangeError);
  assert.throws(() => provider.exportAttachments({
    output: "x",
    paths: ["one"],
    source: "line",
    chatPk: 7
  }), TypeError);
});

test("validates and forwards complete conversation exports", async () => {
  const calls = [];
  const provider = new NativeDataProvider({
    request: async (method, params) => {
      calls.push({ method, params });
      return { outputName: "LINE-conversation.zip", messages: 4, attachments: 2 };
    }
  });
  await provider.exportConversation({
    output: "conversation-token",
    source: "square",
    chatPk: 8
  });
  assert.deepEqual(calls[0], {
    method: "exportConversation",
    params: {
      output: "conversation-token",
      source: "square",
      chatPk: 8
    }
  });
  assert.throws(() => provider.exportConversation({ source: "line", chatPk: 7 }), TypeError);
  assert.throws(() => provider.exportConversation({ output: "x", source: "bad", chatPk: 7 }), TypeError);
  assert.throws(() => provider.exportConversation({ output: "x", source: "line", chatPk: "no" }), TypeError);
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
      linkDuplicates: true,
      allowLineSquareRebuild: false
    }
  });
});

test("forwards explicit LineSquare rebuild authorization", async () => {
  const calls = [];
  const provider = new NativeDataProvider({
    request: async (method, params) => {
      calls.push({ method, params });
      return {};
    }
  });
  await provider.buildCandidate("output-token", {
    fullCrc: true,
    allowLineSquareRebuild: true
  });
  assert.equal(calls[0].params.allowLineSquareRebuild, true);
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
  await provider.cleanupCategoryActionState("community");
  await provider.applyCleanupCategoryAction("community", "keep_thumbnail");
  await provider.applyCleanupCategoryAction("community", "clear_keep_thumbnail");
  await provider.applyCleanupCategoryAction("unconfirmed", "delete_all");
  await provider.applyCleanupCategoryAction("unconfirmed", "clear_delete_all");
  await provider.planSafeAttachmentCleanup();
  await provider.clearManualAttachmentPlan();
  await provider.clearAllRemovalPlans();
  assert.equal(calls[0].params.groupKey, "chat:u1");
  assert.deepEqual(calls[1], {
    method: "applyCleanupGroupAction",
    params: { groupKey: "chat:u1", action: "keep_thumbnail" }
  });
  assert.deepEqual(calls[2], {
    method: "cleanupCategoryActionState",
    params: { category: "community" }
  });
  assert.deepEqual(calls[3], {
    method: "applyCleanupCategoryAction",
    params: { category: "community", action: "keep_thumbnail" }
  });
  assert.deepEqual(calls[4], {
    method: "applyCleanupCategoryAction",
    params: { category: "community", action: "clear_keep_thumbnail" }
  });
  assert.deepEqual(calls[5], {
    method: "applyCleanupCategoryAction",
    params: { category: "unconfirmed", action: "delete_all" }
  });
  assert.deepEqual(calls[6], {
    method: "applyCleanupCategoryAction",
    params: { category: "unconfirmed", action: "clear_delete_all" }
  });
  assert.deepEqual(calls.slice(7), [
    { method: "planSafeAttachmentCleanup", params: {} },
    { method: "clearManualAttachmentPlan", params: {} },
    { method: "clearAllRemovalPlans", params: {} }
  ]);
  assert.throws(
    () => provider.applyCleanupGroupAction("chat:u1", "delete_now"),
    TypeError
  );
  assert.throws(
    () => provider.applyCleanupCategoryAction("unconfirmed", "keep_thumbnail"),
    TypeError
  );
  assert.throws(
    () => provider.cleanupCategoryActionState("no_attachments"),
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
  await provider.cleanupPreflight({ verifySource: false });
  await provider.cleanupPlanPreviews();
  assert.deepEqual(calls, [
    { method: "cleanupPreflight", params: {} },
    { method: "cleanupPreflight", params: { verifySource: false } },
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
        squareEmptyChats: 0,
        squareSystemOnlyChats: 0,
        orphanCommunityMessages: 0,
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
  await provider.setCleanupCategoryChatsRemovalPlanned("community", true);
  await provider.planAutomaticCleanup();
  await provider.clearAdvancedCleanupPlan();
  assert.deepEqual(calls, [
    { method: "advancedCleanupReport", params: {} },
    {
      method: "setChatRemovalPlanned",
      params: { source: "square", chatPk: 8, planned: true }
    },
    {
      method: "setCleanupCategoryChatsRemovalPlanned",
      params: { category: "community", planned: true }
    },
    { method: "planAutomaticCleanup", params: {} },
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
  assert.throws(
    () => provider.setCleanupCategoryChatsRemovalPlanned("unconfirmed", true),
    TypeError
  );
});
