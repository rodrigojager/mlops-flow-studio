const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("mlopsDesktop", {
  apiToken: process.env.MLOPS_STUDIO_API_TOKEN,
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
});
