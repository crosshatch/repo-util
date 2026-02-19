import { Args, Command } from "@effect/cli"
import { FileSystem, Path } from "@effect/platform"
import { Console, Effect } from "effect"
import { glob } from "node:fs/promises"

const cleanPackage = Effect.fn(function* (packageJsonPath: string) {
  const path = yield* Path.Path
  const fs = yield* FileSystem.FileSystem
  const dir = packageJsonPath.split("package.json").shift() ?? ""
  yield* Console.log(`Cleaning "${dir}"`)
  yield* Effect.all(
    [".tsbuildinfo", "dist", "node_modules", ".tanstack", ".turbo"].map((v) =>
      fs.remove(path.join(dir, v), {
        recursive: true,
        force: true,
      }),
    ),
    { concurrency: "unbounded" },
  )
})

export const cleanCommand = Command.make(
  "clean",
  {
    ignore: Args.repeated(
      Args.directory({
        name: "ignore",
        exists: "either",
      }),
    ),
  },
  Effect.fn(function* ({ ignore }) {
    const packages = yield* Effect.promise(() => Array.fromAsync(glob("**/package.json"))).pipe(
      Effect.map((v) => v.filter((v) => !ignore.some((w) => v.startsWith(w)))),
    )
    yield* Effect.all(packages.map(cleanPackage), { concurrency: "unbounded" })
  }),
)
