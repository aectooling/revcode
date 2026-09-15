import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { ConsolePanel, type Mode } from "../src/components/console-panel";
import { MessageMarkdown } from "../src/components/message-markdown";
import { HighlightedCode } from "../src/components/highlighted-code";
import { TooltipProvider } from "../src/components/ui/tooltip";
import "../src/styles/globals.css";

function Fixture() {
  const [code, setCode] = useState('var text = "<script>unsafe</script>";\nreturn text;');
  const [mode, setMode] = useState<Mode>("query");
  const [steps, setSteps] = useState([{ name: "Step 1", code: "return null;" }]);
  const [verify, setVerify] = useState("return true;");
  const [runs, setRuns] = useState(0);
  return <TooltipProvider><main className="mx-auto max-w-2xl p-4"><output aria-label="Run count">{runs}</output>
    <ConsolePanel code={code} onCodeChange={setCode} mode={mode} onModeChange={setMode} steps={steps} onStepsChange={setSteps} verify={verify} onVerifyChange={setVerify}
      documentToken="" onDocumentTokenChange={() => {}} documents={[]} busy={false} pending={false} canRun docReadOnly={false} onRun={() => setRuns(n => n + 1)} onCancel={() => {}} />
    <HighlightedCode code={code} label="Historical source" highlightLine={2} />
    <MessageMarkdown text={'```cs\nreturn "<img src=x onerror=alert(1)>";\n```\n\n```python\nprint("plain")\n```\n\n```\nplain\n```'} />
  </main></TooltipProvider>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
