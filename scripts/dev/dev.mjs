import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import electron from "electron";
import { createServer } from "vite";
import { createElectronSupervisor } from "./dev-electron.mjs";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const nativeDirectory = path.resolve(projectRoot, "electron");
const devUrl = "http://127.0.0.1:5173";
const server = await createServer({
  root: projectRoot,
  server: { host: "127.0.0.1", port: 5173, strictPort: true },
});
let closing;
const environment = { ...process.env, VITE_DEV_SERVER_URL: devUrl };
delete environment.ELECTRON_RUN_AS_NODE;
const supervisor = createElectronSupervisor({
  launch: () =>
    spawn(electron, ["."], {
      cwd: projectRoot,
      stdio: ["inherit", "inherit", "inherit", "ipc"],
      detached: process.platform !== "win32",
      env: environment,
    }),
  onExit: (code) => {
    void close(code);
  },
});

async function close(code) {
  if (closing) return closing;
  process.exitCode = code;
  closing = server.close();
  await closing;
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"])
  process.on(signal, () => {
    supervisor.stop();
  });

try {
  await server.listen();
  server.printUrls();
  server.watcher.on("all", (_event, file) => {
    if (
      path.resolve(file).startsWith(nativeDirectory + path.sep) &&
      file.endsWith(".cjs")
    )
      supervisor.changed();
  });
  supervisor.start();
} catch (error) {
  console.error(error.message);
  supervisor.stop(1);
}
