import { useVoiceRecorder, recordingSupported } from "../lib/recorder"
import { transcribe } from "./api"

export { recordingSupported }
export type { RecorderState } from "../lib/recorder"

export function useRecorder(onText: (text: string) => void, onError: (message: string) => void) {
  return useVoiceRecorder({
    transcribe,
    onText,
    onError,
    unsupportedHint: "Para grabar audio abrí GuilleCode desde el link HTTPS (el que termina en .ts.net).",
  })
}
