const {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  net,
  protocol,
  session,
  shell,
} = require("electron");
const { readFile, stat, writeFile } = require("node:fs/promises");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { createWorkspaceStore } = require("./services/workspace-store.cjs");
const { createFileImporter } = require("./services/file-import.cjs");
const { createNativeI18n, resolveLanguage } = require("./i18n.cjs");
const nativeI18n = createNativeI18n();
const { t, localizeMessage } = nativeI18n;
let systemLocale = "en";

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 100 * 1024 * 1024;
const DEV_URL = "http://127.0.0.1:5173";
const APP_URL = "app://json-craft/index.html";
const isDev = !app.isPackaged && process.env.VITE_DEV_SERVER_URL === DEV_URL;
const distRoot = path.resolve(__dirname, "..", "dist");
const productionPolicy =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; worker-src 'self' blob:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'";

let mainWindow = null;
let rendererReady = false;
let queuedPaths = [];
let workspaceStore;
let quitRequested = false;
let startupReady = false;
const fileImporter = createFileImporter();

function getWorkspaceStore() {
  if (!workspaceStore)
    workspaceStore = createWorkspaceStore({
      userDataDirectory: app.getPath("userData"),
      documentsDirectory: app.getPath("documents"),
      trashFile: (filePath) => shell.trashItem(filePath),
    });
  return workspaceStore;
}

function windowBackgroundColor() {
  return nativeTheme.shouldUseDarkColors ? "#0c0e12" : "#fbfcfb";
}

function updateWindowBackground() {
  if (mainWindow && !mainWindow.isDestroyed())
    mainWindow.setBackgroundColor(windowBackgroundColor());
}

function applyThemePreference(theme) {
  if (nativeTheme.themeSource !== theme) nativeTheme.themeSource = theme;
  updateWindowBackground();
}

async function updateWorkspaceSettings(patch) {
  const settings = await getWorkspaceStore().updateSettings(patch);
  applyThemePreference(settings.theme);
  nativeI18n.setLanguage(settings.language ?? "system", systemLocale);
  installMenu();
  return settings;
}

app.setName("JSON Craft");
app.setAppUserModelId("dev.jsoncraft.desktop");
protocol.registerSchemesAsPrivileged([
  {
    scheme: "app",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
]);

function trustedFrame(event) {
  if (
    !mainWindow ||
    mainWindow.isDestroyed() ||
    event.sender !== mainWindow.webContents ||
    event.senderFrame !== mainWindow.webContents.mainFrame
  )
    return false;
  try {
    const url = new URL(event.senderFrame.url);
    return isDev
      ? url.origin === DEV_URL
      : url.protocol === "app:" &&
          url.hostname === "json-craft" &&
          url.pathname === "/index.html";
  } catch {
    return false;
  }
}

function handle(channel, handler) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!trustedFrame(event)) throw new Error("不受信任的窗口请求。");
    return handler(...args);
  });
}

function validateText(value) {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value, "utf8") > MAX_OUTPUT_BYTES
  )
    throw new Error("内容过大或格式无效，最多支持 100 MiB 输出。");
}

async function readFiles(filePaths) {
  return Promise.all(
    filePaths.map(async (filePath) => {
      const name = path.basename(filePath);
      try {
        if (!/\.json$/i.test(name)) throw new Error("请选择 .json 文件。");
        const fileStat = await stat(filePath);
        if (!fileStat.isFile()) throw new Error("所选项目不是文件。");
        if (fileStat.size > MAX_FILE_BYTES)
          throw new Error("文件超过 20 MiB，请拆分后导入。");
        const buffer = await readFile(filePath);
        if (buffer.byteLength > MAX_FILE_BYTES)
          throw new Error("文件超过 20 MiB，请拆分后导入。");
        const content = new TextDecoder("utf-8", { fatal: true }).decode(
          buffer,
        );
        return { name, content, filePath: path.resolve(filePath) };
      } catch (error) {
        const message =
          error instanceof TypeError
            ? "文件不是有效的 UTF-8 编码。"
            : error.message || "无法读取文件。";
        return {
          name,
          content: "",
          filePath: path.resolve(filePath),
          error: message,
        };
      }
    }),
  );
}

