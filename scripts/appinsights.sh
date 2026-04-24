#!/usr/bin/env bash
# CatalystOps — App Insights Analytics Dashboard
# Requires: APP_INSIGHTS_APPID, APP_INSIGHTS_TOKEN
set -euo pipefail

if [[ -z "${APP_INSIGHTS_APPID:-}" || -z "${APP_INSIGHTS_TOKEN:-}" ]]; then
  echo "❌  Set APP_INSIGHTS_APPID and APP_INSIGHTS_TOKEN first."
  exit 1
fi

python3 - "$APP_INSIGHTS_APPID" "$APP_INSIGHTS_TOKEN" << 'PYEOF'
import sys, json, re, subprocess
from datetime import datetime, timedelta
from concurrent.futures import ThreadPoolExecutor, as_completed

APPID, TOKEN = sys.argv[1], sys.argv[2]
IST = timedelta(hours=5, minutes=30)

# ── Your machine ID — excluded from all queries ───────────────────────────────
MY_MID = "3e63182c9209c8acf6b23e7e16faffb8b9cf5a76e22f1c16cee453ab32c2ffe1"

# ── Combined unique key: machineId for VS Code, userId for Cursor/Windsurf etc.
# Use UK (unique key) everywhere instead of raw MID.
# Exclusion filters out your machine only (mid: prefix).
UK = f'extend _mid=tostring(customDimensions["common.vscodemachineid"]) | extend UK=iff(isnotempty(_mid) and _mid != "", strcat("mid:", _mid), strcat("uid:", user_Id))'
EXCL = f'| where UK != "mid:{MY_MID}"'

def q(kql):
    r = subprocess.run(
        ["curl", "-s", "-X", "POST",
         f"https://api.applicationinsights.io/v1/apps/{APPID}/query",
         "-H", f"x-api-key: {TOKEN}",
         "-H", "Content-Type: application/json",
         "-d", json.dumps({"query": kql})],
        capture_output=True, text=True
    )
    data = json.loads(r.stdout)
    if "error" in data:
        raise RuntimeError(data["error"]["message"])
    return data["tables"][0]["rows"]

def parse_ts(ts):
    ts = ts.replace("Z", "+00:00")
    ts = re.sub(r"(\.\d+)", lambda m: m.group(1).ljust(7, "0")[:7], ts)
    return datetime.fromisoformat(ts)

def ist(ts):   return parse_ts(ts) + IST
def istfmt(ts, fmt="%d %b %H:%M"): return ist(ts).strftime(fmt)
def bar(n, mx, width=30):
    filled = int(n / mx * width) if mx else 0
    return "█" * filled + "░" * (width - filled)
def pct(a, b): return f"{100*a//b}%" if b else "—"
def section(title): print(f"\n{'═'*60}\n  {title}\n{'═'*60}")

