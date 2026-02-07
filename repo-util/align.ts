import { Args, Command } from "@effect/cli"
import { FileSystem, Path } from "@effect/platform"
import { Console, Effect, flow, Schema as S } from "effect"
import { cwd } from "node:process"
import * as yaml from "yaml"

const parsePackageJson = Effect.flatMap(S.decodeUnknown(
  S.parseJson(S.Struct({
    packageManager: S.String,
  })),
  { onExcessProperty: "preserve" },
))

const Dependencies = S.Record({
  key: S.String,
  value: S.String,
})

const mergeDependencies = (
  a: typeof Dependencies.Type,
  b: typeof Dependencies.Type,
) =>
  Object.fromEntries(
    Object.entries({ ...a, ...b }).toSorted(([a], [b]) => a.localeCompare(b)),
  )

const loadWorkspace = flow(
  Effect.map(yaml.parse),
  Effect.flatMap(S.decodeUnknown(
    S.Struct({
      packages: S.Array(S.String),
      catalog: Dependencies,
      overrides: Dependencies,
    }),
    { onExcessProperty: "preserve" },
  )),
)

export const alignCommand = Command.make(
  "align",
  { childDir: Args.text({ name: "child" }) },
  Effect.fn(function*({ childDir }) {
    yield* Console.log(`Aligning configuration with that of "${childDir}"`)

    const path = yield* Path.Path
    const fs = yield* FileSystem.FileSystem

    const rootPackageJsonPathname = path.join(cwd(), "package.json")
    const childPackageJsonPathname = path.join(childDir, "package.json")
    const rootWorkspaceYamlPathname = path.join(cwd(), "pnpm-workspace.yaml")
    const childWorkspaceYamlPathname = path.join(childDir, "pnpm-workspace.yaml")

    // Ensure all manifests exist.
    const childHelixDir = path.join(childDir, ".helix")
    for (
      const pathname of [
        rootPackageJsonPathname,
        childPackageJsonPathname,
        rootWorkspaceYamlPathname,
        childWorkspaceYamlPathname,
        childHelixDir,
      ]
    ) {
      const exists = yield* fs.exists(pathname)
      if (!exists) {
        return yield* Effect.fail(`"${pathname}" does not exist`)
      }
    }

    // Align package manager.
    const { packageManager } = yield* fs.readFileString(childPackageJsonPathname).pipe(parsePackageJson)
    const rootPackageJson = yield* fs.readFileString(rootPackageJsonPathname).pipe(parsePackageJson)
    Object.assign(rootPackageJson, { packageManager })
    yield* fs.writeFileString(rootPackageJsonPathname, JSON.stringify(rootPackageJson, null, 2))

    // Ensure all child dependencies and packages are represented in the root workspace.
    const {
      packages: childPackages,
      catalog: childCatalog,
      overrides: childOverrides,
    } = yield* fs.readFileString(childWorkspaceYamlPathname).pipe(loadWorkspace)
    const rootWorkspace = yield* fs.readFileString(rootWorkspaceYamlPathname).pipe(loadWorkspace)
    Object.assign(rootWorkspace, {
      packages: [
        ...new Set([
          ...rootWorkspace.packages,
          ...childPackages.map((pathname) => path.join(childDir, pathname)),
        ]).values(),
      ].toSorted(),
      catalog: mergeDependencies(rootWorkspace.catalog, childCatalog),
      overrides: mergeDependencies(rootWorkspace.overrides, childOverrides),
    })
    yield* fs.writeFileString(rootWorkspaceYamlPathname, yaml.stringify(rootWorkspace))
  }),
)