async function openFiles() {
  if (!mainWindow || mainWindow.isDestroyed()) return [];
  const settings = await getWorkspaceStore().getSettings();
  const result = await dialog.showOpenDialog(mainWindow, {
    title: t("导入 JSON 文件"),
    properties: ["openFile", "multiSelections"],
    filters: [{ name: t("JSON 文件"), extensions: ["json"] }],
    defaultPath: settings.readDirectory,
  });
  if (result.canceled) return [];
  if (result.filePaths.length)
    await updateWorkspaceSettings({
      readDirectory: path.dirname(result.filePaths[0]),
    });
  return readFiles(result.filePaths);
}

async function deliverPaths(filePaths) {
  const paths = filePaths.filter(
    (filePath) =>
      typeof filePath === "string" &&
      path.isAbsolute(filePath) &&
      /\.json$/i.test(filePath),
  );
  if (!paths.length) return;
  if (!rendererReady || !mainWindow || mainWindow.isDestroyed()) {
    queuedPaths.push(...paths);
    return;
  }
  const files = await readFiles(paths);
  if (!mainWindow || mainWindow.isDestroyed() || !rendererReady) {
    queuedPaths.push(...paths);
    return;
  }
  mainWindow.webContents.send("json-craft:files-opened", files);
}

function sendMenuAction(action) {
  if (rendererReady && mainWindow && !mainWindow.isDestroyed())
    mainWindow.webContents.send("json-craft:menu-action", action);
}

