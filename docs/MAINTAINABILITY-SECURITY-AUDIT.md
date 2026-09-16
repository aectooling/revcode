# Maintainability and security audit

Scope: the local Node host, browser UI, Pi tool registration, skill file access,
native/desktop transport and deployment file handling. This is a source review
and automated validation pass, not a penetration test or a guarantee that all
dead code or vulnerabilities have been found.

## Trust model

Revcode is a single-user, full-trust desktop assistant. C# executes with Revit's
process privileges, and desktop tools can operate its UI. The compiler's policy
checks are not a sandbox. The relevant boundary is admission to those capabilities:
loopback binding, exact Host/Origin checks, independent browser/native credentials,
restricted authoring tools, and retained operation identities after uncertain work.

The reviewed code already disables Pi's built-in tools and automatic extensions,
checks the active tool inventory, omits raw HTML from Markdown rendering, and
keeps provider credentials out of browser persistence. Installer integrity checks
reject linked payloads. Skill writes check containment, filesystem links and
concurrent revisions. These controls should remain in place during refactoring.

## Fixed findings

| Finding | Change and regression coverage |
| --- | --- |
| Public asset serving checked the lexical path but followed junctions/symlinks outside the web directory. | Resolve and check the actual target before reading. A temporary junction regression previously returned private fixture bytes with HTTP 200; it now returns 403. This is defense in depth if a linked asset is introduced, not a claim that a remote client can create filesystem links. |
| Reusing an outstanding desktop request ID replaced its waiter and could send another command. | Reject it before writing to the helper; verify the original response still completes and only one request is sent. |
| A valid request ID such as `constructor` collided with an inherited object property. | Deduplicate against own properties only; verify initial admission, replay and conflicting content. |
| Null draft steps and custom-provider model entries threw during validation. | Reject them with HTTP 400 before persistence or SDK calls; preserve the previous draft. |
| Manual operation history omitted the native transaction status. | Show the recorded transaction receipt alongside execution status; browser smoke coverage verifies rollback evidence. |
| Browser smoke assertions referenced removed CSS hooks, old status text and an outdated tool list. | Use the current accessible headings and labels, explicitly open manual history, and retain query, rollback and cancellation assertions. |

## Maintainability changes

- Share the host operation and execution-mode types with the UI instead of
  maintaining parallel declarations.
- Use one length-checked, constant-time credential comparison helper for browser
  and native authentication, while retaining separate secrets.
- Remove the unused stored sign-in rejection callback and parse each request URL
  once.
- Enable `noUnusedLocals` and `noUnusedParameters` in both TypeScript projects so
  the normal typecheck catches future unused locals, imports and parameters.

Keep validation at both host and native boundaries: those checks protect different
entry points. Likewise, both npm and pnpm lockfiles have active consumers in CI and
release/development commands; neither is an orphan to delete.

## Validation and limits

Validation covers TypeScript checks and production builds, host/unit regressions,
native tests, deployment tests, .NET 8/10 transport smoke tests, desktop helper
build, host lifecycle, desktop workflow tests, and the browser smoke flow using
simulated Revit and provider responses. The browser test does not execute C# in a
real Revit model or validate actual desktop input against Revit.

The pnpm advisory audit reported no known vulnerabilities. NuGet advisory checks
for the test, desktop, transport and Revit projects also reported none for the
resolved configurations checked. This is a point-in-time advisory result, not a
proof of dependency safety. The web build still reports its existing large-chunk
warning.

Local processes running as the same user, arbitrary trusted snippets, malicious
provider/model output, and concurrent tampering with installed files remain
outside a sandbox guarantee. Realpath checks do not make a writable installation
race-proof. No live Revit project was edited or interactive desktop control used
for this audit.
