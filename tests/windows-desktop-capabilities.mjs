import { execFileSync } from "node:child_process"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

export function windowsDesktopCapabilities() {
  return JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-Command", `
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class GuilleUpgradeDesktop { [DllImport("user32.dll")] public static extern IntPtr GetShellWindow(); }'
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
ConvertTo-Json -Compress @{ elevated=$admin; shellAvailable=([GuilleUpgradeDesktop]::GetShellWindow() -ne [IntPtr]::Zero) }
`], { encoding: "utf8", windowsHide: true }))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(windowsDesktopCapabilities()))
}
