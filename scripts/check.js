import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";

function javascriptFiles(directory) {
  return readdirSync(directory).flatMap((name) => {
    const full = path.join(directory, name);
    return statSync(full).isDirectory() ? javascriptFiles(full) : /\.(js|jsx)$/.test(name) ? [full] : [];
  });
}

const serverFiles = javascriptFiles("server").filter((file) => file.endsWith(".js"));
for (const file of serverFiles) execFileSync(process.execPath, ["--check", file], { stdio: "inherit" });
execFileSync(process.execPath, ["node_modules/vite/bin/vite.js", "build", "--config", "client/vite.config.js"], { stdio: "inherit" });
