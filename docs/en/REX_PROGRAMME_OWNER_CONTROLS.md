# REX programme: remote operation and Agent jobs

Connect to a running City with the City Owner credential. Web entries are under Advanced > Remote operation / Agent jobs; Android entries are under the header overflow > 远程执行 / Agent 作业. Ordinary members cannot dispatch, cancel or read private Owner tasks.

Both capabilities default to OFF. Explicit startup configuration is `CITY_REMOTE_OPERATION=1`, `CITY_REMOTE_OPERATION_ALLOWLIST`, `CITY_REMOTE_OPERATION_WORKSPACES` and `CITY_AGENT_JOB=1`. Allowlist and workspace lists use comma-separated values. Declare only needed programs and workspaces. Nodes must advertise the respective capability. A strict offline target waits rather than moving to another machine.

Remote operation: select a device; enter executable, a JSON string-array of arguments (for example `["--version"]`), working directory and purpose; review timeout/output bounds; type the executable name and dispatch. Web also accepts one argument per line. Arguments are an array and never pass through a shell. Actual state, stdout, stderr, exit code, timeout, truncation and receipt are displayed. Pending operations can be stopped.

Agent jobs: select a device whose Agent answers; enter title, instruction, purpose, optional `name=ref` inputs and deadline; type the title and dispatch. The remote Agent uses the existing claim/report protocol. City neither launches a model automatically nor verifies report content. Collect records the reader's acknowledgement, not acceptance. Expiration is a deadline projection; canonical task state stays intact.

Ask / Do accepts bounded deterministic Chinese/English requests such as 在 Alien 上运行 git 查看版本, `run git on Alien` and 让 Alien 的 Agent 检查项目测试. The first request creates only a draft. Open Review draft, supply missing fields and confirm on the control page. Ambiguous device names require selection; cwd, purpose and job title are never guessed. Explicit existing manual selections take precedence over text inference. Unmatched requests retain the prior tool-picker workflow. This is not arbitrary natural-language or LLM control.

Editing fields, changing credentials or losing connection requires renewed confirmation. An unchanged transport-failure retry reuses its request key; a fresh confirmed dispatch after success creates a new task. Read actual refusal codes for disallowed programs, workspaces, member permissions or disabled switches.

Upgrade Android with the same signing certificate. Another host's debug certificate cannot replace the existing package. A separate validation package can preserve the original application and its data; do not uninstall or clear the original to bypass signature checks.
