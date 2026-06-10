# AIO-Survey
This is an all-in-one solution for our geography trip that aims to prove a hypnosis: Tourism in Rotorua is (socially / environmentally) sustainable.  

## Research vault (Obsidian)

`notes/` is an Obsidian vault — the team's shared research notebook for the hypothesis. It's plain markdown versioned with git: `git pull` before writing, `git push` when you stop. No Obsidian Sync subscription needed.

**Open it:** install [Obsidian](https://obsidian.md) (free) → *Open folder as vault* → pick the `notes/` folder of this repo. Start at `00 Home`.

**Pull data into it** (needs Node 18+):

```
npm run vault:import
```

Set `ADMIN_PASSWORD` — and `SURVEY_URL` if the app isn't on `http://localhost:3000`, e.g. the deployed URL — in `.env` at the repo root (already gitignored):

```
ADMIN_PASSWORD=...
SURVEY_URL=https://your-deployment.example.com
```

The import writes one note per interview (AI summary, stance-tagged key points, transcript) plus `Evidence Board`, `Survey Stats` and `EQA Scores` in `Analysis/`. Re-running is safe: in every auto-generated note, anything below the `%% ── your notes below this line are kept on re-import ── %%` marker is preserved.
