"use strict";

const { EventEmitter } = require("node:events");
const { spawn } = require("node:child_process");

const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_RESPONSE_LINE_BYTES = 16 * 1024 * 1024;
const STDERR_TAIL_BYTES = 32 * 1024;
const READY_IDLE_TIMEOUT_MS = 60_000;
const WINDOWS_STACK_OVERFLOW_EXIT_CODE = 0xC00000FD;

function sidecarExitError(code, signal, detail) {
  const exitStatus = code === null ? signal : code;
  const stackOverflow = Number(code) >>> 0 === WINDOWS_STACK_OVERFLOW_EXIT_CODE;
  const hint = stackOverflow
    ? " Windows reported a stack overflow while parsing the backup. Update LINE Cheater and try the backup again. If it persists, the .imazingapp ZIP may be damaged or unsupported."
    : "";
  return new Error(
    `Rust sidecar exited unexpectedly (${exitStatus}).` +
    (detail ? ` ${detail}` : "") +
    hint
  );
}

class SidecarClient extends EventEmitter {
  static async start(command, args, options) {
    const client = new SidecarClient(command, args, options);
    await client.ready;
    return client;
  }

  constructor(command, args, options) {
    super();
    options = options || {};
    this.maxResponseLineBytes = options.maxResponseLineBytes || MAX_RESPONSE_LINE_BYTES;
    this.pending = new Map();
    this.stdoutBuffer = Buffer.alloc(0);
    this.stderrTail = "";
    this.nextId = 1;
    this.closed = false;
    this.readySettled = false;
    this.child = (options.spawn || spawn)(command, args, {
      cwd: options.cwd,
      env: options.env || process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.readyIdleTimeoutMs = options.readyTimeoutMs || READY_IDLE_TIMEOUT_MS;
    this.readyTimer = null;
    this.armReadyTimer();
    this.child.stdout.on("data", (chunk) => this.consumeStdout(chunk));
    this.child.stderr.on("data", (chunk) => this.consumeStderr(chunk));
    this.child.on("error", (error) => this.fail(error));
    this.child.on("exit", (code, signal) => {
      if (!this.closed) {
        const detail = this.stderrTail.trim();
        this.fail(sidecarExitError(code, signal, detail));
      }
    });
  }

  // Preparing a large .imazingapp streams progress events for minutes, so readiness is bounded by
  // silence instead of by total elapsed time.
  armReadyTimer() {
    if (this.readySettled || this.closed) return;
    clearTimeout(this.readyTimer);
    this.readyTimer = setTimeout(() => {
      const error = new Error(
        `Rust sidecar sent no output for ${this.readyIdleTimeoutMs} ms while opening the backup.`
      );
      error.code = "sidecar_not_ready";
      this.fail(error);
    }, this.readyIdleTimeoutMs);
  }

  request(method, params, options) {
    if (this.closed) return Promise.reject(new Error("Rust sidecar is closed."));
    options = options || {};
    const id = String(this.nextId++);
    const request = { id, method, params: params || {} };
    if (options.jobId) request.jobId = options.jobId;
    const line = JSON.stringify(request) + "\n";
    if (Buffer.byteLength(line) > MAX_REQUEST_BYTES) {
      return Promise.reject(new RangeError("Sidecar request exceeds 1 MiB."));
    }
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(line, (error) => {
        if (!error) return;
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  consumeStdout(chunk) {
    if (this.closed) return;
    this.armReadyTimer();
    this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, chunk]);
    while (true) {
      const newline = this.stdoutBuffer.indexOf(0x0a);
      if (newline < 0) break;
      if (newline > this.maxResponseLineBytes) {
        this.fail(new Error("Rust sidecar response line exceeds the desktop limit."));
        return;
      }
      const line = this.stdoutBuffer.subarray(0, newline).toString("utf8").trim();
      this.stdoutBuffer = this.stdoutBuffer.subarray(newline + 1);
      if (line) this.handleLine(line);
      if (this.closed) return;
    }
    if (this.stdoutBuffer.length > this.maxResponseLineBytes) {
      this.fail(new Error("Rust sidecar response line exceeds the desktop limit."));
    }
  }

  handleLine(line) {
    let value;
    try {
      value = JSON.parse(line);
    } catch (error) {
      this.fail(new Error(`Rust sidecar returned invalid JSON: ${error.message}`));
      return;
    }
    if (value && typeof value.event === "string") {
      if (value.event === "ready" && !this.readySettled) {
        this.readySettled = true;
        clearTimeout(this.readyTimer);
        this.resolveReady(value);
      }
      this.emit("sidecarEvent", value);
      return;
    }
    const pending = value && this.pending.get(String(value.id));
    if (!pending) return;
    this.pending.delete(String(value.id));
    if (value.ok) {
      pending.resolve(value.result);
    } else {
      const error = new Error(value.error && value.error.message || "Rust sidecar request failed.");
      error.code = value.error && value.error.code || "operation_failed";
      pending.reject(error);
    }
  }

  consumeStderr(chunk) {
    this.stderrTail = (this.stderrTail + chunk.toString("utf8")).slice(-STDERR_TAIL_BYTES);
  }

  async cancel(reason = "Rust sidecar operation was cancelled.") {
    if (this.closed) return;
    const error = new Error(reason);
    error.code = "operation_cancelled";
    this.closed = true;
    clearTimeout(this.readyTimer);
    if (!this.readySettled) {
      this.readySettled = true;
      this.rejectReady(error);
    }
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();

    await new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      this.child.once("exit", finish);
      this.child.once("error", finish);
      setTimeout(finish, 2_000);
      if (!this.child.killed) this.child.kill();
      else finish();
    });
  }

  fail(error) {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.readyTimer);
    if (!this.readySettled) {
      this.readySettled = true;
      this.rejectReady(error);
    }
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    if (!this.child.killed) this.child.kill();
    this.emit("sidecarFailure", error);
  }

  async dispose() {
    if (this.closed) return;
    try {
      await Promise.race([
        this.request("shutdown", {}),
        new Promise((_, reject) => setTimeout(
          () => reject(new Error("shutdown timeout")),
          2_000
        ))
      ]);
    } catch {
      // The process is terminated below if graceful shutdown is unavailable.
    }
    this.closed = true;
    clearTimeout(this.readyTimer);
    for (const pending of this.pending.values()) {
      pending.reject(new Error("Rust sidecar is closing."));
    }
    this.pending.clear();
    await new Promise((resolve) => {
      if (this.child.exitCode !== null || this.child.signalCode !== null) {
        resolve();
        return;
      }
      let settled = false;
      let timer = null;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      timer = setTimeout(finish, 2_000);
      this.child.once("exit", finish);
      this.child.once("error", finish);
      if (!this.child.killed) this.child.kill();
    });
  }
}

module.exports = {
  MAX_REQUEST_BYTES,
  MAX_RESPONSE_LINE_BYTES,
  WINDOWS_STACK_OVERFLOW_EXIT_CODE,
  sidecarExitError,
  SidecarClient
};
