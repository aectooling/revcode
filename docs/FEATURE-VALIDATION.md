# Skills, run inspection, and C# validation

Implementation follows [PLAN.md](../PLAN.md). The native execution protocol is unchanged; run/document metadata and drafts belong to the host.

Automated verification includes `npm run check`, the existing production host/browser smoke and provider SDK browser suites, `npm run test:skills-runs`, and `npm run test:highlighting`. Browser suites use installed Edge. Focused tests cover migration, accepted-request deduplication, operation/tool correlation, interrupted runs, stable cursor search, protected retention, artifact storage, filesystem escapes/collisions, shared preference conflicts, snapshot reads, authoring inventory, trusted source provenance, recoverable interrupted file updates, and revision restoration.

Wide and narrow production UI scenarios exercise skill discovery/selection, disabled enable-and-select, failed submission recovery, offline authoring, multi-run source requests, message navigation, search, expansion and keyboard resizing. C# checks exercise exact copying, native selection/undo, composition guards, shortcuts in each editor, scroll synchronization and narrow layout overflow. Screenshots were inspected during implementation. The initial baseline passed 79 host tests; final test counts and bundle sizes are recorded in the PR.

No live Revit/provider modeling-and-skill-reuse workflow was performed. Native effects and real provider synthesis remain unverified by these mocked tests. The separate expanded browser acceptance matrix deferred in the plan remains deferred.
