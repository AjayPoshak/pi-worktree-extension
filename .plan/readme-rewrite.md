# README rewrite plan

## Goal

Turn the README from an implementation-oriented reference into a product page for Pi users deciding whether to install the extension.

The README should answer, in order:

1. What is this?
2. Why do I need it instead of branches or manual Git worktrees?
3. What does the workflow look like?
4. How do I install and try it?
5. What commands and safety guarantees should I know?

## Reference

Use [Worktrunk's README](https://github.com/max-sixty/worktrunk) as the quality bar for information hierarchy and presentation, without copying its wording or claiming features this extension does not have.

Patterns to adopt:

- a one-sentence product definition near the top;
- a concrete explanation of why AI-agent workflows benefit from worktrees;
- a short comparison between the product workflow and the manual workflow;
- installation before exhaustive reference material;
- a realistic quick start centered on the core commands;
- concise feature and safety summaries;
- technical details pushed below the pitch and onboarding flow.

## Proposed structure

1. Product name, badges, and one-line value proposition
2. Short product definition
3. Context: why worktrees for Pi
4. Pi Worktree versus manual Git/Pi workflow
5. Installation
   - npm package
   - optional shell dispatcher required for `pi -w`
   - source installation in a collapsed section
6. Quick start
7. Core command reference
8. How worktrees and session continuity behave
9. Configuration
10. Safety and limitations
11. Uninstall, development, and license

## Factual guardrails

- Do not imply that worktrees are security sandboxes.
- Do not imply ignored files or dependencies are copied.
- State that new creation requires a clean source checkout.
- State that cleanup is explicit, branches are retained, and force removal is unavailable.
- Explain that `pi -w` needs a shell dispatcher because extensions load after Pi selects its initial cwd.
- Use only commands implemented by this repository.
- Do not invent screenshots, output, CI, documentation sites, or integrations.

## Validation

- Check all shell snippets against the installed package layout.
- Check command names and behavior against the implementation.
- Run `git diff --check` and `npm pack --dry-run`.
- Commit this plan with the README rewrite.
