import { Button } from "./ui/button";

const SUGGESTIONS = [
  "List the levels and their elevations.",
  "Tell me about the selected elements.",
];

export function Welcome({
  connected,
  onSuggestion,
}: {
  connected: boolean;
  onSuggestion(text: string): void;
}) {
  return (
    <section
      className="mx-auto mt-[max(14vh,2rem)] w-full max-w-[560px] animate-slide-up px-4"
      aria-labelledby="welcome-title"
    >
      <h2
        id="welcome-title"
        className="text-[22px] font-semibold leading-tight tracking-[-.02em]"
      >
        <span className="text-accent-hover">Rev</span>code
      </h2>
      <p className="mt-1.5 text-[13px] text-muted">
        {connected
          ? "Ask the assistant to inspect your model or make a change. Every C# operation appears in the execution history."
          : "Connecting to the local Revcode host…"}
      </p>
      <div
        className="mt-5 flex flex-wrap gap-1.5"
        role="group"
        aria-label="Prompt suggestions"
      >
        {SUGGESTIONS.map((text) => (
          <Button
            key={text}
            size="sm"
            variant="secondary"
            disabled={!connected}
            onClick={() => onSuggestion(text)}
          >
            {text}
          </Button>
        ))}
      </div>
    </section>
  );
}
