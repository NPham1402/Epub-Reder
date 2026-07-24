#!/usr/bin/env bash
# Idempotent provision + deploy for Cloudflare Workers.
# Requires: CLOUDFLARE_API_TOKEN (a token allowed to manage Workers, R2, D1).
# Optional: CLOUDFLARE_ACCOUNT_ID, ACCESS_PASSCODE, SESSION_SECRET.
set -euo pipefail

D1_NAME="epub_reader_db"
R2_NAME="epub-reader-books"
D1_PLACEHOLDER="REPLACE_WITH_YOUR_D1_DATABASE_ID"

: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN is required}"

wr() { npx --no-install wrangler "$@"; }

# --- R2 bucket -------------------------------------------------------------
echo "==> Ensuring R2 bucket '$R2_NAME'"
if ! wr r2 bucket create "$R2_NAME" 2>/tmp/r2.err; then
  if grep -qiE "already|exists|10004" /tmp/r2.err; then
    echo "    bucket already exists — ok"
  else
    echo "    R2 provisioning failed:"; cat /tmp/r2.err; exit 1
  fi
fi

# --- D1 database -----------------------------------------------------------
echo "==> Ensuring D1 database '$D1_NAME'"
get_db_id() {
  wr d1 list --json 2>/dev/null | node -e '
    const name = process.argv[1];
    let d = "";
    process.stdin.on("data", (c) => (d += c)).on("end", () => {
      try {
        const a = JSON.parse(d);
        const m = (Array.isArray(a) ? a : []).find((x) => x && x.name === name);
        process.stdout.write(m ? (m.uuid || m.id || "") : "");
      } catch { process.stdout.write(""); }
    });' "$D1_NAME"
}
DB_ID="$(get_db_id || true)"
if [ -z "${DB_ID:-}" ] || [ "$DB_ID" = "null" ]; then
  echo "    creating database..."
  wr d1 create "$D1_NAME" >/dev/null
  DB_ID="$(get_db_id || true)"
fi
if [ -z "${DB_ID:-}" ] || [ "$DB_ID" = "null" ]; then
  echo "    ERROR: could not resolve D1 database id"; exit 1
fi
echo "    D1 id: $DB_ID"

# --- Inject the id into the (checked-out) config ---------------------------
echo "==> Injecting D1 id into wrangler.jsonc"
sed -i "s|$D1_PLACEHOLDER|$DB_ID|g" wrangler.jsonc
grep -q "$DB_ID" wrangler.jsonc || {
  echo "    ERROR: placeholder '$D1_PLACEHOLDER' not found in wrangler.jsonc"; exit 1;
}

# --- Migrations ------------------------------------------------------------
echo "==> Applying D1 migrations (remote)"
wr d1 migrations apply "$D1_NAME" --remote

# --- Deploy ----------------------------------------------------------------
echo "==> Deploying Worker"
wr deploy

# --- Secrets (set after the Worker exists) ---------------------------------
echo "==> Syncing secrets"
if [ -n "${ACCESS_PASSCODE:-}" ]; then
  printf '%s' "$ACCESS_PASSCODE" | wr secret put ACCESS_PASSCODE
  echo "    ACCESS_PASSCODE set"
else
  echo "    WARNING: ACCESS_PASSCODE empty — the reader will reject every login"
fi
if [ -n "${SESSION_SECRET:-}" ]; then
  printf '%s' "$SESSION_SECRET" | wr secret put SESSION_SECRET
  echo "    SESSION_SECRET set"
else
  echo "    WARNING: SESSION_SECRET empty — sessions cannot be signed"
fi

echo "==> Done."
