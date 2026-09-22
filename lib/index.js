// src/host/review.js
import { exec } from "node:child_process";
import { RemoteError, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";

// src/host/unified.js
var HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;
function unquotePath(field) {
  if (field.length < 2 || !field.startsWith('"') || !field.endsWith('"')) return field;
  const body = field.slice(1, -1);
  const bytes = [];
  for (let at = 0; at < body.length; at += 1) {
    const character = body[at];
    if (character !== "\\") {
      const code = (
        /** @type {number} */
        character.codePointAt(0)
      );
      if (code < 128) bytes.push(code);
      else bytes.push(...new TextEncoder().encode(character));
      continue;
    }
    const after = body[at + 1];
    if (after === void 0) break;
    if (after >= "0" && after <= "7") {
      let digits = "";
      while (digits.length < 3 && body[at + 1] >= "0" && body[at + 1] <= "7") {
        digits += body[at + 1];
        at += 1;
      }
      bytes.push(Number.parseInt(digits, 8) & 255);
      continue;
    }
    const simple = SIMPLE_ESCAPES[after];
    if (simple !== void 0) bytes.push(simple);
    else bytes.push(...new TextEncoder().encode(after));
    at += 1;
  }
  return new TextDecoder("utf-8").decode(Uint8Array.from(bytes));
}
var SIMPLE_ESCAPES = {
  a: 7,
  b: 8,
  f: 12,
  n: 10,
  r: 13,
  t: 9,
  v: 11,
  '"': 34,
  "\\": 92
};
function headerPath(field) {
  const trimmed = field.replace(/\s+$/, "");
  if (trimmed === "/dev/null") return "";
  const decoded = unquotePath(trimmed);
  const slash = decoded.indexOf("/");
  if (slash === 1 && (decoded.startsWith("a/") || decoded.startsWith("b/"))) return decoded.slice(2);
  return decoded;
}
function destinationOf(field) {
  const arrow = field.indexOf(" => ");
  if (arrow < 0) return unquotePath(field);
  const before = unquotePath(field.slice(0, arrow));
  const after = unquotePath(field.slice(arrow + 4));
  const open = before.lastIndexOf("{");
  const close = after.indexOf("}");
  if (open < 0 || close < 0) return after;
  return before.slice(0, open) + after.slice(0, close) + after.slice(close + 1);
}
function binaryPath(line) {
  const body = line.slice("Binary files ".length).replace(/ differ$/, "");
  const at = body.lastIndexOf(" and ");
  if (at < 0) return "";
  return headerPath(body.slice(at + " and ".length));
}
function parseUnifiedDiff(patch) {
  const files = [];
  let file = null;
  let hunk = null;
  let oldCursor = 0;
  let newCursor = 0;
  let plusPath = null;
  let minusPath = null;
  const closeHunk = () => {
    if (hunk !== null && hunk.lines.length > 0 && file !== null) file.hunks.push(hunk);
    hunk = null;
  };
  const closeFile = () => {
    closeHunk();
    if (file !== null) {
      if (file.path === "" && plusPath !== null) file.path = plusPath;
      if (file.path === "" && minusPath !== null && minusPath !== "") file.path = minusPath;
      if (file.hunks.length === 0 && !file.binary) file.notice = "no-body";
      if (file.path !== "") files.push(file);
    }
    file = null;
    plusPath = null;
    minusPath = null;
  };
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      closeFile();
      file = { path: "", oldPath: null, binary: false, notice: null, hunks: [] };
      continue;
    }
    if (file === null) continue;
    if (line.startsWith("--- ")) {
      minusPath = headerPath(line.slice(4));
      continue;
    }
    if (line.startsWith("+++ ")) {
      plusPath = headerPath(line.slice(4));
      continue;
    }
    if (line.startsWith("rename from ") || line.startsWith("copy from ")) {
      file.oldPath = headerPath(line.slice("rename from ".length));
      continue;
    }
    if (line.startsWith("rename to ") || line.startsWith("copy to ")) {
      file.path = headerPath(line.slice("rename to ".length));
      continue;
    }
    if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
      file.binary = true;
      if (line.startsWith("Binary files ")) {
        const stated = binaryPath(line);
        if (stated !== "") file.path = stated;
      }
      continue;
    }
    if (hunk === null) {
      if (!line.startsWith("@@")) continue;
      const match = HUNK_HEADER.exec(line);
      if (match === null) continue;
      oldCursor = Number(match[1]);
      newCursor = Number(match[3]);
      hunk = {
        header: match[5] ?? "",
        oldStart: oldCursor,
        newStart: newCursor,
        oldCount: match[2] === void 0 ? 1 : Number(match[2]),
        newCount: match[4] === void 0 ? 1 : Number(match[4]),
        lines: []
      };
      continue;
    }
    const marker = line.slice(0, 1);
    if (marker === "-") {
      hunk.lines.push({ kind: "del", text: line.slice(1), oldNumber: oldCursor, newNumber: null });
      oldCursor += 1;
      continue;
    }
    if (marker === "+") {
      hunk.lines.push({ kind: "add", text: line.slice(1), oldNumber: null, newNumber: newCursor });
      newCursor += 1;
      continue;
    }
    if (marker === " ") {
      hunk.lines.push({ kind: "ctx", text: line.slice(1), oldNumber: oldCursor, newNumber: newCursor });
      oldCursor += 1;
      newCursor += 1;
      continue;
    }
    if (marker === "\\") continue;
    closeHunk();
  }
  closeFile();
  return files;
}
function parseNumstat(stdout) {
  const counts = /* @__PURE__ */ new Map();
  const records = stdout.split("\0");
  for (let at = 0; at < records.length; at += 1) {
    const record = records[at];
    if (record === void 0 || record.length === 0) continue;
    const first = record.indexOf("	");
    if (first < 0) continue;
    const second = record.indexOf("	", first + 1);
    if (second < 0) continue;
    const added = record.slice(0, first);
    const removed = record.slice(first + 1, second);
    const path = record.slice(second + 1);
    const target = path === "" ? records[at += 2] ?? "" : path;
    if (target === "") continue;
    counts.set(target, {
      added: added === "-" ? null : Number(added),
      removed: removed === "-" ? null : Number(removed)
    });
  }
  return counts;
}
var NAME_STATUS = {
  A: "added",
  M: "modified",
  D: "deleted",
  T: "typechange",
  R: "renamed",
  C: "copied"
};
function parseNameStatus(stdout) {
  const records = stdout.split("\0");
  const entries = [];
  for (let at = 0; at < records.length; at += 1) {
    const code = records[at];
    if (code === void 0 || code.length === 0) continue;
    const letter = code.slice(0, 1);
    if (letter === "R" || letter === "C") {
      const from = records[at + 1] ?? "";
      const to = records[at + 2] ?? "";
      at += 2;
      if (to !== "") entries.push({ path: to, status: NAME_STATUS[letter], renamedFrom: from });
      continue;
    }
    const path = records[at + 1] ?? "";
    at += 1;
    if (path !== "") entries.push({ path, status: NAME_STATUS[letter] ?? "modified", renamedFrom: null });
  }
  return entries;
}
function buildTree(files) {
  const nodes = /* @__PURE__ */ new Map();
  const root = { name: "", path: "", directories: [], files: [], added: 0, removed: 0 };
  nodes.set("", root);
  for (const file of files) {
    const parts = file.path.split("/");
    let parent = root;
    for (let at = 0; at < parts.length - 1; at += 1) {
      const name = parts[at];
      const path = parent.path === "" ? name : `${parent.path}/${name}`;
      let child = nodes.get(path);
      if (child === void 0) {
        child = { name, path, directories: [], files: [], added: 0, removed: 0 };
        nodes.set(path, child);
        parent.directories.push(child);
      }
      parent = child;
    }
    parent.files.push(file);
  }
  const settle = (node) => {
    for (const child of node.directories) {
      settle(child);
      node.added += child.added;
      node.removed += child.removed;
    }
    for (const file of node.files) {
      node.added += file.added ?? 0;
      node.removed += file.removed ?? 0;
    }
  };
  settle(root);
  return { directories: sortTree(root.directories.map(fold)), files: sortFiles(root.files) };
}
function sortFiles(files) {
  return [...files].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}
