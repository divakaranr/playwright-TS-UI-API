# Test data

| Folder                      | Purpose                                                                                                                   |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `common/`                   | Default data-driven rules and scenarios used by every environment.                                                        |
| `<env>/` (`qa/`, `uat/`, …) | Optional per-environment overrides. A file here **replaces** the file of the same name in `common/` for that environment. |
| `generated/`                | Output of `npm run data:generate` (git-ignored).                                                                          |

Rules:

- Files are loaded with `TestDataService.load(name, schema)` and validated with Zod – an invalid file fails the test immediately.
- Static JSON holds **rules and scenarios** (invalid payloads, boundaries, option lists). Records a test creates or mutates are **always generated** with `UserFactory` / `UserBuilder` and cleaned up through the `cleanup` fixture.
- Never store credentials or real personal data here.
