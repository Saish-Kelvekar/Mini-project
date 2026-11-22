"""
setup_db.py - creates database and runs schema.sql.
Includes safety guards so running normally does NOT wipe existing data.
Wiping data requires the explicit --reset flag.

Usage:
    python setup_db.py             # Create DB (if missing) & apply new tables (Safe, no data loss)
    python setup_db.py --sample    # ...and also load sample_data.sql
    python setup_db.py --reset     # DANGER: Wipe all tables & recreate schema from scratch
    python setup_db.py --yes       # Skip prompt confirmation
"""

import argparse
import os
import sys

import psycopg2
from psycopg2 import sql

from db.connection import get_connection, get_settings

HERE = os.path.dirname(os.path.abspath(__file__))


def read_sql_file(filename):
    """
    Read a .sql file and drop psql-specific backslash commands (e.g. \\set, \\pset).
    """
    path = os.path.join(HERE, filename)
    with open(path, encoding="utf-8") as f:
        lines = [ln for ln in f.read().splitlines() if not ln.lstrip().startswith("\\")]
    return "\n".join(lines)


def create_database_if_missing(dbname):
    """Connect to the built-in 'postgres' database and create project DB if needed."""
    try:
        conn = get_connection(dbname="postgres", autocommit=True)
        cur = conn.cursor()
        cur.execute("SELECT 1 FROM pg_database WHERE datname = %s;", (dbname,))
        if cur.fetchone():
            print(f"[OK] Database '{dbname}' exists.")
        else:
            cur.execute(sql.SQL("CREATE DATABASE {};").format(sql.Identifier(dbname)))
            print(f"[OK] Created database '{dbname}'.")
        cur.close()
        conn.close()
    except psycopg2.Error as err:
        print(f"[NOTE] Connecting to 'postgres' DB: {err}")


def run_script(conn, filename):
    """Execute a .sql file against an open database connection."""
    cur = conn.cursor()
    content = read_sql_file(filename)
    try:
        cur.execute(content)
        if cur.description:
            for row in cur.fetchall():
                print("   ", *row)
        print(f"[OK] Successfully executed {filename}.")
    finally:
        cur.close()


def main():
    parser = argparse.ArgumentParser(description="Initialize or update the database schema.")
    parser.add_argument("--sample", action="store_true", help="Load sample seed data")
    parser.add_argument("--reset", action="store_true", help="DROP all existing tables and recreate")
    parser.add_argument("--yes", action="store_true", help="Bypass confirmation prompts")
    parser.add_argument("--dbname", type=str, default=None, help="Override database name")
    args = parser.parse_args()

    settings = get_settings(args.dbname)
    dbname = settings["dbname"]

    if args.reset and not args.yes:
        confirm = input(
            f"WARNING: --reset will DELETE ALL TABLES AND DATA in '{dbname}'. Continue? [y/N]: "
        )
        if confirm.strip().lower() != "y":
            print("Cancelled.")
            return

    try:
        create_database_if_missing(dbname)
        conn = get_connection(dbname=dbname, autocommit=True)

        if args.reset:
            print(f"Resetting schema in '{dbname}'...")
            run_script(conn, "schema_reset.sql")

        print(f"Applying schema to '{dbname}'...")
        run_script(conn, "schema.sql")

        if args.sample:
            print(f"Loading sample data into '{dbname}'...")
            run_script(conn, "sample_data.sql")

        conn.close()
        print("\nSetup completed successfully.")
        print("Verify with: python test_connection.py")
    except psycopg2.Error as err:
        print(f"\n[FAILED]: {err}")
        sys.exit(1)


if __name__ == "__main__":
    main()