queries = {

  "dau_today": f"""
    customEvents | {UK} {EXCL}
    | where timestamp >= startofday(now())
    | summarize dcount(UK)
  """,

  "dau_yesterday": f"""
    customEvents | {UK} {EXCL}
    | where timestamp >= startofday(ago(1d)) and timestamp < startofday(now())
    | summarize dcount(UK)
  """,

  "new_today_detail": f"""
    let first_seen = customEvents | {UK} {EXCL}
      | summarize firstSeen=min(timestamp), country=any(client_CountryOrRegion),
                  city=any(client_City) by UK;
    first_seen
    | where firstSeen >= startofday(now())
    | project UK, firstSeen, country, city
    | order by firstSeen asc
  """,

  "new_yesterday_detail": f"""
    let first_seen = customEvents | {UK} {EXCL}
      | summarize firstSeen=min(timestamp), country=any(client_CountryOrRegion),
                  city=any(client_City) by UK;
    let new_yest = first_seen
      | where firstSeen >= startofday(ago(1d)) and firstSeen < startofday(now());
    let came_back = customEvents | {UK} {EXCL}
      | where timestamp >= startofday(now())
      | summarize by UK;
    new_yest
    | extend cameBack = UK in (came_back)
    | project UK, firstSeen, country, city, cameBack
    | order by firstSeen asc
  """,

  "install_trend_30d": f"""
    let first_seen = customEvents | {UK} {EXCL}
      | summarize firstSeen=min(timestamp) by UK;
    first_seen
    | where firstSeen >= ago(30d)
    | summarize newInstalls=count() by day=startofday(firstSeen)
    | order by day asc
  """,

  "wau_mau": f"""
    customEvents | {UK} {EXCL}
    | summarize
        wau=dcountif(UK, timestamp >= ago(7d)),
        mau=dcountif(UK, timestamp >= ago(30d))
  """,

  "total_alltime": f"""
    customEvents | {UK} {EXCL}
    | summarize
        total=dcount(UK),
        withMachineId=dcountif(UK, UK startswith "mid:"),
        cursorEtc=dcountif(UK, UK startswith "uid:")
  """,

  "country_dist": f"""
    customEvents | {UK} {EXCL}
    | where timestamp >= ago(30d)
    | summarize users=dcount(UK) by country=client_CountryOrRegion
    | top 10 by users desc
  """,

  "version_dist": f"""
    customEvents | {UK} {EXCL}
    | where timestamp >= ago(30d)
    | extend ver=tostring(customDimensions["common.extversion"])
    | summarize users=dcount(UK) by ver
    | order by users desc
  """,

  "os_dist": f"""
    customEvents | {UK} {EXCL}
    | where timestamp >= ago(30d)
    | extend os=tostring(customDimensions["common.os"])
    | summarize users=dcount(UK) by os
    | order by users desc
  """,

  "feature_usage": f"""
    customEvents | {UK} {EXCL}
    | where name in (
        "CatalystOps.catalystops/local_analysis/complete",
        "CatalystOps.catalystops/local_analysis/notebook_complete",
        "CatalystOps.catalystops/command/analyze_cost",
        "CatalystOps.catalystops/dry_run/success",
        "CatalystOps.catalystops/dry_run/failed",
        "CatalystOps.catalystops/cluster/ssh_connect",
        "CatalystOps.catalystops/job_run/analyzed",
        "CatalystOps.catalystops/explain_plan/updated",
        "CatalystOps.catalystops/billing/viewed"
      )
    | summarize
        totalEvents=count(),
        uniqueUsers=dcount(UK),
        last7d=dcountif(UK, timestamp >= ago(7d)),
        last30d=dcountif(UK, timestamp >= ago(30d)),
        lastSeen=max(timestamp)
      by eventName=replace_string(name, "CatalystOps.catalystops/", "")
    | order by totalEvents desc
  """,

  "hour_heatmap": f"""
    customEvents | {UK} {EXCL}
    | where timestamp >= ago(30d)
    | extend hr=hourofday(datetime_add('minute', 330, timestamp))
    | summarize events=count() by hr
    | order by hr asc
  """,

  "dow_pattern": f"""
    customEvents | {UK} {EXCL}
    | where timestamp >= ago(30d)
    | extend dow=toint(dayofweek(datetime_add('minute', 330, timestamp)) / 1d)
    | summarize events=count() by dow
    | order by dow asc
  """,

  "error_trend": f"""
    customEvents | {UK} {EXCL}
    | where timestamp >= ago(14d)
    | extend isError=(name contains "fail" or name contains "error")
    | summarize dau=dcount(UK), errors=countif(isError) by day=startofday(timestamp)
    | order by day asc
  """,

  "d1_retention_trend": f"""
    let first_seen = customEvents | {UK} {EXCL}
      | summarize firstSeen=min(timestamp) by UK;
    first_seen
    | where firstSeen >= ago(14d) and firstSeen < startofday(now())
    | extend cohortDay=startofday(firstSeen)
    | join kind=leftouter (
        customEvents | {UK} {EXCL}
        | summarize by UK, actDay=startofday(timestamp)
      ) on UK
    | summarize
        cohortSize=dcount(UK),
        retained=dcountif(UK, actDay == cohortDay + 1d)
      by cohortDay
    | extend d1_pct = round(100.0 * retained / cohortSize, 1)
    | order by cohortDay asc
  """,

  "churn_trend": f"""
    let active = customEvents | {UK} {EXCL}
      | summarize lastActive=max(timestamp) by UK;
    active
    | extend weekBucket=startofweek(lastActive)
    | where weekBucket >= ago(8w)
    | summarize churnedUsers=countif(lastActive < ago(14d)) by weekBucket
    | order by weekBucket asc
  """,

  "funnel": f"""
    let uks = (event: string) {{
      customEvents | {UK} {EXCL}
      | where name == event
      | summarize by UK
    }};
    let install  = toscalar(uks("CatalystOps.catalystops/extension/activated") | count);
    let analysis = toscalar(uks("CatalystOps.catalystops/local_analysis/complete") | count);
    let cost     = toscalar(uks("CatalystOps.catalystops/command/analyze_cost") | count);
    let dryrun   = toscalar(uks("CatalystOps.catalystops/dry_run/success") | count);
    print install, analysis, cost, dryrun
  """,

  "mcp_usage": f"""
    customEvents | {UK} {EXCL}
    | where name in (
        "CatalystOps.catalystops/job_run/analyzed",
        "CatalystOps.catalystops/explain_plan/updated",
        "CatalystOps.catalystops/job_run/cost_fetched"
      )
    | summarize events=count(), users=dcount(UK),
                last7d=dcountif(UK, timestamp>=ago(7d)), lastSeen=max(timestamp) by name
    | order by events desc
  """,
}

