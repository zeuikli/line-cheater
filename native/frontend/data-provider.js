(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.LineNativeDataProvider = api.NativeDataProvider;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var MAX_PAGE_SIZE = 1000;
  var CLEANUP_PAGE_SIZE = 24;
  var CLEANUP_KINDS = ["all", "original", "thumbnail", "marked"];
  var CLEANUP_CATEGORIES = ["all", "individual", "group", "community", "unreferenced", "unconfirmed", "no_attachments"];
  var CLEANUP_SORTS = ["recent", "oldest", "size", "path"];

  function assertBridge(bridge) {
    if (!bridge || typeof bridge.request !== "function") {
      throw new TypeError("NativeDataProvider requires a bridge.request(method, params) function.");
    }
  }

  function boundedLimit(value, fallback) {
    var limit = value === undefined || value === null ? fallback : Number(value);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
      throw new RangeError("Page size must be an integer between 1 and " + MAX_PAGE_SIZE + ".");
    }
    return limit;
  }

  function boundedMessageSource(value) {
    value = String(value || "line");
    if (value !== "line" && value !== "square") {
      throw new TypeError("Message source must be line or square.");
    }
    return value;
  }

  function assertPage(value, method) {
    if (!value || !Array.isArray(value.items)) {
      throw new TypeError(method + " returned an invalid page.");
    }
    if (value.items.length > MAX_PAGE_SIZE) {
      throw new RangeError(method + " returned more than " + MAX_PAGE_SIZE + " items.");
    }
    return value;
  }

  function boundedPage(value) {
    var page = value === undefined || value === null ? 1 : Number(value);
    if (!Number.isInteger(page) || page < 1) {
      throw new RangeError("Page must be a positive integer.");
    }
    return page;
  }

  function enumValue(value, fallback, allowed, label) {
    value = value === undefined || value === null ? fallback : String(value);
    if (!allowed.includes(value)) {
      throw new TypeError(label + " has an unsupported value.");
    }
    return value;
  }

  function cleanupParams(options) {
    options = options || {};
    var search = String(options.search || "").trim();
    if (new TextEncoder().encode(search).length > 1024) {
      throw new RangeError("Cleanup search cannot exceed 1,024 UTF-8 bytes.");
    }
    return {
      page: boundedPage(options.page),
      pageSize: boundedLimit(options.pageSize, CLEANUP_PAGE_SIZE),
      search: search || null,
      kind: enumValue(options.kind, "all", CLEANUP_KINDS, "Cleanup kind"),
      category: enumValue(options.category, "all", CLEANUP_CATEGORIES, "Cleanup category"),
      sort: enumValue(options.sort, "recent", CLEANUP_SORTS, "Cleanup sort")
    };
  }

  function assertCleanupPage(value, method) {
    assertPage(value, method);
    if (!Number.isInteger(value.page) || value.page < 1 ||
        !Number.isInteger(value.pageSize) || value.pageSize < 1 ||
        !Number.isInteger(value.totalItems) || value.totalItems < 0 ||
        !Number.isInteger(value.totalPages) || value.totalPages < 1) {
      throw new TypeError(method + " returned invalid pagination metadata.");
    }
    return value;
  }

  function NativeDataProvider(bridge) {
    assertBridge(bridge);
    this.bridge = bridge;
  }

  NativeDataProvider.prototype.sessionInfo = function () {
    return this.bridge.request("sessionInfo", {});
  };

  NativeDataProvider.prototype.listChats = async function (options) {
    options = options || {};
    var page = await this.bridge.request("listChats", {
      limit: boundedLimit(options.limit, 100),
      cursor: options.cursor || null,
      beforeCursor: options.beforeCursor || null
    });
    return assertPage(page, "listChats");
  };

  NativeDataProvider.prototype.listMessages = async function (chatPk, options) {
    options = options || {};
    if (!Number.isInteger(Number(chatPk))) throw new TypeError("chatPk must be an integer.");
    var page = await this.bridge.request("listMessages", {
      chatPk: Number(chatPk),
      source: boundedMessageSource(options.source),
      limit: boundedLimit(options.limit, 180),
      cursor: options.cursor || null,
      beforeCursor: options.beforeCursor || null
    });
    return assertPage(page, "listMessages");
  };

  NativeDataProvider.prototype.searchMessages = async function (query, options) {
    options = options || {};
    query = String(query || "").trim();
    if (!query) throw new TypeError("Search query is required.");
    if (new TextEncoder().encode(query).length > 1024) {
      throw new RangeError("Search query cannot exceed 1,024 UTF-8 bytes.");
    }
    var chatPk = options.chatPk === undefined || options.chatPk === null
      ? null
      : Number(options.chatPk);
    if (chatPk !== null && !Number.isInteger(chatPk)) {
      throw new TypeError("chatPk must be an integer.");
    }
    var page = await this.bridge.request("searchMessages", {
      query: query,
      chatPk: chatPk,
      source: boundedMessageSource(options.source),
      limit: boundedLimit(options.limit, 180),
      cursor: options.cursor || null,
      beforeCursor: options.beforeCursor || null
    });
    return assertPage(page, "searchMessages");
  };

  NativeDataProvider.prototype.scanCatalog = function () {
    return this.bridge.request("scanCatalog", {});
  };

  NativeDataProvider.prototype.listAttachments = async function (options) {
    options = options || {};
    var page = await this.bridge.request("listAttachments", {
      limit: boundedLimit(options.limit, 100),
      cursor: options.cursor || null,
      kind: options.kind || null,
      search: options.search || null
    });
    return assertPage(page, "listAttachments");
  };

  NativeDataProvider.prototype.exportAttachments = function (options) {
    options = options || {};
    if (!options.output || typeof options.output !== "string") {
      throw new TypeError("An export destination token is required.");
    }
    var paths = Array.isArray(options.paths) ? options.paths.slice() : [];
    if (paths.length > 1000 || paths.some((path) => typeof path !== "string" || !path || path.length > 4096)) {
      throw new RangeError("Export selections must contain at most 1,000 valid paths.");
    }
    var source = options.source === undefined || options.source === null
      ? null
      : boundedMessageSource(options.source);
    var chatPk = options.chatPk === undefined || options.chatPk === null
      ? null
      : Number(options.chatPk);
    if (chatPk !== null && !Number.isInteger(chatPk)) {
      throw new TypeError("chatPk must be an integer.");
    }
    if (!paths.length && (source === null || chatPk === null)) {
      throw new TypeError("Export paths or a source/chat scope is required.");
    }
    if (paths.length && (source !== null || chatPk !== null)) {
      throw new TypeError("Export paths cannot be combined with a chat scope.");
    }
    return this.bridge.request("exportAttachments", {
      output: options.output,
      paths: paths,
      source: source,
      chatPk: chatPk,
      imagesOnly: Boolean(options.imagesOnly),
      includeThumbnails: Boolean(options.includeThumbnails)
    });
  };

  NativeDataProvider.prototype.exportAttachmentsFiltered = function (options) {
    options = options || {};
    if (!options.output || typeof options.output !== "string") {
      throw new TypeError("An export destination token is required.");
    }
    var search = options.search ? String(options.search) : null;
    if (search && new TextEncoder().encode(search).length > 1024) {
      throw new RangeError("Attachment search cannot exceed 1,024 UTF-8 bytes.");
    }
    function stringList(value, limit) {
      if (!Array.isArray(value)) return [];
      return value
        .filter(function (item) { return typeof item === "string" && item; })
        .slice(0, limit);
    }
    var kind = options.kind === "original" || options.kind === "thumbnail"
      ? options.kind
      : null;
    return this.bridge.request("exportAttachmentsFiltered", {
      output: options.output,
      kind: kind,
      search: search,
      includeChats: stringList(options.includeChats, 4096),
      excludeChats: stringList(options.excludeChats, 4096),
      includeCategories: stringList(options.includeCategories, 32),
      excludeCategories: stringList(options.excludeCategories, 32),
      includeThumbnails: Boolean(options.includeThumbnails)
    });
  };

  NativeDataProvider.prototype.exportConversation = function (options) {
    options = options || {};
    if (!options.output || typeof options.output !== "string") {
      throw new TypeError("A conversation output token is required.");
    }
    var chatPk = Number(options.chatPk);
    if (!Number.isInteger(chatPk)) throw new TypeError("chatPk must be an integer.");
    return this.bridge.request("exportConversation", {
      output: options.output,
      source: boundedMessageSource(options.source),
      chatPk: chatPk
    });
  };

  NativeDataProvider.prototype.setAttachmentMarked = function (path, marked) {
    if (!path || typeof path !== "string") throw new TypeError("Attachment path is required.");
    return this.bridge.request("setAttachmentMarked", {
      path: path,
      marked: Boolean(marked)
    });
  };

  NativeDataProvider.prototype.clearManualAttachmentPlan = function () {
    return this.bridge.request("clearManualAttachmentPlan", {});
  };

  NativeDataProvider.prototype.clearAllRemovalPlans = function () {
    return this.bridge.request("clearAllRemovalPlans", {});
  };

  NativeDataProvider.prototype.catalogStats = function () {
    return this.bridge.request("catalogStats", {});
  };

  NativeDataProvider.prototype.cleanupOverview = function () {
    return this.bridge.request("cleanupOverview", {});
  };

  NativeDataProvider.prototype.cleanupPreflight = function (options) {
    options = options || {};
    var params = options.verifySource === false ? { verifySource: false } : {};
    return this.bridge.request("cleanupPreflight", params);
  };

  NativeDataProvider.prototype.cleanupPlanPreviews = function () {
    return this.bridge.request("cleanupPlanPreviews", {});
  };

  NativeDataProvider.prototype.cleanupAudit = function (limit) {
    return this.bridge.request("cleanupAudit", {
      limit: boundedLimit(limit, 20)
    });
  };

  NativeDataProvider.prototype.listCleanupGroups = async function (options) {
    var page = await this.bridge.request("listCleanupGroups", cleanupParams(options));
    return assertCleanupPage(page, "listCleanupGroups");
  };

  NativeDataProvider.prototype.listCleanupReviews = async function (groupKey, options) {
    if (!groupKey || typeof groupKey !== "string" || groupKey.length > 1024) {
      throw new TypeError("Cleanup group key is required.");
    }
    var params = cleanupParams(options);
    params.groupKey = groupKey;
    var page = await this.bridge.request("listCleanupReviews", params);
    return assertCleanupPage(page, "listCleanupReviews");
  };

  NativeDataProvider.prototype.applyCleanupGroupAction = function (groupKey, action) {
    if (!groupKey || typeof groupKey !== "string" || groupKey.length > 1024) {
      throw new TypeError("Cleanup group key is required.");
    }
    action = enumValue(action, "", ["toggle_all", "keep_thumbnail"], "Cleanup group action");
    return this.bridge.request("applyCleanupGroupAction", {
      groupKey: groupKey,
      action: action
    });
  };

  NativeDataProvider.prototype.planSafeAttachmentCleanup = function () {
    return this.bridge.request("planSafeAttachmentCleanup", {});
  };

  NativeDataProvider.prototype.advancedCleanupReport = function () {
    return this.bridge.request("advancedCleanupReport", {});
  };

  NativeDataProvider.prototype.setChatRemovalPlanned = function (source, chatPk, planned) {
    source = boundedMessageSource(source);
    if (!Number.isInteger(Number(chatPk))) throw new TypeError("chatPk must be an integer.");
    return this.bridge.request("setChatRemovalPlanned", {
      source: source,
      chatPk: Number(chatPk),
      planned: Boolean(planned)
    });
  };

  NativeDataProvider.prototype.setCleanupCategoryChatsRemovalPlanned = function (category, planned) {
    category = enumValue(
      category,
      "",
      ["all", "individual", "group", "community"],
      "Chat cleanup category"
    );
    return this.bridge.request("setCleanupCategoryChatsRemovalPlanned", {
      category: category,
      planned: Boolean(planned)
    });
  };

  NativeDataProvider.prototype.planAutomaticCleanup = function () {
    return this.bridge.request("planAutomaticCleanup", {});
  };

  NativeDataProvider.prototype.clearAdvancedCleanupPlan = function () {
    return this.bridge.request("clearAdvancedCleanupPlan", {});
  };

  NativeDataProvider.prototype.hashDuplicateCandidates = function () {
    return this.bridge.request("hashDuplicateCandidates", {});
  };

  NativeDataProvider.prototype.listDuplicateGroups = async function (options) {
    options = options || {};
    var page = await this.bridge.request("listDuplicateGroups", {
      limit: boundedLimit(options.limit, 100),
      cursor: options.cursor || null
    });
    return assertPage(page, "listDuplicateGroups");
  };

  NativeDataProvider.prototype.listDuplicateMembers = async function (sha256, options) {
    options = options || {};
    if (!/^[a-fA-F0-9]{64}$/.test(String(sha256 || ""))) {
      throw new TypeError("sha256 must contain exactly 64 hexadecimal characters.");
    }
    var page = await this.bridge.request("listDuplicateMembers", {
      sha256: String(sha256).toLowerCase(),
      limit: boundedLimit(options.limit, 100),
      cursor: options.cursor || null
    });
    return assertPage(page, "listDuplicateMembers");
  };

  NativeDataProvider.prototype.buildCandidate = function (output, options) {
    options = options || {};
    if (!output || typeof output !== "string") throw new TypeError("Candidate output path is required.");
    return this.bridge.request("buildCandidate", {
      output: output,
      fullCrc: Boolean(options.fullCrc),
      linkDuplicates: Boolean(options.linkDuplicates),
      allowLineSquareRebuild: Boolean(options.allowLineSquareRebuild)
    });
  };

  NativeDataProvider.prototype.cleanupCategoryActionState = function (category) {
    category = enumValue(
      category,
      "",
      ["all", "individual", "group", "community", "unreferenced", "unconfirmed"],
      "Cleanup category action state"
    );
    return this.bridge.request("cleanupCategoryActionState", {
      category: category
    });
  };

  NativeDataProvider.prototype.applyCleanupCategoryAction = function (category, action) {
    category = enumValue(
      category,
      "",
      ["all", "individual", "group", "community", "unreferenced", "unconfirmed"],
      "Cleanup category action"
    );
    action = enumValue(
      action,
      "",
      ["keep_thumbnail", "clear_keep_thumbnail", "delete_all", "clear_delete_all"],
      "Cleanup category action"
    );
    if (["keep_thumbnail", "clear_keep_thumbnail"].includes(action) &&
        !["all", "individual", "group", "community"].includes(category)) {
      throw new TypeError("Keep-thumbnail action requires a chat-backed cleanup category.");
    }
    return this.bridge.request("applyCleanupCategoryAction", {
      category: category,
      action: action
    });
  };

  NativeDataProvider.prototype.onCatalogProgress = function (handler) {
    if (typeof this.bridge.on !== "function") {
      throw new TypeError("The native bridge does not support event subscriptions.");
    }
    return this.bridge.on("catalogProgress", handler);
  };

  NativeDataProvider.prototype.onCatalogContextProgress = function (handler) {
    if (typeof this.bridge.on !== "function") {
      throw new TypeError("The native bridge does not support event subscriptions.");
    }
    return this.bridge.on("catalogContextProgress", handler);
  };

  NativeDataProvider.prototype.onCleanupMutationProgress = function (handler) {
    if (typeof this.bridge.on !== "function") {
      throw new TypeError("The native bridge does not support event subscriptions.");
    }
    return this.bridge.on("cleanupMutationProgress", handler);
  };

  NativeDataProvider.prototype.onCandidateProgress = function (handler) {
    if (typeof this.bridge.on !== "function") {
      throw new TypeError("The native bridge does not support event subscriptions.");
    }
    return this.bridge.on("candidateProgress", handler);
  };

  NativeDataProvider.prototype.onDuplicateHashProgress = function (handler) {
    if (typeof this.bridge.on !== "function") {
      throw new TypeError("The native bridge does not support event subscriptions.");
    }
    return this.bridge.on("duplicateHashProgress", handler);
  };

  return {
    NativeDataProvider: NativeDataProvider,
    MAX_PAGE_SIZE: MAX_PAGE_SIZE,
    CLEANUP_PAGE_SIZE: CLEANUP_PAGE_SIZE
  };
});
