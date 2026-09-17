# Thread history

Revcode follows [HopperCode's thread pattern](https://github.com/tsoumdoa/hoppercode/blob/main/docs/thread-history.md): sidebar conversations grouped by Today, Yesterday, This week, and Older, titles from the first eight words / 60 characters of the first message, an expandable archive, and a single active work slot. The existing composer, provider controls, tools, console, and run inspector retain their styling and behavior.

New thread creates a durable empty conversation. Each accepted message and run records its thread identity. The agent receives only that thread's transcript, and the run inspector and agent history search are scoped to it. Explicitly selected source runs can still be read across threads for skill authoring; requests referring to the recent run resolve within the current thread. The console and native recovery state remain host-wide.

Threads remain readable while another thread works. Jump back returns to the running thread. Native execution remains globally serialized, and selecting a different thread never changes an accepted operation's document target. The document label is descriptive; future work still targets the current Revit document as before.

Archive makes a conversation read-only without deleting its evidence. Unarchive restores the composer. A running thread cannot be archived. Threads are ordered by their last accepted message or completion time. Older transcript pages are available through Load earlier messages, including in archived threads.

The browser remembers selection in session storage; each browser tab can browse independently. Unsent text, image attachments and saved drawing scenes, selected skills, and skill-authoring intent survive thread switches in the same page, but are not persisted across reloads. Console drafts continue using their existing separate recovery mechanism.

Journal version 3 stores thread metadata alongside existing request deduplication records. Version 1/2 history is associated with the `legacy` thread without rewriting immutable archives or inventing run associations. Messages and run summaries without a thread ID resolve to that thread. Run-detail retention limits still apply; threads do not preserve expired evidence indefinitely.

Storage remains under the native instance's data directory. History survives browser refresh and host restart for that instance. Separate Revit instances retain independent histories; importing earlier instances and export are not implemented here. The three-dot button beside Archived opens the archive manager, which shows the exact journal and run-log paths with copy buttons. It remains available when the archive is empty.

Delete permanently removes a thread and its saved messages, run details, and attached images after confirmation. Running threads and runs protected by pending outcomes or active skill authoring cannot be deleted. Revit changes, saved skills, and unrelated manual execution history remain. Deleting the last thread creates a new empty conversation; other tabs fall back to a remaining thread and clear the deleted draft.

The archive manager can review up to 500 archived threads at a time, filtered by last activity older than a week, month, year, or all archived threads. The host rechecks the selected IDs, archive state, cutoff, and protected runs before deletion. Durable journal tombstones are saved before evidence removal so cleanup can finish after an interrupted deletion without restoring the deleted transcript.

Validation: `npm test`, `npm run typecheck`, `npm run build`, and `npm run test:threads` (production UI/host with a simulated agent; requires Edge). No live Revit model or provider is needed for the thread smoke test.