function installMenu() {
  const template = [
    ...(process.platform === "darwin"
      ? [
          {
            label: "JSON Craft",
            submenu: [
              { role: "about", label: t("关于 JSON Craft") },
              { type: "separator" },
              { role: "services", label: t("服务") },
              { type: "separator" },
              { role: "hide", label: t("隐藏 JSON Craft") },
              { role: "hideOthers", label: t("隐藏其他") },
              { role: "unhide", label: t("显示全部") },
              { type: "separator" },
              { role: "quit", label: t("退出") },
            ],
          },
        ]
      : []),
    {
      label: t("文件"),
      submenu: [
        {
          label: t("新建输入"),
          accelerator: "CmdOrCtrl+N",
          click: () => sendMenuAction("new"),
        },
        {
          label: t("导入 JSON…"),
          accelerator: "CmdOrCtrl+O",
          click: async () => {
            try {
              const files = await openFiles();
              if (files.length && mainWindow && !mainWindow.isDestroyed())
                mainWindow.webContents.send("json-craft:files-opened", files);
            } catch (error) {
              dialog.showErrorBox(
                t("无法导入 JSON 文件"),
                localizeMessage(error.message),
              );
            }
          },
        },
        {
          label: t("导出当前 JSON…"),
          accelerator: "CmdOrCtrl+Shift+S",
          click: () => sendMenuAction("export"),
        },
        { type: "separator" },
        process.platform === "darwin"
          ? { role: "close", label: t("关闭窗口") }
          : { role: "quit", label: t("退出") },
      ],
    },
    {
      label: t("编辑"),
      submenu: [
        { role: "undo", label: t("撤销") },
        { role: "redo", label: t("重做") },
        { type: "separator" },
        { role: "cut", label: t("剪切") },
        { role: "copy", label: t("复制") },
        { role: "paste", label: t("粘贴") },
        { role: "selectAll", label: t("全选") },
      ],
    },
    {
      label: "JSON",
      submenu: [
        {
          label: t("格式化"),
          accelerator: "CmdOrCtrl+Enter",
          click: () => sendMenuAction("format"),
        },
      ],
    },
    {
      label: t("视图"),
      submenu: [
        { role: "resetZoom", label: t("实际大小") },
        { role: "zoomIn", label: t("放大") },
        { role: "zoomOut", label: t("缩小") },
        { type: "separator" },
        { role: "togglefullscreen", label: t("切换全屏") },
        ...(!app.isPackaged
          ? [
              { type: "separator" },
              { role: "toggleDevTools", label: t("开发者工具") },
            ]
          : []),
      ],
    },
    {
      role: "windowMenu",
      label: t("窗口"),
      submenu: [
        { role: "minimize", label: t("最小化") },
        { role: "zoom", label: t("缩放") },
        ...(process.platform === "darwin"
          ? [{ type: "separator" }, { role: "front", label: t("全部置于前台") }]
          : []),
      ],
    },
    ...(process.platform !== "darwin"
      ? [
          {
            label: t("帮助"),
            submenu: [{ role: "about", label: t("关于 JSON Craft") }],
          },
        ]
      : []),
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function installProtocol() {
  protocol.handle("app", async (request) => {
    try {
      const url = new URL(request.url);
      if (
        url.hostname !== "json-craft" ||
        !["GET", "HEAD"].includes(request.method)
      )
        return new Response("Not found", { status: 404 });
      const pathname = decodeURIComponent(url.pathname);
      if (pathname.includes("\0"))
        return new Response("Not found", { status: 404 });
      const target = path.resolve(
        distRoot,
        "." + (pathname === "/" ? "/index.html" : pathname),
      );
      const relative = path.relative(distRoot, target);
      if (relative.startsWith("..") || path.isAbsolute(relative))
        return new Response("Not found", { status: 404 });
      const response = await net.fetch(pathToFileURL(target).toString());
      const headers = new Headers(response.headers);
      headers.set("Content-Security-Policy", productionPolicy);
      headers.set("X-Content-Type-Options", "nosniff");
      return new Response(response.body, { status: response.status, headers });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  });
}

function createWindow() {
  rendererReady = false;
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 920,
    minWidth: 780,
    minHeight: 600,
    show: false,
    title: "JSON Craft",
    backgroundColor: windowBackgroundColor(),
    autoHideMenuBar: process.platform !== "darwin",
    icon: path.join(__dirname, "..", "resources", "icons", "icon.png"),
    ...(process.platform === "darwin"
      ? { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 16, y: 15 } }
      : {}),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      additionalArguments: [`--json-craft-system-locale=${systemLocale}`],
    },
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event) => event.preventDefault());
  mainWindow.webContents.on("will-redirect", (event) => event.preventDefault());
  mainWindow.webContents.on("render-process-gone", () => {
    rendererReady = false;
  });
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.on("closed", () => {
    mainWindow = null;
    rendererReady = false;
  });
  mainWindow.loadURL(isDev ? DEV_URL : APP_URL).catch((error) => {
    dialog.showErrorBox(
      t("JSON Craft 启动失败"),
      localizeMessage(error.message),
    );
    app.quit();
  });
}

