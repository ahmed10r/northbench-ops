# KV QUOTA ARCHITECTURE (spec - next deep build)
Budgets (free tier, $0 law): 100k reads/day, 1k writes/day.
DONE: 5-min beats = ~3.4k reads/day (33x headroom). Patrol
early-return already skips most writes.
NEXT (single-blob context): hourly job writes one key "ctx:blob"
bundling kpi:latest + twins:directives + dropday + stats snapshot.
gatherContext reads ctx:blob FIRST, falls back to individual keys
(backward-safe). Result: ~700 reads/day = 140x headroom, writes
~500/day - then move agent:log accumulation to repo commits
(hourly batch, KV keeps only a 50-entry rolling tail).
LAW (in brain): every change budgets reads AND writes.
