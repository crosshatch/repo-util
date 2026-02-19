import { Command } from "@effect/cli"
import { NodeContext, NodeRuntime } from "@effect/platform-node"
import { Effect } from "effect"
import { argv } from "node:process"

import { alignCommand } from "./align.ts"
import { cleanCommand } from "./clean.ts"
import PackageJson from "./package.json" with { type: "json" }

Command.run(Command.make("repo-util").pipe(Command.withSubcommands([alignCommand, cleanCommand])), {
  name: "Crosshatch Repo Util",
  version: PackageJson.version,
})(argv).pipe(Effect.provide(NodeContext.layer), NodeRuntime.runMain)
