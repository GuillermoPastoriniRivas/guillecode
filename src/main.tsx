import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import "@vscode/codicons/dist/codicon.css"
import "@xterm/xterm/css/xterm.css"
import "highlight.js/styles/github-dark.css"
import "./styles/base.css"
import "./styles/workbench.css"
import "./styles/editor.css"
import "./styles/views.css"
import "./styles/agent.css"
import "./styles/docs.css"
import App from "./App"

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
