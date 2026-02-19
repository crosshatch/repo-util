import { Args, Command, Options } from "@effect/cli"
import { FileSystem, Path } from "@effect/platform"
import { createPatch } from "diff"
import { Console, Effect, flow, Schema as S } from "effect"
import { cwd } from "node:process"
import * as yaml from "yaml"

const parsePackageJson = Effect.flatMap(
  S.decodeUnknown(
    S.parseJson(
      S.Struct({
        packageManager: S.String,
      }),
    ),
    { onExcessProperty: "preserve" },
  ),
)

const Dependencies = S.Record({
  key: S.String,
  value: S.String,
})

const stripVersionPrefix = (version: string): string => version.replace(/^[\^~>=<]+/, "")

const compareSemver = (a: string, b: string): number => {
  const pa = stripVersionPrefix(a).split(".").map(Number)
  const pb = stripVersionPrefix(b).split(".").map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

const mergeDependencies = (
  parent: typeof Dependencies.Type,
  child: typeof Dependencies.Type,
): Effect.Effect<typeof Dependencies.Type, string> =>
  Effect.gen(function* () {
    const downgrades: Array<string> = []
    for (const [dep, childVersion] of Object.entries(child)) {
      const parentVersion = parent[dep]
      if (parentVersion !== undefined && compareSemver(childVersion, parentVersion) < 0) {
        downgrades.push(`  ${dep}: child has ${childVersion}, parent has ${parentVersion}`)
      }
    }
    if (downgrades.length > 0) {
      return yield* Effect.fail(`Child catalog contains lower versions than parent:\n${downgrades.join("\n")}`)
    }
    return Object.fromEntries(Object.entries({ ...parent, ...child }).toSorted(([a], [b]) => a.localeCompare(b)))
  })

const loadWorkspace = flow(
  Effect.map(yaml.parse),
  Effect.flatMap(
    S.decodeUnknown(
      S.Struct({
        packages: S.Array(S.String),
        catalog: Dependencies,
        overrides: Dependencies,
      }),
      { onExcessProperty: "preserve" },
    ),
  ),
)

const colorizePatch = (patch: string): string =>
  patch
    .split("\n")
    .map((line) =>
      line.startsWith("-")
        ? `\u001B[31m${line}\u001B[0m`
        : line.startsWith("+")
          ? `\u001B[32m${line}\u001B[0m`
          : line.startsWith("@@")
            ? `\u001B[36m${line}\u001B[0m`
            : line,
    )
    .join("\n")

export const alignCommand = Command.make(
  "align",
  { childDir: Args.text({ name: "child" }), check: Options.boolean("check") },
  Effect.fn(function* ({ childDir, check }) {
    yield* Console.log(`${check ? "Checking alignment with" : "Aligning configuration with that of"} "${childDir}"`)

    const path = yield* Path.Path
    const fs = yield* FileSystem.FileSystem

    const rootPackageJsonPathname = path.join(cwd(), "package.json")
    const childPackageJsonPathname = path.join(childDir, "package.json")
    const rootWorkspaceYamlPathname = path.join(cwd(), "pnpm-workspace.yaml")
    const childWorkspaceYamlPathname = path.join(childDir, "pnpm-workspace.yaml")

    // Ensure all manifests exist.
    for (const pathname of [
      rootPackageJsonPathname,
      childPackageJsonPathname,
      rootWorkspaceYamlPathname,
      childWorkspaceYamlPathname,
    ]) {
      const exists = yield* fs.exists(pathname)
      if (!exists) {
        return yield* Effect.fail(`"${pathname}" does not exist`)
      }
    }

    const artifacts = new Map<string, { original: string; aligned: string }>()

    // Align package manager.
    const { packageManager } = yield* fs.readFileString(childPackageJsonPathname).pipe(parsePackageJson)
    const rootPackageJsonOriginal = yield* fs.readFileString(rootPackageJsonPathname)
    const rootPackageJson = yield* Effect.succeed(rootPackageJsonOriginal).pipe(parsePackageJson)
    Object.assign(rootPackageJson, { packageManager })
    artifacts.set(rootPackageJsonPathname, {
      original: rootPackageJsonOriginal,
      aligned: JSON.stringify(rootPackageJson, null, 2),
    })

    // Ensure all child dependencies and packages are represented in the root workspace.
    const {
      packages: childPackages,
      catalog: childCatalog,
      overrides: childOverrides,
    } = yield* fs.readFileString(childWorkspaceYamlPathname).pipe(loadWorkspace)
    const rootWorkspaceYamlOriginal = yield* fs.readFileString(rootWorkspaceYamlPathname)
    const rootWorkspace = yield* Effect.succeed(rootWorkspaceYamlOriginal).pipe(loadWorkspace)
    Object.assign(rootWorkspace, {
      packages: [
        ...new Set([
          ...rootWorkspace.packages,
          ...childPackages.map((pathname) => path.join(childDir, pathname)),
        ]).values(),
      ].toSorted(),
      catalog: yield* mergeDependencies(rootWorkspace.catalog, childCatalog),
      overrides: yield* mergeDependencies(rootWorkspace.overrides, childOverrides),
    })
    artifacts.set(rootWorkspaceYamlPathname, {
      original: rootWorkspaceYamlOriginal,
      aligned: yaml.stringify(rootWorkspace),
    })

    if (check) {
      const misaligned: Array<string> = []
      for (const [pathname, { original, aligned }] of artifacts) {
        if (original.trim() !== aligned.trim()) {
          misaligned.push(colorizePatch(createPatch(pathname, original.trim(), aligned.trim(), "current", "aligned")))
        }
      }
      if (misaligned.length > 0) {
        yield* Console.error(
          `\u001B[1m\u001B[31mAlignment check failed.\u001B[0m The following files are misaligned:\n\n${misaligned.join(
            "\n\n",
          )}`,
        )
        return yield* Effect.fail("Alignment check failed")
      }
      yield* Console.log("Alignment check passed")
    } else {
      for (const [pathname, { aligned }] of artifacts) {
        yield* fs.writeFileString(pathname, aligned)
      }
    }
  }),
)
