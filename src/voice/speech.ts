interface SpeechRecognitionAlternativeLike {
  transcript: string;
}
interface SpeechRecognitionResultLike {
  readonly length: number;
  item(index: number): SpeechRecognitionAlternativeLike;
  [index: number]: SpeechRecognitionAlternativeLike;
}
interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: {
    readonly length: number;
    [index: number]: SpeechRecognitionResultLike & { isFinal: boolean };
  };
}
interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function recognitionCtor(): SpeechRecognitionCtor | null {
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function voiceSupported(): boolean {
  return recognitionCtor() !== null;
}

/**
 * Continuous listener that restarts itself: browsers end recognition sessions
 * on their own schedule, and a runner can't tap the screen to resume.
 */
export class VoiceListener {
  private recognition: SpeechRecognitionLike | null = null;
  private wanted = false;

  constructor(
    private readonly onTranscript: (transcript: string) => void,
    private readonly onError: (message: string) => void,
  ) {}

  start(): boolean {
    const Ctor = recognitionCtor();
    if (!Ctor) {
      this.onError('Voice recognition is not available in this browser.');
      return false;
    }
    this.wanted = true;
    const recognition = new Ctor();
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.lang = 'en-US';
    recognition.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        if (result?.isFinal) this.onTranscript(result[0]?.transcript ?? '');
      }
    };
    recognition.onerror = (event) => {
      if (event.error !== 'no-speech') this.onError(`Voice error: ${event.error}`);
    };
    recognition.onend = () => {
      if (this.wanted) recognition.start();
    };
    recognition.start();
    this.recognition = recognition;
    return true;
  }

  stop(): void {
    this.wanted = false;
    this.recognition?.stop();
    this.recognition = null;
  }
}

/** Audio-first feedback: you are not looking at the screen mid-lap. */
export function speak(text: string): void {
  if (!('speechSynthesis' in window)) return;
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = 1.05;
  window.speechSynthesis.speak(utterance);
}
