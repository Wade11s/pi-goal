# Notices

pi-goal is licensed under the MIT License; see [LICENSE](LICENSE).

This package includes material adapted from the OpenAI Codex Goal extension,
which is licensed under the Apache License, Version 2.0. The full Apache
license text is in [LICENSE-APACHE-2.0.txt](LICENSE-APACHE-2.0.txt).

## Adapted material

- `src/goal.ts` — the Goal lifecycle model and the continuation, completion,
  blocked-audit, no-progress, and budget wrap-up prompt structure are adapted
  from `codex-rs/ext/goal/templates/goals/continuation.md`,
  `codex-rs/ext/goal/templates/goals/budget_limit.md`, and
  `codex-rs/ext/goal/templates/goals/objective_updated.md`.
- `src/store.ts` and `src/safety.ts` — the durable Goal state, the
  three-consecutive-Goal-turn blocked audit, and the conservative stopping
  behavior are informed by `codex-rs/ext/goal/src/runtime.rs` and
  `codex-rs/ext/goal/src/tool.rs`.

The Pi-specific behavior is reimplemented against Pi's public extension APIs;
no Codex Rust runtime code is copied or linked.

## Attribution

Copyright 2025 OpenAI

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.

Source: <https://github.com/openai/codex/tree/ab541fb9908198d95e9420668bb03f94dfe6324e/codex-rs/ext/goal>