handle("json-craft:open-files", openFiles);
handle("json-craft:import-dropped-files", async (paths) => {
  const settings = await getWorkspaceStore().getSettings();
  return fileImporter.importFiles(paths, settings.writeDirectory);
});
handle("json-craft:copy", async (text) => {
  validateText(text);
  await clipboard.writeText(text);
});
handle("json-craft:save", async (file) => {
  if (
    !file ||
    typeof file.name !== "string" ||
    typeof file.content !== "string"
  )
    throw new Error("导出参数无效。");
  validateText(file.content);
  if (!mainWindow || mainWindow.isDestroyed()) throw new Error("窗口已关闭。");
  const fileName =
    path
      .basename(file.name.replace(/[\\/]/g, "_"))
      .replace(/[<>:"|?*\u0000-\u001f]/g, "_")
      .slice(0, 180) || "untitled.json";
  const name =
    fileName.replace(/\.json$/i, "").replace(/\.formatted$/i, "") +
    ".formatted.json";
  const settings = await getWorkspaceStore().getSettings();
  const result = await dialog.showSaveDialog(mainWindow, {
    title: t("导出格式化 JSON"),
    defaultPath: path.join(settings.writeDirectory, name),
    filters: [{ name: t("JSON 文件"), extensions: ["json"] }],
    properties: ["createDirectory", "showOverwriteConfirmation"],
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  await writeFile(
    result.filePath,
    file.content.endsWith("\n") ? file.content : file.content + "\n",
    "utf8",
  );
  return { canceled: false, filePath: result.filePath };
});
for (const method of [
  "load",
  "read",
  "create",
  "update",
  "remove",
  "rename",
  "setActive",
])
  handle(`json-craft:workspace:${method}`, (...args) =>
    getWorkspaceStore()[method](...args),
  );
handle("json-craft:workspace:updateSettings", updateWorkspaceSettings);
handle("json-craft:workspace:chooseDirectory", async (kind) => {
  if (!["read", "write", "history"].includes(kind))
    throw new Error("目录类型无效。");
  const setting = {
    read: "readDirectory",
    write: "writeDirectory",
    history: "historyDirectory",
  }[kind];
  if (!setting || !mainWindow || mainWindow.isDestroyed())
    throw new Error("目录类型无效。");
  const settings = await getWorkspaceStore().getSettings();
  const result = await dialog.showOpenDialog(mainWindow, {
    title: t(
      {
        read: "选择默认读取目录",
        write: "选择文件存储目录",
        history: "选择历史存储目录",
      }[kind],
    ),
    defaultPath: settings[setting],
    properties: ["openDirectory", "createDirectory"],
  });
  if (result.canceled || !result.filePaths.length) return null;
  return updateWorkspaceSettings({ [setting]: result.filePaths[0] });
});
handle("json-craft:workspace:requestClose", async () => {
  await getWorkspaceStore().flush();
  setImmediate(() => {
    if (quitRequested) app.quit();
    else if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
  });
});
handle("json-craft:ready", async () => {
  rendererReady = true;
  const pending = queuedPaths;
  queuedPaths = [];
  return readFiles(pending);
});

if (!app.requestSingleInstanceLock()) app.quit();
else {
  if (isDev && process.connected) {
    const requestDevQuit = () => app.quit();
    process.on("message", (message) => {
      if (
        process.connected &&
        (message?.type === "json-craft:dev-restart" ||
          message?.type === "json-craft:dev-stop")
      )
        requestDevQuit();
    });
    process.once("disconnect", requestDevQuit);
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"])
      process.on(signal, requestDevQuit);
  }
  app.on("before-quit", () => {
    quitRequested = true;
  });
  app.on("open-file", (event, filePath) => {
    event.preventDefault();
    if (
      startupReady &&
      app.isReady() &&
      (!mainWindow || mainWindow.isDestroyed())
    )
      createWindow();
    void deliverPaths([filePath]);
  });
  app.on("second-instance", (_event, commandLine) => {
    if (startupReady && (!mainWindow || mainWindow.isDestroyed()))
      createWindow();
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
    void deliverPaths(commandLine);
  });
  app
    .whenReady()
    .then(async () => {
      systemLocale = resolveLanguage(
        app.getPreferredSystemLanguages()[0] || app.getLocale(),
      );
      nativeI18n.setLanguage("system", systemLocale);
      try {
        const settings = await getWorkspaceStore().getSettings();
        applyThemePreference(settings.theme);
        nativeI18n.setLanguage(settings.language ?? "system", systemLocale);
      } catch {
        applyThemePreference("system");
      }
      nativeTheme.on("updated", updateWindowBackground);
      installProtocol();
      session.defaultSession.setPermissionRequestHandler(
        (_webContents, _permission, callback) => callback(false),
      );
      session.defaultSession.setPermissionCheckHandler(() => false);
      if (!isDev)
        session.defaultSession.webRequest.onBeforeRequest(
          { urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] },
          (_details, callback) => callback({ cancel: true }),
        );
      queuedPaths.push(
        ...process.argv
          .slice(app.isPackaged ? 1 : 2)
          .filter((value) => path.isAbsolute(value) && /\.json$/i.test(value)),
      );
      installMenu();
      startupReady = true;
      createWindow();
      app.on("activate", () => {
        if (!BrowserWindow.getAllWindows().length) createWindow();
      });
    })
    .catch((error) => {
      dialog.showErrorBox(
        t("JSON Craft 启动失败"),
        localizeMessage(error.message),
      );
      app.quit();
    });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