print("⏳  Fetching data from App Insights (parallel)…")
results = {}
with ThreadPoolExecutor(max_workers=10) as pool:
    futures = {pool.submit(q, kql): key for key, kql in queries.items()}
    for fut in as_completed(futures):
        key = futures[fut]
        try:    results[key] = fut.result()
        except Exception as e: results[key] = f"ERROR: {e}"

# ── ALL-TIME TOTALS ───────────────────────────────────────────────────────────
section("👥  ALL-TIME UNIQUE USERS")
row = results["total_alltime"][0]
total, with_mid, cursor_etc = row
print(f"  Total          : {total}")
print(f"  VS Code        : {with_mid}  (machineId)")
print(f"  Cursor/etc.    : {cursor_etc}  (userId fallback — no machineId)")

# ── DAU ───────────────────────────────────────────────────────────────────────
section("📊  DAILY ACTIVE USERS")
dau_today     = results["dau_today"][0][0]
dau_yesterday = results["dau_yesterday"][0][0]
wau = results["wau_mau"][0][0]
mau = results["wau_mau"][0][1]
print(f"  Today so far : {dau_today}")
print(f"  Yesterday    : {dau_yesterday}")
print(f"  WAU (7d)     : {wau}")
print(f"  MAU (30d)    : {mau}")
if isinstance(mau, int) and mau:
    print(f"  Stickiness   : DAU/MAU = {pct(dau_yesterday, mau)}")

# ── NEW INSTALLS TODAY ────────────────────────────────────────────────────────
section("🆕  NEW INSTALLS — TODAY")
rows = results["new_today_detail"]
if isinstance(rows, list) and rows:
    print(f"  {len(rows)} new user(s)\n")
    print(f"  {'UK[:12]':<14}  {'Country':<22}  {'City':<20}  Time (IST)")
    print("  " + "─"*70)
    for uk, ts, country, city in rows:
        label = uk[:12]
        print(f"  {label:<14}  {(country or '?'):<22}  {(city or '?'):<20}  {istfmt(ts)}")
else:
    print("  No new installs yet today.")

# ── NEW INSTALLS YESTERDAY ────────────────────────────────────────────────────
section("🆕  NEW INSTALLS — YESTERDAY")
rows = results["new_yesterday_detail"]
if isinstance(rows, list) and rows:
    print(f"  {len(rows)} new user(s)\n")
    print(f"  {'UK[:12]':<14}  {'Country':<22}  {'City':<20}  {'Time (IST)':<16}  Came back?")
    print("  " + "─"*78)
    for uk, ts, country, city, came_back in rows:
        cb = "✅ yes" if came_back else "❌ no"
        print(f"  {uk[:12]:<14}  {(country or '?'):<22}  {(city or '?'):<20}  {istfmt(ts):<16}  {cb}")
else:
    print("  No new installs yesterday.")

# ── 30-DAY TREND ──────────────────────────────────────────────────────────────
section("📈  30-DAY NEW INSTALL TREND")
rows = results["install_trend_30d"]
if isinstance(rows, list) and rows:
    mx = max(r[1] for r in rows)
    for day, cnt in rows:
        label = ist(day).strftime("%d %b")
        print(f"  {label}  {bar(cnt, mx, 25)}  {cnt}")

# ── COUNTRY ───────────────────────────────────────────────────────────────────
section("🌍  COUNTRY DISTRIBUTION (last 30d)")
rows = results["country_dist"]
if isinstance(rows, list) and rows:
    mx = rows[0][1]
    for country, users in rows:
        print(f"  {(country or 'Unknown'):<25}  {bar(users, mx, 20)}  {users}")

# ── VERSION ───────────────────────────────────────────────────────────────────
section("📦  VERSION DISTRIBUTION (last 30d)")
rows = results["version_dist"]
if isinstance(rows, list) and rows:
    mx = rows[0][1]
    for ver, users in rows:
        print(f"  {(ver or '?'):<30}  {bar(users, mx, 20)}  {users}")

# ── OS ────────────────────────────────────────────────────────────────────────
section("💻  OS DISTRIBUTION (last 30d)")
rows = results["os_dist"]
if isinstance(rows, list) and rows:
    mx = rows[0][1]
    for os_, users in rows:
        print(f"  {(os_ or 'Unknown'):<20}  {bar(users, mx, 20)}  {users}")