function fold(node) {
  let head = node;
  let name = node.name;
  while (head.files.length === 0 && head.directories.length === 1) {
    head = head.directories[0];
    name = `${name}/${head.name}`;
  }
  return {
    kind: "directory",
    name,
    path: head.path,
    directories: head.directories.map(fold),
    files: head.files,
    added: node.added,
    removed: node.removed
  };
}
function sortTree(nodes) {
  const ordered = [...nodes].sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  for (const node of ordered) {
    node.directories = sortTree(node.directories);
    node.files = sortFiles(node.files);
  }
  return ordered;
}

// src/host/review.js
var DEFAULT_CONFIG = {
  /** Largest patch, in bytes, that crosses the wire; a larger one arrives cut. */
  maxDiffBytes: 2 * 1024 * 1024,
  /** Cap on reported changed files; the rest is dropped and reported cut. */
  maxStatusEntries: 5e3,
  /** Cap on the commits listed in the Commit view. */
  maxCommits: 50
};
var MAX_BUFFER = 32 * 1024 * 1024;
function run(command, signal) {
  return new Promise((resolve, reject) => {
    exec(command, {
      encoding: "utf8",
      maxBuffer: MAX_BUFFER,
      windowsHide: true,
      signal,
      shell: "/bin/sh",
      env: {
        ...process.env,
        GIT_OPTIONAL_LOCKS: "0",
        GIT_PAGER: "cat",
        GIT_TERMINAL_PROMPT: "0",
        GIT_EXTERNAL_DIFF: ""
      }
    }, (error, stdout, stderr) => {
      if (error === null) {
        resolve({ code: 0, stdout, stderr });
        return;
      }
      if (error.code === "ERR_CHILD_PROCESS_STDOUT_MAXBUFFER") {
        resolve({ code: 0, stdout, stderr });
        return;
      }
      if (typeof error.code === "number") {
        resolve({ code: error.code, stdout, stderr });
        return;
      }
      reject(Object.assign(new Error(error.message), {
        spawnFailure: true,
        output: `${stderr}${error.code === "ENOENT" ? " (is git installed?)" : ""}`
      }));
    });
  });
}
function quote(value) {
  return `'${value.split("'").join("'\\''")}'`;
}
var CONFLICT_CODES = /* @__PURE__ */ new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);
function statusOf(index, worktree) {
  if (CONFLICT_CODES.has(`${index}${worktree}`)) return "conflicted";
  if (index === "?" && worktree === "?") return "untracked";
  switch (index !== " " && index !== "?" ? index : worktree) {
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    case "T":
      return "typechange";
    default:
      return "modified";
  }
}
function parseBranchHeader(header) {
  const line = header.replace(/^## /, "");
  if (line === "") return { branch: null, detached: false, upstream: null, ahead: 0, behind: 0 };
  if (line === "HEAD (no branch)") return { branch: null, detached: true, upstream: null, ahead: 0, behind: 0 };
  const state = /\[(.*)]$/.exec(line)?.[1];
  const names = line.replace(/\s*\[.*]$/, "");
  if (names.startsWith("No commits yet on ")) {
    const branch2 = names.slice("No commits yet on ".length);
    return { branch: branch2, detached: false, upstream: null, ahead: 0, behind: 0 };
  }
  const separator = names.indexOf("...");
  const branch = separator < 0 ? names : names.slice(0, separator);
  const upstream = separator < 0 ? "" : names.slice(separator + 3);
  const ahead = /ahead (\d+)/.exec(state ?? "");
  const behind = /behind (\d+)/.exec(state ?? "");
  return {
    branch: branch === "" ? null : branch,
    detached: false,
    upstream: upstream === "" ? null : upstream,
    ahead: ahead === null ? 0 : Number(ahead[1]),
    behind: behind === null ? 0 : Number(behind[1])
  };
}
function parseStatus(stdout, maxEntries) {
  const records = stdout.split("\0").filter((record) => record.length > 0);
  const header = records.shift() ?? "";
  const entries = [];
  let truncated = false;
  for (let at = 0; at < records.length; at += 1) {
    if (entries.length >= maxEntries) {
      truncated = true;
      break;
    }
    const record = records[at];
    const index = record.slice(0, 1);
    const worktree = record.slice(1, 2);
    const renamedFrom = index === "R" || index === "C" ? records[at += 1] ?? null : null;
    entries.push({ path: record.slice(3), index, worktree, renamedFrom });
  }
  return { summary: parseBranchHeader(header), entries, truncated };
}
var WorkspaceReview = class extends TypertRemoteService {
  static inject = ["sandboxPolicy"];
  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx - Host context carrying the sandbox policy.
   * @param {Partial<typeof DEFAULT_CONFIG>} [config] - Overrides for the deployment caps.
   */
  constructor(ctx, config = {}) {
    super(ctx, "workspaceReview");
    this.config = { ...DEFAULT_CONFIG, ...config };
  }
  /**
   * The branch summary and every uncommitted file of the session's workspace.
   * @param {object} agent - Target Agent resolved from the Session identity on the wire.
   * @param {AbortSignal} signal - Caller cancellation.
   * @returns {Promise<object>} The report; `isRepository: false` when the root is not a work tree.
   */
  async changes(agent, signal) {
    const root = this.rootOf(agent);
    if (!await this.isRepository(root, signal)) {
      return {
        isRepository: false,
        root: null,
        branch: null,
        detached: false,
        upstream: null,
        ahead: 0,
        behind: 0,
        files: [],
        tree: { directories: [], files: [] },
        added: 0,
        removed: 0,
        truncated: false
      };
    }
    const [status, counts] = await Promise.all([
      this.status(root, signal),
      this.counts(root, signal)
    ]);
    const untrackedPaths = status.entries.filter((entry) => entry.index === "?" && entry.worktree === "?" && !counts.has(entry.path)).map((entry) => entry.path);
    const untrackedCounts = new Map(await Promise.all(untrackedPaths.map(async (path) => [path, await this.untrackedCount(root, path, signal)])));
    const files = [];
    let added = 0;
    let removed = 0;
    for (const entry of status.entries) {
      const count = counts.get(entry.path) ?? untrackedCounts.get(entry.path) ?? null;
      const line = {
        path: entry.path,
        status: statusOf(entry.index, entry.worktree),
        index: entry.index,
        worktree: entry.worktree,
        staged: entry.index !== " " && entry.index !== "?",
        unstaged: entry.worktree !== " " && entry.worktree !== "?",
        untracked: entry.index === "?" && entry.worktree === "?",
        renamedFrom: entry.renamedFrom,
        added: count === null ? null : count.added,
        removed: count === null ? null : count.removed
      };
      if (line.added !== null) added += line.added;
      if (line.removed !== null) removed += line.removed;
      files.push(line);
    }
    files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
    return {
      isRepository: true,
      root,
      ...status.summary,
      files,
      // The directory tree is built here rather than in the browser so both
      // planes share one grouping rule, and so a folder's totals come from the
      // same counts its file rows show.
      tree: buildTree(files),
      added,
      removed,
      truncated: status.truncated
    };
  }
  /**
   * The unified diff of one changed path, parsed into hunks.
   *
   * The body is the working tree against HEAD, so staged and unstaged edits
   * appear together as one diff against the last commit. A path with no
   * committed and no staged side is untracked, and its whole content is
   * reported as additions.
   * @param {object} agent - Target Agent resolved from the Session identity on the wire.
   * @param {string} path - Repository-relative path from a `changes` row.
   * @param {AbortSignal} signal - Caller cancellation.
   * @returns {Promise<object>} The parsed diff.
   */
  async diff(agent, path, signal) {
    const root = this.rootOf(agent);
    if (typeof path !== "string" || path.length === 0 || path.startsWith("/") || path.includes("\0")) {
      throw new RemoteError("gateway/bad-request", `invalid path ${JSON.stringify(path)}`, {});
    }
    if (!await this.isRepository(root, signal)) {
      throw new RemoteError("workspace-review/not-repository", `"${root}" is not a Git work tree`, { root });
    }
    const unborn = !await this.hasHead(root, signal);
    const source = await this.sourceOf(root, path, signal);
    const paths = source === null ? [path] : [source, path];
    let result = await run(this.git(root, [
      "diff",
      "--no-color",
      "--no-ext-diff",
      "--find-renames",
      ...unborn ? ["--cached"] : ["HEAD"],
      "--",
      ...paths.map(quote)
    ]), signal);
    let untracked = false;
    if (result.code === 0 && result.stdout.length === 0 && !unborn) {
      result = await this.untrackedPatch(root, path, signal);
      untracked = true;
    }
    if (result.code !== 0 && result.stdout.length === 0) {
      throw new RemoteError(
        "workspace-review/command-failed",
        `git diff failed for ${JSON.stringify(path)}: ${result.stderr.trim() || `exit ${String(result.code)}`}`,
        { command: `git diff -- ${path}`, output: result.stderr }
      );
    }
    const patch = result.stdout.slice(0, this.config.maxDiffBytes);
    const parsed = parseUnifiedDiff(patch)[0];
    return {
      isRepository: true,
      untracked,
      truncated: result.stdout.length > this.config.maxDiffBytes,
      // A patch with no section of its own is still a change the row named —
      // a pure rename, or a mode change — so the file keeps its path and says
      // why it carries no lines rather than reading as "no diff".
      file: parsed ?? {
        path,
        oldPath: source,
        binary: false,
        notice: "no-body",
        hunks: []
      },
      patch
    };
  }
  /**
   * The recent commits of the session workspace, newest first.
   *
   * Metadata only: a commit's file list is read lazily by `commitChanges`, so
   * opening the Commit view does not pay for a diff of every commit.
   * @param {object} agent - Target Agent resolved from the Session identity on the wire.
   * @param {AbortSignal} signal - Caller cancellation.
   * @returns {Promise<object>} The commit list; `isRepository: false` when the root is not a work tree.
   */
  async commits(agent, signal) {
    const root = this.rootOf(agent);
    if (!await this.isRepository(root, signal)) {
      return { isRepository: false, root: null, commits: [] };
    }
    const stdout = await this.gitRun(root, [
      "log",
      `-n${this.config.maxCommits}`,
      "--no-color",
      "--no-merges",
      "--pretty=format:%H%x00%h%x00%at%x00%an%x00%s%x00"
    ], signal, "git log");
    const commits = [];
    for (const record of stdout.split("\n")) {
      if (record === "") continue;
      const [oid, short, at, author, subject] = record.split("\0");
      if (oid === void 0 || oid === "") continue;
      commits.push({
        oid,
        short: short === void 0 || short === "" ? oid.slice(0, 7) : short,
        timestamp: Number(at) || 0,
        author: author ?? "",
        subject: subject ?? ""
      });
    }
    return { isRepository: true, root, commits };
  }
  /**
   * One commit's changed files, with counts and a directory tree.
   * @param {object} agent - Target Agent resolved from the Session identity on the wire.
   * @param {string} oid - The commit to read.
   * @param {AbortSignal} signal - Caller cancellation.
   * @returns {Promise<object>} The commit report.
   */
  async commitChanges(agent, oid, signal) {
    const root = this.rootOf(agent);
    this.oidOf(oid);
    const [numstat, nameStatus] = await Promise.all([
      this.gitRun(root, ["show", "--numstat", "-z", "-M", "--format=", oid], signal, "git show --numstat"),
      this.gitRun(root, ["show", "--name-status", "-z", "-M", "--format=", oid], signal, "git show --name-status")
    ]);
    const counts = parseNumstat(numstat);
    const files = [];
    let added = 0;
    let removed = 0;
    for (const entry of parseNameStatus(nameStatus)) {
      const count = counts.get(entry.path) ?? null;
      const line = {
        path: entry.path,
        status: entry.status,
        index: " ",
        worktree: " ",
        staged: false,
        unstaged: false,
        untracked: false,
        renamedFrom: entry.renamedFrom,
        added: count === null ? null : count.added,
        removed: count === null ? null : count.removed
      };
      if (line.added !== null) added += line.added;
      if (line.removed !== null) removed += line.removed;
      files.push(line);
    }
    files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
    return {
      isRepository: true,
      root,
      oid,
      files,
      tree: buildTree(files),
      added,
      removed
    };
  }
  /**
   * The unified diff of one path within one commit, parsed into hunks.
   * @param {object} agent - Target Agent resolved from the Session identity on the wire.
   * @param {string} oid - The commit to read.
   * @param {string} path - Repository-relative path from a `commitChanges` row.
   * @param {AbortSignal} signal - Caller cancellation.
   * @returns {Promise<object>} The parsed diff, shaped like `diff`.
   */
  async commitDiff(agent, oid, path, signal) {
    const root = this.rootOf(agent);
    this.oidOf(oid);
    if (typeof path !== "string" || path.length === 0 || path.startsWith("/") || path.includes("\0")) {
      throw new RemoteError("gateway/bad-request", `invalid path ${JSON.stringify(path)}`, {});
    }
    const result = await run(this.git(root, [
      "show",
      "--no-color",
      "--no-ext-diff",
      "--find-renames",
      "--format=",
      oid,
      "--",
      quote(path)
    ]), signal);
    if (result.code !== 0 && result.stdout.length === 0) {
      throw new RemoteError(
        "workspace-review/command-failed",
        `git show failed for ${JSON.stringify(path)}: ${result.stderr.trim() || `exit ${String(result.code)}`}`,
        { command: `git show ${oid} -- ${path}`, output: result.stderr }
      );
    }
    const patch = result.stdout.slice(0, this.config.maxDiffBytes);
    const parsed = parseUnifiedDiff(patch)[0];
    return {
      isRepository: true,
      untracked: false,
      truncated: result.stdout.length > this.config.maxDiffBytes,
      file: parsed ?? { path, oldPath: null, binary: false, notice: "no-body", hunks: [] },
      patch
    };
  }
  /**
   * Validate a commit id is a hex object name.
   * @param {string} oid - The candidate.
   * @returns {string} The id, unchanged.
   */
  oidOf(oid) {
    if (typeof oid !== "string" || !/^[0-9a-f]{4,64}$/i.test(oid)) {
      throw new RemoteError("gateway/bad-request", `invalid commit ${JSON.stringify(oid)}`, {});
    }
    return oid;
  }
  /**
   * The source path of a rename or copy that produced `path`, else `null`.
   *
   * The status listing is the only place Git states both names. The listing is
   * taken whole and filtered here rather than narrowed with a pathspec: rename
   * detection is a whole-tree comparison, so `status -- <new path>` reports a
   * moved file as a fresh addition and never names its source. Renames are
   * switched on explicitly so the answer cannot depend on the reader's own
   * `status.renames` configuration.
   * @param {string} root - Absolute workspace root.
   * @param {string} path - Repository-relative destination path.
   * @param {AbortSignal} signal - Caller cancellation.
   * @returns {Promise<string|null>} The source path, or `null` when the row is not a rename or copy.
   */
  async sourceOf(root, path, signal) {
    const result = await run(this.git(root, [
      "status",
      "--porcelain=v1",
      "-z",
      "--branch",
      "--untracked-files=no",
      "-M"
    ]), signal);
    if (result.code !== 0) return null;
    const { entries } = parseStatus(result.stdout, this.config.maxStatusEntries);
    return entries.find((entry) => entry.path === path)?.renamedFrom ?? null;
  }
  /**
   * The session's workspace root, resolved by the policy like the file service does.
   * @param {object} agent - Target Agent resolved from the Session identity.
   * @returns {string} Absolute workspace root.
   */
  rootOf(agent) {
    return this.ctx.sandboxPolicy.resolve({ session: agent.session }).workspaceRoot;
  }
  /**
   * One `git -C <root> --literal-pathspecs <args…>` command line.
   * @param {string} root - Absolute workspace root.
   * @param {readonly string[]} args - Already-quoted arguments.
   * @returns {string} The command line.
   */
  git(root, args) {
    return ["git", "-C", quote(root), "--literal-pathspecs", ...args].join(" ");
  }
  /**
   * Run one git command that must succeed.
   * @param {string} root - Absolute workspace root.
   * @param {readonly string[]} args - Already-quoted arguments.
   * @param {AbortSignal} signal - Caller cancellation.
   * @param {string} what - Human-readable command name for the failure message.
   * @returns {Promise<string>} Stdout.
   */
  async gitRun(root, args, signal, what) {
    const result = await run(this.git(root, args), signal);
    if (result.code !== 0) {
      throw new RemoteError(
        "workspace-review/command-failed",
        `${what} failed: ${result.stderr.trim() || `exit ${String(result.code)}`}`,
        { command: what, output: result.stderr }
      );
    }
    return result.stdout;
  }
  /**
   * Whether the root answers `rev-parse --is-inside-work-tree`.
   * @param {string} root - Absolute workspace root.
   * @param {AbortSignal} signal - Caller cancellation.
   * @returns {Promise<boolean>} True when the root is inside a Git work tree.
   */
  async isRepository(root, signal) {
    const result = await run(this.git(root, ["rev-parse", "--is-inside-work-tree"]), signal);
    return result.code === 0 && result.stdout.trim() === "true";
  }
  /**
   * Whether HEAD resolves; a repository with no commits has none.
   * @param {string} root - Absolute workspace root.
   * @param {AbortSignal} signal - Caller cancellation.
   * @returns {Promise<boolean>} True when HEAD names a commit.
   */
  async hasHead(root, signal) {
    const result = await run(this.git(root, ["rev-parse", "--verify", "--quiet", "HEAD"]), signal);
    return result.code === 0;
  }
  /**
   * The porcelain listing of the root.
   * @param {string} root - Absolute workspace root.
   * @param {AbortSignal} signal - Caller cancellation.
   * @returns {Promise<ReturnType<typeof parseStatus>>} The parsed listing.
   */
  async status(root, signal) {
    const stdout = await this.gitRun(root, [
      "status",
      "--porcelain=v1",
      "-z",
      "--branch",
      "--untracked-files=all"
    ], signal, "git status");
    return parseStatus(stdout, this.config.maxStatusEntries);
  }
  /**
   * Per-path added and removed counts.
   *
   * `git diff HEAD` covers staged and unstaged changes in one pass. An unborn
   * repository has no HEAD, so the staged half comes from `--cached`.
   * @param {string} root - Absolute workspace root.
   * @param {AbortSignal} signal - Caller cancellation.
   * @returns {Promise<ReturnType<typeof parseNumstat>>} Counts by path.
   */
  async counts(root, signal) {
    const base = await this.hasHead(root, signal) ? "HEAD" : "--cached";
    const stdout = await this.gitRun(root, ["diff", base, "--numstat", "-z", "-M"], signal, "git diff --numstat");
    return parseNumstat(stdout);
  }
  /**
   * Render an untracked file as an all-additions unified diff.
   *
   * The file is handed to `git diff --no-index` against the null device so Git
   * itself decides the quoting, the binary case, and the hunk header, and so no
   * second text decoder has to agree with Git about encoding. Exit `1` is this
   * command's success: it means the two sides differ.
   * @param {string} root - Absolute workspace root.
   * @param {string} path - Repository-relative path.
   * @param {AbortSignal} signal - Caller cancellation.
   * @returns {Promise<{ code: number, stdout: string, stderr: string }>} The synthesized diff.
   */
  async untrackedPatch(root, path, signal) {
    const absolute = `${root.replace(/[/\\]+$/, "")}/${path}`;
    const result = await run(this.git(root, [
      "diff",
      "--no-color",
      "--no-ext-diff",
      "--no-index",
      "--",
      "/dev/null",
      quote(absolute)
    ]), signal);
    return result.code === 1 ? { ...result, code: 0 } : result;
  }
  /**
   * Added and removed counts for one untracked path.
   *
   * `git diff` omits untracked paths, so the count comes from `--no-index`
   * against the null device — the same read the diff body uses, so Git itself
   * decides the binary case. A path Git reports as binary yields two `null`s.
   * @param {string} root - Absolute workspace root.
   * @param {string} path - Repository-relative path.
   * @param {AbortSignal} signal - Caller cancellation.
   * @returns {Promise<{ added: number|null, removed: number|null }|null>} The counts, or `null` when the read failed.
   */
  async untrackedCount(root, path, signal) {
    const absolute = `${root.replace(/[/\\]+$/, "")}/${path}`;
    const result = await run(this.git(root, [
      "diff",
      "--no-index",
      "--numstat",
      "--no-color",
      "--",
      "/dev/null",
      quote(absolute)
    ]), signal);
    if (result.code !== 0 && result.code !== 1) return null;
    const record = result.stdout.split("\n")[0] ?? "";
    const [added, removed] = record.split("	");
    if (added === void 0 || removed === void 0) return null;
    return {
      added: added === "-" ? null : Number(added),
      removed: removed === "-" ? null : Number(removed)
    };
  }
};
export {
  DEFAULT_CONFIG,
  WorkspaceReview,
  buildTree,
  WorkspaceReview as default,
  destinationOf,
  headerPath,
  parseBranchHeader,
  parseNameStatus,
  parseNumstat,
  parseStatus,
  parseUnifiedDiff,
  sortFiles,
  sortTree,
  unquotePath
};
//# sourceMappingURL=index.js.map
