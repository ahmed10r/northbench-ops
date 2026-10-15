# northbench-ops

The NORTHBENCH operations repository — the business's night crew.

What lives here:
- `tools/nightly.py` — the nightly health run: courier heartbeat, vault
  integrity, shop product count, KPI snapshot into `KPI.md`.
- `.github/workflows/nightly.yml` — runs it every night at 03:15 UTC and
  commits the fresh KPI back to this repo.
- Records of the operation (text only — never product files, never
  secrets in files).

Secrets (in GitHub's encrypted store, never in the repo):
- `VAULT_KEY` — access to the nb-vault archive checks.
- `GUMROAD_TOKEN` — read-only shop health checks.

This repo is PRIVATE on purpose. Paid products and credentials never
enter it. Made at the Northbench.
