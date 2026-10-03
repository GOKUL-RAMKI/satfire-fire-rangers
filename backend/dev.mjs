import { spawn } from "node:child_process";

const command = process.platform === "win32" ? "npm.cmd" : "npm";
const spawnOptions = { stdio: "inherit", shell: process.platform === "win32" };
const children = [
  spawn(command, ["run", "dev:api"], spawnOptions),
  spawn(command, ["run", "dev:ui"], spawnOptions),
];

const shutdown = () => children.forEach((child) => child.kill());
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
children.forEach((child) => child.on("exit", (code) => {
  if (code && code !== 130) process.exitCode = code;
}));
