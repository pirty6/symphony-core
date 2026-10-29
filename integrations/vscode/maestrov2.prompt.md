---
description: "Run the Symphony maestro pipeline on a request: it picks the right pattern, debates the algorithm, asks for your go, then performs it deterministically with approvals in chat."
name: "maestrov2"
argument-hint: "What do you want done? e.g. find out why login fails on CI, then fix it"
agent: "maestro-v2"
---
Run the Symphony maestro on my request below, in this workspace. Relay every approval and stuck step to me and show the final result.

If I didn't write a request after `/maestrov2`, ask me what I want done before starting.
