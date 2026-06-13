import { startWebServer } from "./server.js";
startWebServer(Number(process.env.WEB_PORT || 8420));
