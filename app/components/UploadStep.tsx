"use client";

import { useEffect, useRef, useState } from "react";
import { FileText, Loader2, Sparkles, Upload } from "lucide-react";

import { Button } from "@/components/ui/button";

/**
 * Something to read while the model works.
 *
 * Writing a profile takes long enough that a single frozen line reads as a hang, so
 * the copy narrates the actual order of work — read, understand, write — and the
 * member can see it moving. The last line is deliberately open-ended: it's the one
 * left on screen if the request runs long, so it can't turn into a lie.
 */
const STEPS_FROM_FILE = [
  "Getting to know you…",
  "Picking out what matters…",
  "Writing it in your voice…",
  "Reading it back one more time…",
];

const STEPS_FROM_TEXT = [
  "Reading what you wrote…",
  "Finding the thread…",
  "Writing it in your voice…",
  "Reading it back one more time…",
];

const STEP_MS = 2600;

function useLoadingLine(loading: boolean, fileName: string | null) {
  const [step, setStep] = useState(0);

  useEffect(() => {
    if (!loading) {
      setStep(0);
      return;
    }
    const steps = fileName ? STEPS_FROM_FILE : STEPS_FROM_TEXT;
    // One extra tick for the filename, which leads when there is one.
    const last = steps.length - 1 + (fileName ? 1 : 0);
    const id = setInterval(
      () => setStep((s) => (s >= last ? last : s + 1)),
      STEP_MS,
    );
    return () => clearInterval(id);
  }, [loading, fileName]);

  if (fileName) {
    return step === 0 ? `Reading ${fileName}…` : STEPS_FROM_FILE[step - 1];
  }
  return STEPS_FROM_TEXT[step];
}

/**
 * Step one: get enough about the member to write their profile.
 *
 * The LinkedIn export is the primary path — it's one action, and it carries more
 * than anyone types into a box. The textarea is the fallback rather than a peer:
 * without it, a member who doesn't have the PDF to hand (it takes LinkedIn a few
 * minutes to email it) has no way through the door at all.
 */
export function UploadStep({
  loading,
  error,
  onSubmit,
}: {
  loading: boolean;
  error: string | null;
  onSubmit: (input: { text?: string; file?: File }) => void;
}) {
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const loadingLine = useLoadingLine(loading, fileName);

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || loading) return;
    setFileName(file.name);
    onSubmit({ file });
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-lg flex-col justify-center gap-8 px-4 py-12">
      <header className="space-y-3 text-center">
        <p className="text-muted-foreground flex items-center justify-center gap-1.5 text-sm">
          <Sparkles className="size-4" /> Dawn
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">Let&apos;s build your profile</h1>
        <p className="text-muted-foreground leading-relaxed">
          Upload your LinkedIn export and I&apos;ll write it for you, then ask you five
          quick questions. Takes about a minute.
        </p>
      </header>

      {loading ? (
        <div
          aria-live="polite"
          className="flex flex-col items-center gap-3 py-8"
        >
          <Loader2 className="text-muted-foreground size-5 animate-spin" />
          <p
            key={loadingLine}
            className="text-muted-foreground animate-in fade-in text-sm duration-700"
          >
            {loadingLine}
          </p>
        </div>
      ) : (
        <>
          <input
            ref={fileRef}
            type="file"
            accept="application/pdf"
            className="hidden"
            onChange={onFile}
          />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="border-input hover:bg-muted focus-visible:ring-ring/50 flex flex-col items-center gap-2 rounded-xl border border-dashed px-6 py-10 transition-colors focus-visible:ring-[3px] focus-visible:outline-none"
          >
            <Upload className="text-muted-foreground size-5" />
            <span className="font-medium">Upload your LinkedIn PDF</span>
            <span className="text-muted-foreground text-xs">
              LinkedIn → More → Save to PDF
            </span>
          </button>

          <div className="space-y-2">
            <p className="text-muted-foreground flex items-center gap-1.5 text-sm">
              <FileText className="size-3.5" /> Don&apos;t have it handy? Describe your work
              instead.
            </p>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={4}
              placeholder="What you're working on, where you've been, and where you want to go…"
              className="border-input focus-within:border-ring focus-within:ring-ring/50 w-full resize-none rounded-xl border p-3 text-sm outline-none focus-within:ring-[3px]"
            />
            <Button
              size="lg"
              variant={text.trim() ? "default" : "secondary"}
              className="w-full"
              disabled={!text.trim()}
              onClick={() => onSubmit({ text: text.trim() })}
            >
              Continue
            </Button>
          </div>
        </>
      )}

      {error && <p className="text-destructive text-center text-sm">{error}</p>}
    </main>
  );
}
