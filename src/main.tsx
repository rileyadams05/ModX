import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "./App";
import ProcessListWindow from "./ProcessListWindow";

const isProcessList = getCurrentWindow().label === "process-list";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {isProcessList ? <ProcessListWindow /> : <App />}
  </React.StrictMode>,
);
