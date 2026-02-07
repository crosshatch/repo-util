import { Args, Command } from "@effect/cli"
import { FileSystem, Path } from "@effect/platform"
import { NodeContext } from "@effect/platform-node"
import { Effect, flow, Schema as S } from "effect"
import { argv } from "node:process"
import * as yaml from "yaml"
import packageJson from "./package.json" with { type: "json" }

const args = Args.all({
  root: Args.directory({
    name: "root",
    exists: "yes",
  }),
  child: Args.directory({
    name: "child",
    exists: "yes",
  }),
})

const align = Command.make(
  "align",
  { args },
  Effect.fn(function*({ args: { root: rootDir, child: childDir } }) {
    const path = yield* Path.Path
    const fs = yield* FileSystem.FileSystem

    const rootPackageJsonPathname = path.join(rootDir, "package.json")
    const childPackageJsonPathname = path.join(childDir, "package.json")
    const rootWorkspaceYamlPathname = path.join(rootDir, "pnpm-workspace.yaml")
    const childWorkspaceYamlPathname = path.join(childDir, "pnpm-workspace.yaml")

    // Ensure all manifests exist.
    const childHelixDir = path.join(childDir, ".helix")
    for (
      const pathname of [
        rootPackageJsonPathname,
        childPackageJsonPathname,
        rootPackageJsonPathname,
        childPackageJsonPathname,
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
    const rootPackageJson = yield* fs.readFileString(childPackageJsonPathname).pipe(parsePackageJson)
    Object.assign(rootPackageJson, { packageManager })
    yield* fs.writeFileString(rootPackageJsonPathname, JSON.stringify(rootPackageJson, null, 2))

    // Ensure all child dependencies and packages are represented in the root workspace.
    const {
      catalog: childCatalog,
      packages: childPackages,
    } = yield* fs.readFileString(childWorkspaceYamlPathname).pipe(loadWorkspace)
    const rootWorkspace = yield* fs.readFileString(childWorkspaceYamlPathname).pipe(loadWorkspace)
    Object.assign(rootWorkspace, {
      packages: [
        ...new Set([
          rootWorkspace.packages,
          childPackages.map((pathname) => path.join(rootDir, pathname)),
        ]).values(),
      ].toSorted(),
      catalog: [
        ...new Set([
          ...rootWorkspace.catalog,
          ...childCatalog,
        ]).values(),
      ].toSorted(),
    })
    yield* fs.writeFileString(rootWorkspaceYamlPathname, yaml.stringify(rootWorkspace))
  }),
)

Command.run(align, {
  name: "Crosshatch Repo Util",
  version: packageJson.version,
})(argv).pipe(
  Effect.provide(NodeContext.layer),
  Effect.runFork,
)

const parsePackageJson = Effect.flatMap(S.decodeUnknown(
  S.parseJson(S.Struct({
    packageManager: S.String,
  })),
  { onExcessProperty: "preserve" },
))

const loadWorkspace = flow(
  Effect.map(yaml.parse),
  Effect.flatMap(S.decodeUnknown(
    S.Struct({
      packages: S.Array(S.String),
      catalog: S.Array(S.String),
    }),
    { onExcessProperty: "preserve" },
  )),
)
