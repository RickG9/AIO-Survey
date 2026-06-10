---
tags: [hub]
---

# 🗺️ Rotorua Research Vault

> [!important] Hypothesis
> **Tourism in Rotorua is (socially and environmentally) sustainable.**

This vault is the shared research brain for our Sacred Heart College geography trip. The AIO-Survey app (this repo) collects the raw data; this vault is where we read it, link it, and argue about what it means.

## Start here

- [[01 Hypothesis & Method]] — what we're testing and how
- [[Evidence Board]] — every interview point, sorted for/against the hypothesis *(auto-generated)*
- [[Survey Stats]] · [[EQA Scores]] — the numbers so far *(auto-generated)*
- [[Conclusion]] — where the final verdict takes shape

## The vault, room by room

| Folder | What lives there |
| --- | --- |
| `Interviews/` | One note per recorded interview — AI summary, stance-tagged key points, transcript. **Auto-generated**, but anything you write below the marker line survives re-imports. |
| `Attractions/` | One note per study site. Open one and check **Linked mentions** to see every interview conducted there. |
| `Field Days/` | Daily trip logs — create with the **Field Day** template. |
| `Analysis/` | Stats pages, the evidence board, and [[Conclusion]]. |
| `Sources/` | Readings and references — create with the **Source** template. |
| `Templates/` | Insert via `Ctrl+P` → *Templates: Insert template*. |
| `Attachments/` | Pasted images (photos!) land here automatically. |

## Pulling in fresh data

Anyone on the team can refresh the auto-generated notes from the app:

```
npm run vault:import
```

Needs `ADMIN_PASSWORD` (and `SURVEY_URL` if the app isn't on localhost) in the repo's `.env` — see the README. Re-running is safe: in every auto-generated note, whatever you wrote **below the marker line** is kept.

## Team workflow (free Obsidian sync, courtesy of git)

1. `git pull` before you start writing.
2. Write notes. Link generously — `[[Te Puia]]`, `[[Conclusion]]` — links are what make the graph view useful.
3. `git add notes` → `git commit` → `git push` when you stop.

— Rick, Adam, Callum & Taylor
