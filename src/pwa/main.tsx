import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import "@vscode/codicons/dist/codicon.css"
import "./pwa.css"
import { App } from "./App"

if ("serviceWorker" in navigator && window.isSecureContext) {
  void navigator.serviceWorker.register("/sw.js").catch(() => undefined)
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
