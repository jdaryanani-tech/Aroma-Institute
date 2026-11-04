---
name: Playwright WebKit on Replit
description: WebKit browser test execution constraints in this Replit Nix environment.
---

Keep the WebKit project in Playwright coverage, but do not report it as locally verified unless the browser actually launches. Playwright's Linux WebKit bundle expects a set of Ubuntu-compatible media and graphics libraries; installing the closest Nix packages does not satisfy its dependency check in this environment.

**Why:** The WebKit browser repeatedly failed to launch here due missing or ABI-mismatched system libraries, while Chromium tests ran successfully.

**How to apply:** Run the WebKit project on a compatible Ubuntu CI runner with Playwright browser dependencies installed. If Playwright's managed Chromium is missing locally, use `/repl/tools/bin/chromium` as the executable path. Report local Chromium results separately from WebKit results.
