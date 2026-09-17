# Chat UI comparison

Reference: HopperCode's `web/src/components/working-time.tsx`, `conversation.tsx`, and `task-thread.tsx`, inspected in the local Hopper checkout on 2026-09-17.

This pass matches the elapsed “Working for…” / “Worked for…” clock, muted horizontal divider, compact bordered tool cards, status icons, input/output disclosure, automatic expansion of failed calls, and latest-three/earlier-call toggle. The existing message width, bubble styling, typography, spacing, and streaming cursor already follow the same pattern. Revcode's execution inspector remains accessible through the tool count in the reply header.

Elapsed time comes from saved run timestamps, including after reload. Visible run details load on demand; active visible runs refresh once per second. Expired or unavailable evidence is labeled. Interrupted and failed runs retain their actual status instead of looking completed.

Remaining differences require more than styling:

- Hopper retains separate assistant messages and thinking blocks. Revcode currently accumulates text deltas into one assistant message; faithful intermediate-message grouping needs a persisted message/event model.
- Hopper includes tool-result images in the conversation. Revcode exposes captures through its desktop and execution panels; a transcript gallery needs artifact mapping and availability handling.
- Hopper displays task targets, queued/steering messages, and inline questions. Revcode's current run model has no corresponding task/input lifecycle. These should follow actual host capabilities.

The elapsed clock counts up. Revcode's separate three-second desktop-control countdown remains in the desktop panel.
