/* Hand-maintained Typert artifact: keep it in step with `src/host/review.js`.
 * The Gateway serves `workspaceReview` from the invocations below, so this file
 * is the Host half's wire declaration; the checkout's typert generator would
 * emit the same descriptors from a TypeScript source. Regenerate rather than
 * hand-edit whenever the Host methods change. */

import { z } from 'zod'

const statusSchema = z.enum([
  'added', 'modified', 'deleted', 'renamed', 'copied', 'typechange', 'untracked', 'conflicted',
])

const fileSchema = z.object({
  'path': z.string().readonly(),
  'status': statusSchema.readonly(),
  'index': z.string().readonly(),
  'worktree': z.string().readonly(),
  'staged': z.boolean().readonly(),
  'unstaged': z.boolean().readonly(),
  'untracked': z.boolean().readonly(),
  'renamedFrom': z.string().readonly().nullable(),
  'added': z.number().readonly().nullable(),
  'removed': z.number().readonly().nullable(),
})

const treeNodeSchema = z.lazy(() => z.object({
  'kind': z.literal('directory').readonly(),
  'name': z.string().readonly(),
  'path': z.string().readonly(),
  'directories': z.array(treeNodeSchema).readonly(),
  'files': z.array(fileSchema).readonly(),
  'added': z.number().readonly(),
  'removed': z.number().readonly(),
}))

const reportSchema = z.object({
  'isRepository': z.boolean().readonly(),
  'root': z.string().readonly().nullable(),
  'branch': z.string().readonly().nullable(),
  'detached': z.boolean().readonly(),
  'upstream': z.string().readonly().nullable(),
  'ahead': z.number().readonly(),
  'behind': z.number().readonly(),
  'files': z.array(fileSchema).readonly(),
  'tree': z.object({
    'directories': z.array(treeNodeSchema).readonly(),
    'files': z.array(fileSchema).readonly(),
  }).readonly(),
  'added': z.number().readonly(),
  'removed': z.number().readonly(),
  'truncated': z.boolean().readonly(),
})

const lineSchema = z.object({
  'kind': z.enum(['add', 'del', 'ctx']).readonly(),
  'text': z.string().readonly(),
  'oldNumber': z.number().readonly().nullable(),
  'newNumber': z.number().readonly().nullable(),
})

const hunkSchema = z.object({
  'header': z.string().readonly(),
  'oldStart': z.number().readonly(),
  'newStart': z.number().readonly(),
  'oldCount': z.number().readonly(),
  'newCount': z.number().readonly(),
  'lines': z.array(lineSchema).readonly(),
})

const diffSchema = z.object({
  'isRepository': z.boolean().readonly(),
  'untracked': z.boolean().readonly(),
  'truncated': z.boolean().readonly(),
  'file': z.object({
    'path': z.string().readonly(),
    'oldPath': z.string().readonly().nullable(),
    'binary': z.boolean().readonly(),
    'notice': z.string().readonly().nullable(),
    'hunks': z.array(hunkSchema).readonly(),
  }).readonly().nullable(),
  'patch': z.string().readonly(),
})

const commitSchema = z.object({
  'oid': z.string().readonly(),
  'short': z.string().readonly(),
  'timestamp': z.number().readonly(),
  'author': z.string().readonly(),
  'subject': z.string().readonly(),
})

const commitsSchema = z.object({
  'isRepository': z.boolean().readonly(),
  'root': z.string().readonly().nullable(),
  'commits': z.array(commitSchema).readonly(),
})

const commitReportSchema = z.object({
  'isRepository': z.boolean().readonly(),
  'root': z.string().readonly().nullable(),
  'oid': z.string().readonly(),
  'files': z.array(fileSchema).readonly(),
  'tree': z.object({
    'directories': z.array(treeNodeSchema).readonly(),
    'files': z.array(fileSchema).readonly(),
  }).readonly(),
  'added': z.number().readonly(),
  'removed': z.number().readonly(),
})

const filesSchema = z.object({
  'isRepository': z.boolean().readonly(),
  'root': z.string().readonly().nullable(),
  'files': z.array(fileSchema).readonly(),
  'tree': z.object({
    'directories': z.array(treeNodeSchema).readonly(),
    'files': z.array(fileSchema).readonly(),
  }).readonly(),
  'count': z.number().readonly(),
  'truncated': z.boolean().readonly(),
})

