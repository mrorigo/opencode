import { describe, test, expect } from "bun:test"
import { NodeFileSystem } from "@effect/platform-node"
import { Effect, FileSystem, Layer } from "effect"
import { Truncate, Truncate as TruncateSvc } from "../../src/tool/truncate"
import { Identifier } from "../../src/id/id"
import { Process } from "../../src/util/process"
import { Filesystem } from "../../src/util/filesystem"
import path from "path"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { writeFileStringScoped } from "../lib/filesystem"
import { Config } from "../../src/config/config"

const FIXTURES_DIR = path.join(import.meta.dir, "fixtures")
const ROOT = path.resolve(import.meta.dir, "..", "..")

const runTruncate = (
  text: string,
  options?: { maxLines?: number; maxBytes?: number; direction?: "head" | "tail" },
  agent?: any,
) =>
  provideTmpdirInstance(() =>
    Effect.gen(function* () {
      const svc = yield* TruncateSvc.Service
      return yield* svc.output(text, options ?? {}, agent)
    }).pipe(
      Effect.provide(TruncateSvc.layer),
      Effect.provide(NodeFileSystem.layer),
      Effect.provide(Config.defaultLayer),
      Effect.runPromise,
    ),
  )

describe("Truncate", () => {
  describe("output", () => {
    test("truncates large json file by bytes", async () => {
      const content = await Filesystem.readText(path.join(FIXTURES_DIR, "models-api.json"))
      const result = await runTruncate(content)

      expect(result.truncated).toBe(true)
      expect(result.content).toContain("truncated...")
      if (result.truncated) expect(result.outputPath).toBeDefined()
    })

    test("returns content unchanged when under limits", async () => {
      const content = "line1\nline2\nline3"
      const result = await runTruncate(content)

      expect(result.truncated).toBe(false)
      expect(result.content).toBe(content)
    })

    test("truncates by line count", async () => {
      const lines = Array.from({ length: 100 }, (_, i) => `line${i}`).join("\n")
      const result = await runTruncate(lines, { maxLines: 10 })

      expect(result.truncated).toBe(true)
      expect(result.content).toContain("...90 lines truncated...")
    })

    test("truncates by byte count", async () => {
      const content = "a".repeat(1000)
      const result = await runTruncate(content, { maxBytes: 100 })

      expect(result.truncated).toBe(true)
      expect(result.content).toContain("truncated...")
    })

    test("truncates from head by default", async () => {
      const content = Array.from({ length: 50 }, (_, i) => `line${i}`).join("\n")
      const result = await runTruncate(content, { maxLines: 10 })

      expect(result.truncated).toBe(true)
      expect(result.content).toStartWith("line0")
    })

    test("truncates from tail when direction is tail", async () => {
      const content = Array.from({ length: 50 }, (_, i) => `line${i}`).join("\n")
      const result = await runTruncate(content, { maxLines: 10, direction: "tail" })

      expect(result.truncated).toBe(true)
      expect(result.content).toEndWith("line49")
    })

    test("large single-line file truncates with byte message", async () => {
      const content = "a".repeat(1000)
      const result = await runTruncate(content, { maxBytes: 100 })

      expect(result.truncated).toBe(true)
      expect(result.content).toContain("bytes truncated...")
    })

    test("writes full output to file when truncated", async () => {
      const content = Array.from({ length: 100 }, (_, i) => `line${i}`).join("\n")
      const result = await runTruncate(content, { maxLines: 10 })

      expect(result.truncated).toBe(true)
      expect(result.content).toContain("The tool call succeeded but the output was truncated")
      expect(result.outputPath).toBeDefined()
    })

    test("suggests Task tool when agent has task permission", async () => {
      const content = Array.from({ length: 100 }, (_, i) => `line${i}`).join("\n")
      const result = await runTruncate(content, { maxLines: 10 }, { permission: { task: "allow" } })

      expect(result.truncated).toBe(true)
      expect(result.content).toContain("Task tool")
    })

    test("omits Task tool hint when agent lacks task permission", async () => {
      const content = Array.from({ length: 100 }, (_, i) => `line${i}`).join("\n")
      const result = await runTruncate(content, { maxLines: 10 }, { permission: { task: "deny" } })

      expect(result.truncated).toBe(true)
      expect(result.content).not.toContain("Task tool")
    })

    test("does not write file when not truncated", async () => {
      const content = "line1\nline2\nline3"
      const result = await runTruncate(content)

      expect(result.truncated).toBe(false)
    })

    test("loads truncate effect in a fresh process", async () => {
      const out = await Process.run([process.execPath, "run", path.join(ROOT, "src", "tool", "truncate.ts")], {
        cwd: ROOT,
      })

      expect(out.code).toBe(0)
    }, 20000)
  })

  describe("cleanup", () => {
    const DAY_MS = 24 * 60 * 60 * 1000
    const it = testEffect(Layer.mergeAll(TruncateSvc.defaultLayer, NodeFileSystem.layer))

    it.live("deletes files older than 7 days and preserves recent files", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem

        yield* fs.makeDirectory(Truncate.DIR, { recursive: true })

        const old = path.join(Truncate.DIR, Identifier.create("tool", false, Date.now() - 10 * DAY_MS))
        const recent = path.join(Truncate.DIR, Identifier.create("tool", false, Date.now() - 3 * DAY_MS))

        yield* writeFileStringScoped(old, "old content")
        yield* writeFileStringScoped(recent, "recent content")
        yield* TruncateSvc.Service.use((s) => s.cleanup())

        expect(yield* fs.exists(old)).toBe(false)
        expect(yield* fs.exists(recent)).toBe(true)
      }),
    )
  })
})
