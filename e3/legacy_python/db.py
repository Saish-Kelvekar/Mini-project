"""
db.py - Backward compatibility shim for legacy imports.
Re-exports get_connection, get_settings, and repositories from the db package.
"""

from db.connection import get_connection, get_settings, get_db_connection, init_pool, close_pool
from db.exceptions import DatabaseError, ConflictError, ValidationError, NotFoundError

__all__ = [
    "get_connection",
    "get_settings",
    "get_db_connection",
    "init_pool",
    "close_pool",
    "DatabaseError",
    "ConflictError",
    "ValidationError",
    "NotFoundError",
]