const fileTextSchema = z.object({
  'path': z.string().readonly(),
  'binary': z.boolean().readonly(),
  'truncated': z.boolean().readonly(),
  'bytes': z.number().readonly(),
  'text': z.string().readonly(),
})

const writeResultSchema = z.object({
  'path': z.string().readonly(),
  'bytes': z.number().readonly(),
})

/** A JSON string parameter (a commit id or a path). */
function stringParameter(name, typeSymbol) {
  return {
    name,
    wire: name,
    source: 'json',
    codec: { mode: 'strict', typeSymbol, schema: z.string() },
  }
}

/** The Session-identity lookup parameter both methods lead with. */
const agentParameter = {
  name: 'agent',
  wire: 'agentId',
  source: 'lookup',
  lookup: 'agent',
  codec: {
    mode: 'strict',
    typeSymbol: '@deepseek-ai/dsh-session/types#SessionId',
    schema: z.intersection(z.string(), z.unknown()),
  },
}

/** The Host-face manifest the typert loader registers for this package. */
export const TYPERT = {
  package: 'dsh-review',
  face: 'host',
  schemas: [],
  invocations: [
    {
      id: 'dsh-review#workspaceReview/changes',
      service: 'workspaceReview',
      namespace: 'workspaceReview',
      method: 'changes',
      invocation: { kind: 'direct' },
      scope: { context: 'agent', wire: 'agentId' },
      parameters: [agentParameter],
      cancellation: { parameter: 'signal' },
      result: {
        mode: 'strict',
        typeSymbol: 'dsh-review/host/types#ReviewReport',
        schema: reportSchema,
      },
    },
    {
      id: 'dsh-review#workspaceReview/diff',
      service: 'workspaceReview',
      namespace: 'workspaceReview',
      method: 'diff',
      invocation: { kind: 'direct' },
      scope: { context: 'agent', wire: 'agentId' },
      parameters: [
        agentParameter,
        {
          name: 'path',
          wire: 'path',
          source: 'json',
          codec: {
            mode: 'strict',
            typeSymbol: 'dsh-review/host/types#ReviewPath',
            schema: z.string(),
          },
        },
      ],
      cancellation: { parameter: 'signal' },
      result: {
        mode: 'strict',
        typeSymbol: 'dsh-review/host/types#ReviewDiff',
        schema: diffSchema,
      },
    },
    {
      id: 'dsh-review#workspaceReview/commits',
      service: 'workspaceReview',
      namespace: 'workspaceReview',
      method: 'commits',
      invocation: { kind: 'direct' },
      scope: { context: 'agent', wire: 'agentId' },
      parameters: [agentParameter],
      cancellation: { parameter: 'signal' },
      result: {
        mode: 'strict',
        typeSymbol: 'dsh-review/host/types#ReviewCommits',
        schema: commitsSchema,
      },
    },
    {
      id: 'dsh-review#workspaceReview/commitChanges',
      service: 'workspaceReview',
      namespace: 'workspaceReview',
      method: 'commitChanges',
      invocation: { kind: 'direct' },
      scope: { context: 'agent', wire: 'agentId' },
      parameters: [
        agentParameter,
        stringParameter('oid', 'dsh-review/host/types#CommitId'),
      ],
      cancellation: { parameter: 'signal' },
      result: {
        mode: 'strict',
        typeSymbol: 'dsh-review/host/types#ReviewCommit',
        schema: commitReportSchema,
      },
    },
    {
      id: 'dsh-review#workspaceReview/commitDiff',
      service: 'workspaceReview',
      namespace: 'workspaceReview',
      method: 'commitDiff',
      invocation: { kind: 'direct' },
      scope: { context: 'agent', wire: 'agentId' },
      parameters: [
        agentParameter,
        stringParameter('oid', 'dsh-review/host/types#CommitId'),
        stringParameter('path', 'dsh-review/host/types#ReviewPath'),
      ],
      cancellation: { parameter: 'signal' },
      result: {
        mode: 'strict',
        typeSymbol: 'dsh-review/host/types#ReviewDiff',
        schema: diffSchema,
      },
    },
    {
      id: 'dsh-review#workspaceReview/listFiles',
      service: 'workspaceReview',
      namespace: 'workspaceReview',
      method: 'listFiles',
      invocation: { kind: 'direct' },
      scope: { context: 'agent', wire: 'agentId' },
      parameters: [agentParameter],
      cancellation: { parameter: 'signal' },
      result: {
        mode: 'strict',
        typeSymbol: 'dsh-review/host/types#ReviewFiles',
        schema: filesSchema,
      },
    },
    {
      id: 'dsh-review#workspaceReview/readFile',
      service: 'workspaceReview',
      namespace: 'workspaceReview',
      method: 'readFile',
      invocation: { kind: 'direct' },
      scope: { context: 'agent', wire: 'agentId' },
      parameters: [
        agentParameter,
        stringParameter('path', 'dsh-review/host/types#ReviewPath'),
      ],
      cancellation: { parameter: 'signal' },
      result: {
        mode: 'strict',
        typeSymbol: 'dsh-review/host/types#ReviewFileText',
        schema: fileTextSchema,
      },
    },
    {
      id: 'dsh-review#workspaceReview/writeFile',
      service: 'workspaceReview',
      namespace: 'workspaceReview',
      method: 'writeFile',
      invocation: { kind: 'direct' },
      scope: { context: 'agent', wire: 'agentId' },
      parameters: [
        agentParameter,
        stringParameter('path', 'dsh-review/host/types#ReviewPath'),
        stringParameter('text', 'dsh-review/host/types#ReviewText'),
      ],
      cancellation: { parameter: 'signal' },
      result: {
        mode: 'strict',
        typeSymbol: 'dsh-review/host/types#ReviewWriteResult',
        schema: writeResultSchema,
      },
    },
  ],
  model: {
    services: [
      {
        description: "Host Remote service reading one session workspace's changes and files over the git CLI and filesystem.",
        summary: 'Workspace review: uncommitted status, commits, per-file diffs, a file tree, and an opt-in file write.',
        tags: [],
        jsDoc: "/** Host Remote service reading one session workspace's uncommitted changes over the git CLI. */",
        key: 'workspaceReview',
        exportName: 'WorkspaceReview',
        members: [
          {
            kind: 'method',
            name: 'changes',
            signature: '@Remote async changes(agent: object, signal: AbortSignal): Promise<ReviewReport>',
            summary: "The branch summary and every uncommitted file of the session's workspace.",
            jsDoc: "/** The branch summary and every uncommitted file of the session's workspace. */",
          },
          {
            kind: 'method',
            name: 'diff',
            signature: '@Remote async diff(agent: object, path: string, signal: AbortSignal): Promise<ReviewDiff>',
            summary: 'The unified diff of one changed path, parsed into hunks.',
            jsDoc: '/** The unified diff of one changed path, parsed into hunks. */',
          },
          {
            kind: 'method',
            name: 'commits',
            signature: '@Remote async commits(agent: object, signal: AbortSignal): Promise<ReviewCommits>',
            summary: 'The recent commits of the session workspace, newest first.',
            jsDoc: '/** The recent commits of the session workspace, newest first. */',
          },
          {
            kind: 'method',
            name: 'commitChanges',
            signature: '@Remote async commitChanges(agent: object, oid: string, signal: AbortSignal): Promise<ReviewCommit>',
            summary: "One commit's changed files, with counts and a directory tree.",
            jsDoc: "/** One commit's changed files, with counts and a directory tree. */",
          },
          {
            kind: 'method',
            name: 'commitDiff',
            signature: '@Remote async commitDiff(agent: object, oid: string, path: string, signal: AbortSignal): Promise<ReviewDiff>',
            summary: 'The unified diff of one path within one commit, parsed into hunks.',
            jsDoc: '/** The unified diff of one path within one commit, parsed into hunks. */',
          },
          {
            kind: 'method',
            name: 'listFiles',
            signature: '@Remote async listFiles(agent: object, signal: AbortSignal): Promise<ReviewFiles>',
            summary: "Every non-ignored file of the session workspace, as a directory tree.",
            jsDoc: '/** Every non-ignored file of the session workspace, as a directory tree. */',
          },
          {
            kind: 'method',
            name: 'readFile',
            signature: '@Remote async readFile(agent: object, path: string, signal: AbortSignal): Promise<ReviewFileText>',
            summary: 'Read one workspace file as text.',
            jsDoc: '/** Read one workspace file as text. */',
          },
          {
            kind: 'method',
            name: 'writeFile',
            signature: '@Remote async writeFile(agent: object, path: string, text: string, signal: AbortSignal): Promise<ReviewWriteResult>',
            summary: 'Write one workspace file as text (the Files view editor).',
            jsDoc: '/** Write one workspace file as text (the Files view editor). */',
          },
        ],
        types: [
          {
            name: 'ReviewFileStatus',
            declaration: "export type ReviewFileStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'typechange' | 'untracked' | 'conflicted';",
          },
          {
            name: 'ReviewFile',
            declaration: 'export interface ReviewFile { readonly path: string; readonly status: ReviewFileStatus; readonly index: string; readonly worktree: string; readonly staged: boolean; readonly unstaged: boolean; readonly untracked: boolean; readonly renamedFrom: string | null; readonly added: number | null; readonly removed: number | null; }',
          },
          {
            name: 'ReviewReport',
            declaration: 'export interface ReviewReport { readonly isRepository: boolean; readonly root: string | null; readonly branch: string | null; readonly detached: boolean; readonly upstream: string | null; readonly ahead: number; readonly behind: number; readonly files: readonly ReviewFile[]; readonly added: number; readonly removed: number; readonly truncated: boolean; }',
          },
          {
            name: 'ReviewLine',
            declaration: "export interface ReviewLine { readonly kind: 'add' | 'del' | 'ctx'; readonly text: string; readonly oldNumber: number | null; readonly newNumber: number | null; }",
          },
          {
            name: 'ReviewHunk',
            declaration: 'export interface ReviewHunk { readonly header: string; readonly oldStart: number; readonly newStart: number; readonly oldCount: number; readonly newCount: number; readonly lines: readonly ReviewLine[]; }',
          },
          {
            name: 'ReviewFileDiff',
            declaration: 'export interface ReviewFileDiff { readonly path: string; readonly oldPath: string | null; readonly binary: boolean; readonly notice: string | null; readonly hunks: readonly ReviewHunk[]; }',
          },
          {
            name: 'ReviewDiff',
            declaration: 'export interface ReviewDiff { readonly isRepository: boolean; readonly untracked: boolean; readonly truncated: boolean; readonly file: ReviewFileDiff | null; readonly patch: string; }',
          },
          {
            name: 'CommitId',
            declaration: 'export type CommitId = string;',
          },
          {
            name: 'ReviewCommitMeta',
            declaration: 'export interface ReviewCommitMeta { readonly oid: string; readonly short: string; readonly timestamp: number; readonly author: string; readonly subject: string; }',
          },
          {
            name: 'ReviewCommits',
            declaration: 'export interface ReviewCommits { readonly isRepository: boolean; readonly root: string | null; readonly commits: readonly ReviewCommitMeta[]; }',
          },
          {
            name: 'ReviewCommit',
            declaration: 'export interface ReviewCommit { readonly isRepository: boolean; readonly root: string | null; readonly oid: string; readonly files: readonly ReviewFile[]; readonly added: number; readonly removed: number; }',
          },
          {
            name: 'ReviewFiles',
            declaration: 'export interface ReviewFiles { readonly isRepository: boolean; readonly root: string | null; readonly files: readonly ReviewFile[]; readonly count: number; readonly truncated: boolean; }',
          },
          {
            name: 'ReviewFileText',
            declaration: 'export interface ReviewFileText { readonly path: string; readonly binary: boolean; readonly truncated: boolean; readonly bytes: number; readonly text: string; }',
          },
          {
            name: 'ReviewWriteResult',
            declaration: 'export interface ReviewWriteResult { readonly path: string; readonly bytes: number; }',
          },
          {
            name: 'ReviewText',
            declaration: 'export type ReviewText = string;',
          },
        ],
      },
    ],
    events: [],
    objects: [],
  },
}

export default TYPERT