# ── FEATURE USAGE ─────────────────────────────────────────────────────────────
section("🔧  FEATURE USAGE")
rows = results["feature_usage"]
if isinstance(rows, list) and rows:
    print(f"  {'Feature':<40}  {'Events':>7}  {'AllTime':>8}  {'7d':>4}  {'30d':>5}  Last seen")
    print("  " + "─"*85)
    for event, total, uniq, l7, l30, last in rows:
        print(f"  {event:<40}  {total:>7}  {uniq:>8}  {l7:>4}  {l30:>5}  {istfmt(last)}")

# ── HOUR HEATMAP ─────────────────────────────────────────────────────────────
section("⏰  HOUR-OF-DAY PATTERN (IST, last 30d)")
rows = results["hour_heatmap"]
if isinstance(rows, list) and rows:
    mx = max(r[1] for r in rows)
    for hr, cnt in rows:
        print(f"  {int(hr):02d}:00  {bar(cnt, mx, 35)}  {cnt}")

# ── DAY OF WEEK ───────────────────────────────────────────────────────────────
section("📅  DAY-OF-WEEK PATTERN (IST, last 30d)")
days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
rows = results["dow_pattern"]
if isinstance(rows, list) and rows:
    mx = max(r[1] for r in rows)
    for dow, cnt in rows:
        print(f"  {days[int(dow)]}  {bar(cnt, mx, 35)}  {cnt}")

# ── D1 RETENTION ─────────────────────────────────────────────────────────────
section("🔁  D1 RETENTION TREND (last 14 cohort days)")
rows = results["d1_retention_trend"]
if isinstance(rows, list) and rows:
    print(f"  {'Cohort day':<14}  {'Size':>5}  {'Retained':>9}  {'D1 %':>6}  Chart")
    print("  " + "─"*55)
    for cohort, size, retained, pct_ in rows:
        label = ist(cohort).strftime("%d %b")
        colour = "🟩" if pct_>=50 else ("🟨" if pct_>=25 else "🟥")
        print(f"  {label:<14}  {size:>5}  {retained:>9}  {pct_:>5}%  {colour} {bar(pct_,100,18)}")

# ── CHURN ─────────────────────────────────────────────────────────────────────
section("📉  CHURN TREND (weekly)")
rows = results["churn_trend"]
if isinstance(rows, list) and rows:
    mx = max(r[1] for r in rows) if rows else 1
    for week, churned in rows:
        label = ist(week).strftime("w/%d %b")
        print(f"  {label}  {bar(churned, mx, 25)}  {churned}")

# ── FUNNEL ────────────────────────────────────────────────────────────────────
section("🏁  ALL-TIME FUNNEL")
rows = results["funnel"]
if isinstance(rows, list) and rows:
    install, analysis, cost, dryrun = rows[0]
    for label, cnt in [
        ("Installed (extension/activated)", install),
        ("Ran analysis (local_analysis/complete)", analysis),
        ("Analyzed cost (command/analyze_cost)", cost),
        ("Dry run success (dry_run/success)", dryrun),
    ]:
        print(f"  {label:<45}  {bar(cnt, install or 1, 20)}  {cnt}  ({pct(cnt, install)})")

# ── MCP ───────────────────────────────────────────────────────────────────────
section("🤖  MCP / JOB PLAN ANALYSIS")
rows = results["mcp_usage"]
if isinstance(rows, list) and rows:
    print(f"  {'Event':<40}  {'Events':>7}  {'Users':>6}  {'7d':>4}  Last seen")
    print("  " + "─"*70)
    for name, events, users, l7, last in rows:
        ename = name.replace("CatalystOps.catalystops/", "")
        print(f"  {ename:<40}  {events:>7}  {users:>6}  {l7:>4}  {istfmt(last)}")
else:
    print("  No MCP/job events found.")

# ── ERRORS ────────────────────────────────────────────────────────────────────
section("🐛  ERROR TREND (last 14d)")
rows = results["error_trend"]
if isinstance(rows, list) and rows:
    print(f"  {'Day':<10}  {'DAU':>5}  {'Errors':>7}  {'Err/DAU':>8}")
    print("  " + "─"*35)
    for day, dau_, errs in rows:
        label = ist(day).strftime("%d %b")
        ratio = f"{100*errs//dau_}%" if dau_ else "—"
        print(f"  {label:<10}  {dau_:>5}  {errs:>7}  {ratio:>8}")

print("\n✅  Dashboard complete.\n")
PYEOF
