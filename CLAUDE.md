# Tony

Tony is a personal AI agent (Telegram bot + installable web app) for one user.
The full product spec is [docs/SPEC.md](docs/SPEC.md). Read it before changing anything.

## How to work here

- Build **one phase at a time** (spec: "Build phases"). Run it, show the result,
  then **wait for the owner's approval** before starting the next phase.
- Progress is tracked in [README.md](README.md) under "Phases".
- Supabase has row level security on for new tables and automatic API grants
  off: every migration must add the grants (and any policies) it needs.
- Keys live in environment variables only (`.env.example` lists them). Never
  commit a real value, and never ask the owner to paste one into chat.
- Button taps (Start, Done, Snooze, Skip, Move) must call code directly and
  never go through the AI model.

## Next.js

This version of Next.js has breaking changes from older releases. Read the
relevant guide in `node_modules/next/dist/docs/` before writing Next code.
