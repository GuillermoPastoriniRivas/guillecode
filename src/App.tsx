import { useEffect, useState } from "react"
import { Workbench } from "./workbench/Workbench"
import { BubbleApp } from "./workbench/Bubble"
import { isBubbleWindow, windowBubbleInfo } from "./lib/windows"

if (isBubbleWindow()) document.documentElement.classList.add("is-bubble")

function Bubble() {
  const [info, setInfo] = useState<{ session: string; origin: string } | null>(null)
  useEffect(() => {
    void windowBubbleInfo().then((value) => setInfo(value ?? null))
  }, [])
  if (!info) return null
  return <BubbleApp sessionId={info.session} origin={info.origin} />
}

export default function App() {
  return isBubbleWindow() ? <Bubble /> : <Workbench />
}
