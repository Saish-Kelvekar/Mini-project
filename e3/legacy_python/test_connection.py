"""
test_connection.py - Verifies database connectivity, tables, views, and row counts.
Run: python test_connection.py
"""

import sys
import psycopg2
from db.connection import get_connection, get_settings

EXPECTED_TABLES = [
    "allocation", "app_user", "audit_log", "conflict", "event",
    "event_judge", "event_requirement", "fest_config", "judge_availability",
    "registration", "resource", "schedule_slot", "score",
    "timetable_version", "venue_availability"
]

EXPECTED_VIEWS = [
    "v_capacity_violations", "v_event_judge_shortfall",
    "v_judge_conflicts", "v_participant_conflicts"
]


def main():
    settings = get_settings()
    print(f"Connecting to '{settings['dbname']}' on "
          f"{settings['host']}:{settings['port']} as {settings['user']} ...")

    try:
        conn = get_connection()
    except psycopg2.OperationalError as err:
        print("\n[CONNECTION FAILED]")
        print(str(err).strip())
        print("\nCommon troubleshooting steps:")
        print(" 1. Ensure PostgreSQL service is running in Windows Services.")
        print(" 2. Confirm your password in e3/.env.")
        print(" 3. Run: python setup_db.py --sample")
        sys.exit(1)

    cur = conn.cursor()
    cur.execute("SELECT version();")
    print("Connected. Server:", cur.fetchone()["version"].split(",")[0])

    # Check tables
    cur.execute(
        "SELECT table_name FROM information_schema.tables "
        "WHERE table_schema = 'public' AND table_type = 'BASE TABLE' "
        "ORDER BY table_name;"
    )
    found_tables = [row["table_name"] for row in cur.fetchall()]
    missing_tables = [t for t in EXPECTED_TABLES if t not in found_tables]

    print(f"\nTables found: {len(found_tables)} (expected at least {len(EXPECTED_TABLES)})")
    if missing_tables:
        print("Missing tables:", ", ".join(missing_tables))
        print("Run: python setup_db.py")
        cur.close()
        conn.close()
        sys.exit(1)

    # Check views
    cur.execute(
        "SELECT table_name FROM information_schema.views "
        "WHERE table_schema = 'public' ORDER BY table_name;"
    )
    found_views = [row["table_name"] for row in cur.fetchall()]
    missing_views = [v for v in EXPECTED_VIEWS if v not in found_views]
    print(f"Views found:  {len(found_views)} (expected {len(EXPECTED_VIEWS)})")
    if missing_views:
        print("Missing views:", ", ".join(missing_views))

    print("\nRow counts across tables:")
    for table in EXPECTED_TABLES:
        cur.execute(f"SELECT count(*) AS cnt FROM {table};")
        count = cur.fetchone()["cnt"]
        print(f"  {table:<22} {count}")

    cur.close()
    conn.close()
    print("\nAll database checks passed successfully.")


if __name__ == "__main__":
    main()
